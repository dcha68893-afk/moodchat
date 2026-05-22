/**
 * CacheReconciliationEngine.js (Backend)
 * Phase 2 — Cache Reconciliation
 *
 * Prevents deleted messages from returning via:
 *  - Versioned cache invalidation tokens
 *  - Sync checkpoints per user/chat
 *  - Incremental hydration control
 *  - Stale protection via server-issued cache tokens
 *
 * @version 2.0.0
 * @phase 2 — Cache Reconciliation
 */

'use strict';

const EventEmitter = require('events');
const crypto       = require('crypto');

// ─── CacheTokenManager ───────────────────────────────────────────────────────

class CacheTokenManager {
  constructor() {
    // chatId/userId -> { token, version, issuedAt }
    this._tokens = new Map();
  }

  issue(scope) {
    const token   = crypto.randomBytes(8).toString('hex');
    const version = (this._tokens.get(scope)?.version || 0) + 1;
    const entry   = { token, version, issuedAt: Date.now(), scope };
    this._tokens.set(scope, entry);
    return entry;
  }

  validate(scope, token) {
    const entry = this._tokens.get(scope);
    if (!entry) return false;
    return entry.token === token;
  }

  invalidate(scope) {
    return this.issue(scope); // New token = old token invalid
  }

  getToken(scope) { return this._tokens.get(scope) || null; }
  size()          { return this._tokens.size; }
}

// ─── SyncCheckpointManager ───────────────────────────────────────────────────

class SyncCheckpointManager {
  constructor() {
    // `${userId}:${chatId}` -> { lamport, ts, messageCount }
    this._checkpoints = new Map();
  }

  record(userId, chatId, lamport, messageCount = 0) {
    const key = `${userId}:${chatId}`;
    this._checkpoints.set(key, {
      userId, chatId, lamport: Number(lamport), messageCount,
      ts: Date.now(),
    });
  }

  get(userId, chatId) {
    return this._checkpoints.get(`${userId}:${chatId}`) || null;
  }

  getLastSyncTs(userId, chatId) {
    return this._checkpoints.get(`${userId}:${chatId}`)?.ts || null;
  }

  size() { return this._checkpoints.size; }
}

// ─── DeleteBroadcaster ───────────────────────────────────────────────────────

class DeleteBroadcaster {
  constructor(io) { this._io = io; }

  broadcast(type, id, chatId, deletedBy) {
    const payload = {
      type:      `${type}:deleted`,
      messageId: id,
      id,
      chatId,
      deletedBy,
      timestamp: Date.now(),
      purgeCache: true,  // Signal clients to purge all caches
    };

    // Broadcast to chat room
    if (chatId) this._io.to(chatId).emit(`${type}:deleted`, payload);

    // Also emit globally for any listeners
    this._io.emit('cache:invalidate', { type, id, chatId, purgeEverywhere: true });
  }
}

// ─── CacheReconciliationEngine (main) ────────────────────────────────────────

class CacheReconciliationEngine extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io           = io;
    this._logger       = options.logger || console;
    this._tokens       = new CacheTokenManager();
    this._checkpoints  = new SyncCheckpointManager();
    this._broadcaster  = new DeleteBroadcaster(io);
    this._attached     = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', socket => this._onConnection(socket));
    this._logger.log('[CacheReconciliation:Server] ✅ Attached');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Call when any entity is deleted.
   * Broadcasts to all clients and issues new invalidation token.
   */
  onDeleted(type, id, chatId, deletedBy) {
    // Invalidate cache token for this scope
    const token = this._tokens.invalidate(`${type}:${chatId || id}`);

    // Broadcast deletion everywhere
    this._broadcaster.broadcast(type, id, chatId, deletedBy);

    this.emit('cache:invalidated', { type, id, chatId, token });
    this._logger.log(`[CacheReconciliation] Deleted ${type}:${id} in chat ${chatId} — token v${token.version}`);
  }

  /**
   * Issue a cache token for a chat/user scope.
   * Clients include this token in hydration — server validates freshness.
   */
  issueToken(scope) {
    return this._tokens.issue(scope);
  }

  /**
   * Validate a cache token from a client.
   * Returns false if stale (client should re-fetch).
   */
  validateToken(scope, token) {
    return this._tokens.validate(scope, token);
  }

  /**
   * Record a sync checkpoint for a user/chat.
   */
  recordCheckpoint(userId, chatId, lamport, messageCount) {
    this._checkpoints.record(userId, chatId, lamport, messageCount);
  }

  getCheckpoint(userId, chatId) {
    return this._checkpoints.get(userId, chatId);
  }

  /**
   * Express middleware: attach cache tokens to list responses.
   */
  cacheTokenMiddleware(type) {
    const self = this;
    return (req, res, next) => {
      const origJson = res.json.bind(res);
      res.json = function (data) {
        const chatId = req.params.chatId || req.query.chatId;
        if (chatId) {
          const token = self._tokens.getToken(`${type}:${chatId}`) || self._tokens.issue(`${type}:${chatId}`);
          if (Array.isArray(data)) {
            return origJson({ data, __cacheToken: token.token, __cacheVersion: token.version });
          }
          if (data && typeof data === 'object') {
            data.__cacheToken   = token.token;
            data.__cacheVersion = token.version;
          }
        }
        return origJson(data);
      };
      next();
    };
  }

  /**
   * Express route: validate cache token (client checks before hydrating).
   */
  registerValidationRoute(app) {
    app.post('/api/cache/validate', (req, res) => {
      const { scope, token } = req.body || {};
      if (!scope || !token) return res.json({ valid: false, reason: 'missing_params' });

      const valid = this._tokens.validate(scope, token);
      const current = this._tokens.getToken(scope);

      res.json({
        valid,
        version:  current?.version || 0,
        token:    current?.token   || null,
        issuedAt: current?.issuedAt || null,
      });
    });

    this._logger.log('[CacheReconciliation] Validation route: POST /api/cache/validate');
  }

  getDiagnostics() {
    return {
      cacheTokens:  this._tokens.size(),
      checkpoints:  this._checkpoints.size(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onConnection(socket) {
    const userId = socket.handshake?.auth?.userId || null;

    // Client requests cache token for a scope
    socket.on('cache:request_token', data => {
      const scope = data?.scope;
      if (!scope) return;
      const token = this._tokens.issue(scope);
      socket.emit('cache:token', { scope, token: token.token, version: token.version });
    });

    // Client reports stale cache
    socket.on('cache:stale_report', data => {
      this._logger.log(`[CacheReconciliation] Stale cache reported by user ${userId}:`, data?.scope);
      this.emit('cache:stale_reported', { userId, ...data });
    });

    // Client records sync checkpoint
    socket.on('sync:checkpoint', data => {
      if (!userId || !data?.chatId) return;
      this._checkpoints.record(userId, data.chatId, data.lamport || 0, data.messageCount || 0);
    });
  }
}

module.exports = CacheReconciliationEngine;
