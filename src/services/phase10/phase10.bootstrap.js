'use strict';
/**
 * phase10.bootstrap.js — FULL PRODUCTION HARDENING
 *
 * Activates:
 *  1. HybridTransportRuntime — canonical delivery authority
 *  2. MessageEntityStore — no more disappearing messages
 *  3. AuthoritativeHydrationEngine — no more stale cache resurrection
 *  4. Wires everything into webSocketService, messageService, LANDiscovery, MeshRelay
 *
 * Called from server.js after all phases 1-6.
 */

let _initialized = false;
let _modules     = {};

function initPhase10(io, app, options = {}) {
  if (_initialized) return _modules;
  _initialized = true;

  const logger = options.logger || console;
  logger.log('[Phase10] 🚀 Production Hardening — activating all transport systems');

  // ── 1. Hybrid Transport Runtime ──────────────────────────────────────────
  const { HybridTransportRuntime } = require('./HybridTransportRuntime');
  const runtime = new HybridTransportRuntime(io, { logger });

  // Inject LAN and Mesh from phase2
  try {
    const p2 = options.phase2 || global.__phase2 || {};
    if (p2.lanDiscovery) runtime.setLANService(p2.lanDiscovery);
    if (p2.meshRelay)    runtime.setMeshRelay(p2.meshRelay);
  } catch (_) {}

  runtime.start();
  global.__HybridTransportRuntime = runtime;

  // ── 2. Message Entity Store ──────────────────────────────────────────────
  const { getMessageEntityStore } = require('./MessageEntityStore');
  const entityStore = getMessageEntityStore({ logger });
  global.__MessageEntityStore = entityStore;

  // Emit patches as socket events so clients get incremental updates
  entityStore.on('patch', (patch) => {
    try {
      // Only emit delete patches via socket (create/update come from message service)
      if (patch.op === 'delete') {
        runtime.broadcastToRoom(`chat:${patch.chatId}`, 'message:patch', patch);
        // Also emit entity:deleted for the deletion registry
        runtime.broadcastToRoom(`chat:${patch.chatId}`, 'entity:deleted', {
          entityType: 'message', entityId: patch.id, chatId: patch.chatId,
          reason: 'deleted', ts: patch.ts
        });
      }
    } catch (_) {}
  });

  // ── 3. Authoritative Hydration Engine ───────────────────────────────────
  const { getHydrationEngine } = require('./AuthoritativeHydrationEngine');
  const hydration = getHydrationEngine({ logger });
  global.__HydrationEngine = hydration;

  // Register deletion REST endpoints
  try {
    const { authenticateToken } = require('../../middleware/auth');
    hydration.registerRoutes(app, authenticateToken);
  } catch (_) {
    hydration.registerRoutes(app, (req, res, next) => next());
  }

  // ── 4. Wire into webSocketService ────────────────────────────────────────
  _wireWebSocketService(runtime, entityStore, hydration, logger);

  // ── 5. Wire into messageService ──────────────────────────────────────────
  _wireMessageService(entityStore, hydration, runtime, logger);

  // ── 6. Transport Debug Dashboard ─────────────────────────────────────────
  _registerDashboard(app, runtime, entityStore, hydration, options);

  // ── 7. Reconnect flush: deliver queued messages when user reconnects ──────
  if (io) {
    io.on('connection', (socket) => {
      const uid = socket._authenticatedUserId;
      if (uid) {
        // Already handled in runtime._attachSocketEvents, but also emit count
        const pending = runtime.offline.pendingCount(String(uid));
        if (pending > 0) {
          socket.emit('offline:queue_flushed', { pending });
        }
      }
    });
  }

  _modules = { runtime, entityStore, hydration };
  logger.log('[Phase10] ✅ All production hardening systems active');
  return _modules;
}

// ── Wire webSocketService to use HybridTransportRuntime for all delivery ──
function _wireWebSocketService(runtime, entityStore, hydration, logger) {
  try {
    const wsService = require('../webSocketService');

    // Override sendToUser to route through HybridTransportRuntime
    const _origSendToUser = wsService.sendToUser?.bind(wsService);
    wsService.sendToUser = async function(userId, event, data) {
      // Try runtime first (handles LAN + offline queue)
      const result = await runtime.deliver(userId, event, data).catch(() => null);
      if (result?.ok) return true;
      // Fallback to original (pure Socket.IO)
      if (_origSendToUser) return _origSendToUser(userId, event, data);
      return false;
    };

    // Intercept message deletion to record tombstones
    const _origBroadcast = wsService.broadcastToChat?.bind(wsService);
    if (_origBroadcast) {
      wsService.broadcastToChat = function(chatId, event, data, excludeUserId) {
        if (event === 'message:deleted' || event === 'MESSAGE_DELETED') {
          const msgId = data?.messageId || data?.id;
          if (msgId) {
            entityStore.recordDelete(msgId, chatId, 'deleted');
            hydration.recordDeletion('message', msgId, chatId, 'deleted');
          }
        }
        return _origBroadcast(chatId, event, data, excludeUserId);
      };
    }

    logger.log('[Phase10] ✅ webSocketService wired to HybridTransportRuntime');
  } catch (err) {
    logger.warn('[Phase10] Could not wire webSocketService:', err.message);
  }
}

// ── Wire messageService to record entity patches ──────────────────────────
function _wireMessageService(entityStore, hydration, runtime, logger) {
  try {
    const msgService = require('../messageService');

    const _origCreate = msgService.createMessage?.bind(msgService);
    if (_origCreate) {
      msgService.createMessage = async function(data) {
        const message = await _origCreate(data);
        if (message?.id) {
          // Record in entity store for client patch delivery
          const patch = entityStore.recordCreate(message);
          if (patch) {
            hydration.recordUpdate('message', message.id);
          }
        }
        return message;
      };
    }

    logger.log('[Phase10] ✅ messageService wired to MessageEntityStore');
  } catch (err) {
    logger.warn('[Phase10] Could not wire messageService:', err.message);
  }
}

// ── Transport Debug Dashboard ─────────────────────────────────────────────
function _registerDashboard(app, runtime, entityStore, hydration, options) {
  if (!app) return;
  const guard = (req, res, next) => {
    // Only allow in dev or with a debug key
    if (process.env.NODE_ENV !== 'production' || req.query.key === process.env.DEBUG_KEY) {
      return next();
    }
    res.status(403).json({ error: 'forbidden' });
  };

  app.get('/api/admin/transport', guard, (req, res) => {
    res.json({
      transport  : runtime.getDiagnostics(),
      entityStore: entityStore.getDiagnostics(),
      hydration  : hydration.getDiagnostics(),
      timestamp  : Date.now(),
    });
  });

  app.get('/api/admin/health', (req, res) => {
    res.json({ ok: true, phase10: true, timestamp: Date.now() });
  });
}

module.exports = { initPhase10 };
