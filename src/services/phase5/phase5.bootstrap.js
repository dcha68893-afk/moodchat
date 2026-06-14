/**
 * phase5.bootstrap.js (Backend)
 * Phase 5 — Production Reliability Bootstrap
 *
 * Final phase initialization. Add to server.js AFTER Phase 4 block:
 *
 *   const { initPhase5 } = require('./phase5.bootstrap');
 *   setTimeout(() => {
 *     global.__phase5 = initPhase5(io, app, {
 *       phase1: global.__phase1, phase2: global.__phase2,
 *       phase3: global.__phase3, phase4: global.__phase4,
 *       wsService: require('../webSocketService'),
 *       logger: console,
 *     });
 *   }, 4000);
 *
 * @version 5.0.0
 */

'use strict';

const ProductionReliabilityService = require('./ProductionReliabilityService');

let _initialized = false;
let _modules     = {};

function initPhase5(io, app, options = {}) {
  if (_initialized) {
    (options.logger || console).warn('[Phase5Bootstrap] Already initialized.');
    return _modules;
  }

  const logger    = options.logger   || console;
  const wsService = options.wsService;
  const phase1    = options.phase1   || {};

  if (!wsService) {
    logger.error('[Phase5Bootstrap] wsService required');
    return {};
  }

  logger.log('[Phase5Bootstrap] 🚀 Initializing Phase 5 Production Reliability…');
  const startMs = Date.now();

  // ── Production Reliability Service ────────────────────────────────────────
  const reliability = new ProductionReliabilityService(io, wsService, { logger });
  reliability.attach();

  // ── Register admin routes ──────────────────────────────────────────────────
  if (app) _registerRoutes(app, reliability, phase1, logger);

  // ── Cross-module wiring ───────────────────────────────────────────────────

  // When Phase 2 delivery queues a message → also queue server-side
  const p2delivery = options.phase2?.delivery;
  if (p2delivery) {
    p2delivery.on('delivery:queued', ({ targetUserId, event }) => {
      reliability.log('delivery', 'queued_offline', { userId: String(targetUserId || ''), event });
    });
  }

  // Extend monitoring with Phase 5 data
  if (phase1.monitoring) {
    const orig = phase1.monitoring.snapshot.bind(phase1.monitoring);
    phase1.monitoring.snapshot = function () {
      const snap = orig();
      snap.phase5 = { reliability: reliability.getDiagnostics() };
      return snap;
    };
  }

  reliability.on('device:registered', ({ deviceId, userId }) => {
    phase1.monitoring?.recordMetric('security', 'device_registered', 1, { userId });
  });

  _modules     = { reliability };
  _initialized = true;

  logger.log(`[Phase5Bootstrap] ✅ Phase 5 initialized in ${Date.now() - startMs}ms`);
  return _modules;
}

function _registerRoutes(app, reliability, phase1, logger) {
  // Device management
  app.post('/api/devices/revoke', (req, res) => {
    const { deviceId } = req.body || {};
    const userId       = req.user?.id;
    if (!deviceId || !userId) return res.status(400).json({ error: 'deviceId required' });
    const ok = reliability.revokeDevice(deviceId);
    res.json({ success: ok, deviceId });
  });

  app.get('/api/devices', (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Auth required' });
    const devices = reliability._devices.getByUser(userId).map(d => ({
      deviceId:    d.deviceId,
      registeredAt: d.registeredAt,
      lastSeen:    d.lastSeen,
      trusted:     d.trusted,
      fingerprint: d.fingerprint?.slice(0, 8) + '…',
    }));
    res.json({ devices });
  });

  // Telemetry (internal only — requires internal token)
  app.get('/internal/telemetry', (req, res) => {
    const token = req.headers['x-internal-token'] || req.query.token;
    if (process.env.INTERNAL_DIAG_TOKEN && token !== process.env.INTERNAL_DIAG_TOKEN) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(reliability.getDiagnostics());
  });

  logger.log('[Phase5Bootstrap] Routes: /api/devices, /api/devices/revoke, /internal/telemetry');
}

function getModules() {
  if (!_initialized) throw new Error('[Phase5Bootstrap] Not initialized.');
  return _modules;
}

module.exports = { initPhase5, getModules };
