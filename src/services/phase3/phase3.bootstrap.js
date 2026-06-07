/**
 * phase3.bootstrap.js (Backend)
 * Phase 3 — WebRTC Call Engine Bootstrap
 *
 * Initializes Phase 3 infrastructure on top of Phase 1 + Phase 2.
 * Integrates with existing webSocketService without modifying it.
 *
 * Add to server.js AFTER Phase 2 block:
 *
 *   const { initPhase3 } = require('./services/phase3/phase3.bootstrap');
 *   setTimeout(() => {
 *     global.__phase3 = initPhase3(io, app, {
 *       phase1: global.__phase1,
 *       phase2: global.__phase2,
 *       wsService: require('./services/webSocketService'),
 *       logger: console,
 *     });
 *   }, 2000);
 *
 * @version 3.0.0
 * @phase 3 — WebRTC Engine
 */

'use strict';

const CallSignalingService = require('./CallSignalingService');

let _initialized = false;
let _modules     = {};

function initPhase3(io, app, options = {}) {
  if (_initialized) {
    (options.logger || console).warn('[Phase3Bootstrap] Already initialized.');
    return _modules;
  }

  const logger    = options.logger   || console;
  const wsService = options.wsService;
  const phase1    = options.phase1   || {};
  const phase2    = options.phase2   || {};

  if (!wsService) {
    logger.error('[Phase3Bootstrap] wsService required — pass it via options.wsService');
    return {};
  }

  logger.log('[Phase3Bootstrap] 🚀 Initializing Phase 3 WebRTC Call Engine…');
  const startMs = Date.now();

  // ── Call Signaling Service ────────────────────────────────────────────────

  const callSignaling = new CallSignalingService(io, wsService, { logger });
  callSignaling.attach();

  // FIX: Expose on global so src/routes/calls.js can trigger initiateCall()
  // for the HTTP-path call creation (when socket call:initiate hasn't fired yet)
  global.__CallSignalingService = callSignaling;

  // Register Express routes for scheduled calls
  if (app) {
    _registerCallRoutes(app, callSignaling, wsService, logger);
  }

  // ── Cross-module wiring ───────────────────────────────────────────────────

  // When a call is initiated, log it
  callSignaling.on('call:initiated', ({ callId, callerId, targetUserId }) => {
    phase1.monitoring?.recordMetric('call', 'initiated', 1, { callId, callerId, targetUserId });
  });

  callSignaling.on('call:accepted', ({ callId }) => {
    phase1.monitoring?.incrementCounter('call.accepted');
  });

  callSignaling.on('call:ended', ({ callId, reason }) => {
    phase1.monitoring?.recordMetric('call', 'ended', 1, { callId, reason });
  });

  // Extend monitoring snapshot with Phase 3 data
  const p1Monitoring = phase1.monitoring;
  if (p1Monitoring) {
    const origSnapshot = p1Monitoring.snapshot.bind(p1Monitoring);
    p1Monitoring.snapshot = function () {
      const snap = origSnapshot();
      snap.phase3 = { callSignaling: callSignaling.getDiagnostics() };
      return snap;
    };
  }

  // ── Store ────────────────────────────────────────────────────────────────

  _modules = { callSignaling };
  _initialized = true;

  const elapsed = Date.now() - startMs;
  logger.log(`[Phase3Bootstrap] ✅ Phase 3 initialized in ${elapsed}ms`);

  return _modules;
}

function _registerCallRoutes(app, callSignaling, wsService, logger) {
  // Initiate call via REST (for mobile deep links)
  app.post('/api/calls/initiate', async (req, res) => {
    try {
      const { targetUserId, callType } = req.body || {};
      const callerId = req.user?.id || req.body?.callerId;
      if (!callerId || !targetUserId) {
        return res.status(400).json({ error: 'callerId and targetUserId required' });
      }
      const callId = await callSignaling.initiateCall(callerId, targetUserId, { callType });
      res.json({ callId, success: true });
    } catch (err) {
      logger.warn('[Phase3] POST /api/calls/initiate error:', err.message);
      res.status(500).json({ error: 'Call initiation failed' });
    }
  });

  // Schedule a call
  app.post('/api/calls/schedule', (req, res) => {
    try {
      const hostId = req.user?.id || req.body?.hostId;
      if (!hostId) return res.status(401).json({ error: 'Authentication required' });
      const entry = callSignaling.scheduleCall({ ...req.body, hostId });
      res.json({ scheduleId: entry.id, success: true, schedule: entry });
    } catch (err) {
      res.status(500).json({ error: 'Schedule failed' });
    }
  });

  // Get scheduled calls for user
  app.get('/api/calls/scheduled', (req, res) => {
    const userId = req.user?.id || req.query.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    res.json({ scheduled: callSignaling.getScheduled(userId) });
  });

  // Cancel scheduled call
  app.delete('/api/calls/scheduled/:scheduleId', (req, res) => {
    const ok = callSignaling.cancelScheduled(req.params.scheduleId);
    res.json({ success: ok });
  });

  logger.log('[Phase3Bootstrap] Call REST routes registered: /api/calls/*');
}

function getModules() {
  if (!_initialized) throw new Error('[Phase3Bootstrap] Not initialized.');
  return _modules;
}

module.exports = { initPhase3, getModules };
