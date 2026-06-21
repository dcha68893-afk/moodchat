/**
 * phase2.bootstrap.js (Backend)
 * Phase 2 — Hybrid Transport Engine Bootstrap
 *
 * Single call to initialize all Phase 2 infrastructure.
 * Called by server.js AFTER Phase 1 and existing setup.
 *
 * Usage (in server.js, after Phase 1 block):
 *   const { initPhase2 } = require('./phase2.bootstrap');
 *   setTimeout(() => {
 *     global.__phase2 = initPhase2(io, app, { phase1: global.__phase1, logger: console });
 *   }, 1500);
 *
 * @version 2.0.0
 * @phase 2 — Hybrid Transport
 */

'use strict';

const { HybridTransportManager }    = require('./HybridTransportManager');
const { ReliableDeliveryService }   = require('./ReliableDeliveryService');
const LANDiscoveryService           = require('./LANDiscoveryService');
const MeshRelayService              = require('./MeshRelayService');
const ConflictResolutionEngine      = require('./ConflictResolutionEngine');
const CacheReconciliationEngine     = require('./CacheReconciliationEngine');

let _initialized = false;
let _modules     = {};

/**
 * Initialize all Phase 2 infrastructure.
 *
 * @param {SocketIO.Server} io
 * @param {Express.App}     app
 * @param {Object}          options  { phase1, logger }
 * @returns {Object}  modules
 */
function initPhase2(io, app, options = {}) {
  if (_initialized) {
    (options.logger || console).warn('[Phase2Bootstrap] Already initialized — skipping.');
    return _modules;
  }

  const logger = options.logger || console;
  const phase1 = options.phase1 || {};
  logger.log('[Phase2Bootstrap] 🚀 Initializing Phase 2 Hybrid Transport Engine…');
  const startMs = Date.now();

  // ── 1. Hybrid Transport Manager ─────────────────────────────────────────────
  const transport = new HybridTransportManager(io, { logger });
  transport.attach();

  // ── 2. Reliable Delivery Service ────────────────────────────────────────────
  const delivery = new ReliableDeliveryService(io, { logger });
  delivery.attach();

  // Register delta sync route if auth middleware available
  // FIX (forensic audit 2026-06-21): src/middleware/auth.js exports an OBJECT
  // ({ authenticateToken, authenticate, ... }), not a bare function. The
  // previous code did `const authenticateToken = require(...)`, which grabbed
  // the whole exports object instead of the function inside it. Express then
  // threw on registration (non-function middleware), which was silently
  // swallowed by the catch block below, leaving GET /api/messages/delta
  // running with NO auth guard in production.
  try {
    const { authenticateToken } = require('../../middleware/auth');
    if (typeof authenticateToken !== 'function') {
      throw new Error('authenticateToken export is not a function');
    }
    delivery.registerDeltaSyncRoute(app, authenticateToken);
    logger.log('[Phase2Bootstrap] ✅ Delta sync route registered WITH auth guard');
  } catch (err) {
    // auth middleware genuinely unavailable — register without auth guard
    logger.warn('[Phase2Bootstrap] Could not load auth middleware — delta sync route unguarded:', err.message);
    delivery.registerDeltaSyncRoute(app, (req, res, next) => next());
  }

  // ── 3. LAN Discovery Service ─────────────────────────────────────────────────
  const lanDiscovery = new LANDiscoveryService(io, { logger });
  lanDiscovery.attach();

  // ── 4. Mesh Relay Service ────────────────────────────────────────────────────
  const meshRelay = new MeshRelayService(io, { logger });
  meshRelay.attach();

  // ── 5. Conflict Resolution Engine ────────────────────────────────────────────
  const conflict = new ConflictResolutionEngine({ logger });
  conflict.attachToIO(io);

  // Register Lamport stamping middleware on app
  if (app) {
    app.use('/api', conflict.stampMiddleware());
  }

  // ── 6. Cache Reconciliation Engine ──────────────────────────────────────────
  const cacheReconcile = new CacheReconciliationEngine(io, { logger });
  cacheReconcile.attach();

  if (app) {
    cacheReconcile.registerValidationRoute(app);
  }

  // ── Cross-module wiring ──────────────────────────────────────────────────────

  // When entity deleted → cache reconciliation broadcasts purge
  const p1Persistence = phase1.persistence;
  if (p1Persistence) {
    p1Persistence.on('entity:deleted', ({ type, id, meta }) => {
      const chatId   = meta?.chatId   || meta?.conversationId || null;
      const deletedBy = meta?.deletedBy || null;
      cacheReconcile.onDeleted(type, id, chatId, deletedBy);
      phase1.cache?.markDeleted(type, id);
    });
  }

  // When socket reconnects → flush delivery queue
  const p1Realtime = phase1.realtime;
  if (p1Realtime) {
    p1Realtime.on('socket:reconnected', ({ socketId, userId }) => {
      if (userId) {
        delivery.flushQueue(userId).catch(err => {
          logger.warn('[Phase2Bootstrap] Flush error:', err.message);
        });
      }
    });
    p1Realtime.on('socket:connected', ({ socketId, userId }) => {
      if (userId) {
        delivery.flushQueue(userId).catch(err => {
          logger.warn('[Phase2Bootstrap] Flush error:', err.message);
        });
      }
    });
  }

  // When transport falls back to OFFLINE → queue via delivery service
  transport.on('delivery:queued', ({ targetUserId, event }) => {
    phase1.monitoring?.recordMetric('delivery', 'queued', 1, { targetUserId, event });
  });

  transport.on('delivery:internet', () => {
    phase1.monitoring?.incrementCounter('delivery.internet');
  });

  transport.on('delivery:lan', () => {
    phase1.monitoring?.incrementCounter('delivery.lan');
  });

  transport.on('delivery:mesh', () => {
    phase1.monitoring?.incrementCounter('delivery.mesh');
  });

  // Mesh relay performance feedback → Phase 1 monitoring
  meshRelay.on('mesh:packet_forwarded', () => {
    phase1.monitoring?.incrementCounter('mesh.packets_forwarded');
  });

  // LAN peer events → monitoring
  lanDiscovery.on('lan:peer_joined', ({ userId, subnetKey }) => {
    phase1.monitoring?.recordMetric('lan', 'peer_joined', 1, { userId, subnetKey });
  });

  lanDiscovery.on('lan:ap_isolated', ({ subnetKey }) => {
    phase1.monitoring?.incrementCounter('lan.ap_isolation_detected');
  });

  // Extend monitoring snapshot with Phase 2 data
  const p1Monitoring = phase1.monitoring;
  if (p1Monitoring) {
    const origSnapshot = p1Monitoring.snapshot.bind(p1Monitoring);
    p1Monitoring.snapshot = function () {
      const snap   = origSnapshot();
      snap.phase2  = {
        transport:       transport.getDiagnostics(),
        delivery:        delivery.getDiagnostics(),
        lanDiscovery:    lanDiscovery.getDiagnostics(),
        meshRelay:       meshRelay.getDiagnostics(),
        conflict:        conflict.getDiagnostics(),
        cacheReconcile:  cacheReconcile.getDiagnostics(),
      };
      return snap;
    };
  }

  // ── Store modules ────────────────────────────────────────────────────────────

  _modules = { transport, delivery, lanDiscovery, meshRelay, conflict, cacheReconcile };
  _initialized = true;

  const elapsed = Date.now() - startMs;
  logger.log(`[Phase2Bootstrap] ✅ Phase 2 initialized in ${elapsed}ms`);

  return _modules;
}

function getModules() {
  if (!_initialized) throw new Error('[Phase2Bootstrap] Not initialized. Call initPhase2() first.');
  return _modules;
}

module.exports = { initPhase2, getModules };
