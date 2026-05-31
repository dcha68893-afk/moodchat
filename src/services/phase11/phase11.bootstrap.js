'use strict';
/**
 * phase11.bootstrap.js — Backend Phase 11
 * Activates UnifiedRuntimeOrchestrator and wires it into all existing services.
 */

let _initialized = false;

function initPhase11(io, app, options = {}) {
  if (_initialized) return;
  _initialized = true;

  const logger = options.logger || console;
  logger.log('[Phase11] 🚀 Starting UnifiedRuntimeOrchestrator');

  const { getURO } = require('./UnifiedRuntimeOrchestrator');
  const uro = getURO(io, { logger });
  uro.start();
  global.__URO = uro;

  // Wire URO into webSocketService sendToUser
  _wireWebSocketService(uro, logger);

  // Wire URO into callService delivery
  _wireCallService(uro, logger);

  // Register /api/cor/diagnostics endpoint
  if (app) {
    app.get('/api/cor/diagnostics', (req, res) => {
      res.json({
        ok        : true,
        phase     : 11,
        uro       : uro.getDiagnostics(),
        phase10   : global.__phase10 ? {
          transport : global.__HybridTransportRuntime?.getDiagnostics?.(),
          entities  : global.__MessageEntityStore?.getDiagnostics?.(),
          hydration : global.__HydrationEngine?.getDiagnostics?.(),
        } : null,
        timestamp : Date.now(),
      });
    });
  }

  logger.log('[Phase11] ✅ UnifiedRuntimeOrchestrator active');
  return { uro };
}

function _wireWebSocketService(uro, logger) {
  try {
    const ws = require('../webSocketService');
    const _orig = ws.sendToUser?.bind(ws);

    ws.sendToUser = async function(userId, event, data = {}) {
      // Route through URO for intelligent transport selection
      const result = await uro.deliver(String(userId), event, data).catch(() => null);
      if (result?.ok || result?.queued) return true;
      // Fallback to original
      if (_orig) return _orig(userId, event, data);
      return false;
    };

    logger.log('[Phase11] ✅ webSocketService.sendToUser → URO');
  } catch (err) {
    logger.warn('[Phase11] Could not wire webSocketService:', err.message);
  }
}

function _wireCallService(uro, logger) {
  try {
    const callSvc = require('../callService');
    // Ensure call events use URO delivery
    if (callSvc._uro !== uro) {
      callSvc._uro = uro;
      logger.log('[Phase11] ✅ callService → URO');
    }
  } catch (_) {}
}

module.exports = { initPhase11 };
