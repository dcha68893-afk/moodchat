/**
 * phase1.bootstrap.js (Backend)
 * Phase 1 — Foundation Stabilization Bootstrap
 *
 * Single integration point. Call initPhase1(io, app, options) once,
 * AFTER your existing server setup is complete.
 *
 * Initializes and wires:
 *  1. NetworkIntelligenceManager
 *  2. RealtimeStabilizationLayer
 *  3. PresenceEngineFoundation
 *  4. OperationQueueManager
 *  5. CacheCoordinator
 *  6. PersistenceCoordinator
 *  7. IdentityFoundationLayer
 *  8. MonitoringFoundation
 *
 * Usage in server.js (NON-DESTRUCTIVE — add after existing setup):
 *
 *   const { initPhase1 } = require('./core/phase1.bootstrap');
 *   initPhase1(io, app, {
 *     logger: console,
 *     adminToken: process.env.INTERNAL_DIAG_TOKEN,
 *   });
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const NetworkIntelligenceManager  = require('./network/NetworkIntelligenceManager');
const RealtimeStabilizationLayer  = require('./realtime/RealtimeStabilizationLayer');
const { PresenceEngineFoundation } = require('./presence/PresenceEngineFoundation');
const { OperationQueueManager }   = require('./queue/QueueFoundationLayer');
const CacheCoordinator            = require('./cache/CacheFoundationLayer');
const PersistenceCoordinator      = require('./persistence/PersistenceStabilizationLayer');
const IdentityFoundationLayer     = require('./identity/IdentityFoundationLayer');
const MonitoringFoundation        = require('./monitoring/MonitoringFoundation');

let _initialized = false;
let _modules     = {};

/**
 * Initialize all Phase 1 infrastructure.
 * Returns a modules object for use by existing server code.
 *
 * @param {SocketIO.Server} io      - Existing Socket.IO server instance
 * @param {Express.App}     app     - Existing Express app (for admin route)
 * @param {Object}          options
 */
function initPhase1(io, app, options = {}) {
  if (_initialized) {
    console.warn('[Phase1Bootstrap] Already initialized — skipping.');
    return _modules;
  }

  const logger = options.logger || console;
  logger.log('[Phase1Bootstrap] 🚀 Initializing Phase 1 Foundation…');
  const startMs = Date.now();

  // ── 1. Network Intelligence ─────────────────────────────────────────────────
  const network = new NetworkIntelligenceManager({ logger });
  network.start();

  // ── 2. Realtime Stabilization ───────────────────────────────────────────────
  const realtime = new RealtimeStabilizationLayer(io, { logger });
  realtime.attach();

  // ── 3. Presence Engine ──────────────────────────────────────────────────────
  const presence = new PresenceEngineFoundation(io, { logger });
  presence.attach();

  // ── 4. Operation Queue ──────────────────────────────────────────────────────
  const queue = new OperationQueueManager();
  queue.start();

  // ── 5. Cache ────────────────────────────────────────────────────────────────
  const cache = new CacheCoordinator({
    maxEntries:   options.cacheMaxEntries   || 5000,
    defaultTtlMs: options.cacheDefaultTtlMs || 5 * 60 * 1000,
  });
  cache.start();

  // ── 6. Persistence ──────────────────────────────────────────────────────────
  const persistence = new PersistenceCoordinator({ logger });

  // ── 7. Identity ─────────────────────────────────────────────────────────────
  const identity = new IdentityFoundationLayer({ logger });
  identity.attachToIO(io);

  // ── 8. Monitoring ───────────────────────────────────────────────────────────
  const monitoring = new MonitoringFoundation({ logger });
  monitoring
    .attachModules({ network, realtime, presence, queue, cache, identity })
    .attachToIO(io)
    .start();

  if (app && options.enableAdminRoute !== false) {
    monitoring.registerAdminRoute(app, {
      path:  options.adminPath  || '/internal/diagnostics',
      token: options.adminToken || process.env.INTERNAL_DIAG_TOKEN,
    });
  }

  // ── Cross-module wiring ─────────────────────────────────────────────────────

  // On socket reconnect → retry failed queue ops for that user
  realtime.on('socket:reconnected', ({ socketId, userId }) => {
    if (userId) {
      const retried = queue.retryForUser(userId);
      if (retried > 0) logger.log(`[Phase1Bootstrap] Retrying ${retried} ops for user ${userId}`);
    }
    network.recordReconnect(socketId);
    monitoring.recordReconnect(socketId, userId);
  });

  realtime.on('socket:connected', ({ socketId, userId }) => {
    network.registerSocket(socketId);
  });

  realtime.on('socket:disconnected', ({ socketId, userId, reason }) => {
    network.unregisterSocket(socketId);
  });

  // Invalidate cache on entity deletions
  persistence.on('entity:deleted', ({ type, id }) => {
    cache.markDeleted(type, id);
  });

  // ── Store modules ───────────────────────────────────────────────────────────

  _modules = {
    network,
    realtime,
    presence,
    queue,
    cache,
    persistence,
    identity,
    monitoring,
  };

  _initialized = true;

  const elapsed = Date.now() - startMs;
  logger.log(`[Phase1Bootstrap] ✅ Phase 1 initialized in ${elapsed}ms`);

  return _modules;
}

/**
 * Get the initialized modules object.
 * Throws if initPhase1 has not been called.
 */
function getModules() {
  if (!_initialized) throw new Error('[Phase1Bootstrap] Not initialized. Call initPhase1() first.');
  return _modules;
}

module.exports = { initPhase1, getModules };
