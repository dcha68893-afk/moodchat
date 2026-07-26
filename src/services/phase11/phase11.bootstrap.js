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
      // Route through URO (which now always tries direct Socket.IO first for
      // time-sensitive events like calls and messages)
      // FIX (SILENT-ERROR): was `.catch(() => null)` — identical to the Phase10
      // wrapper's bug. A real throw inside uro.deliver was indistinguishable
      // from a normal "not delivered" result. Now logged.
      const result = await uro.deliver(String(userId), event, data).catch((err) => {
        console.error(`[Phase11] uro.deliver threw for uid=${userId} event=${event}:`, err?.message || err);
        return null;
      });
      if (result?.ok) return true;

      // Fallback 1: original sendToUser (pre-Phase11 implementation)
      if (_orig) {
        try {
          const origResult = await _orig(userId, event, data);
          if (origResult) return true;
        } catch (err) {
          console.error(`[Phase11] fallback _orig(sendToUser) threw for uid=${userId} event=${event}:`, err?.message || err);
        }
      }

      // Fallback 2: direct io emit as last resort
      try {
        const _io = global.__io || uro.io;
        if (_io) {
          const uid = String(userId);
          _io.to(`user:${uid}`).emit(event, data);
          _io.to(`user_${uid}`).emit(event, data);
          return true;
        }
      } catch (err) {
        console.error(`[Phase11] fallback direct io.emit threw for uid=${userId} event=${event}:`, err?.message || err);
      }

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
