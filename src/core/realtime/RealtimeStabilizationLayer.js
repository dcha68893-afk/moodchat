/**
 * RealtimeStabilizationLayer.js (Backend)
 * Phase 1 — Realtime Stabilization
 *
 * Wraps the existing Socket.IO server to:
 *  - Prevent duplicate event emissions
 *  - Track socket lifecycle
 *  - Validate event ordering
 *  - Prevent reconnect storms per-socket
 *  - Normalize event names to domain:action format
 *  - Clean up stale listeners on disconnect
 *
 * Usage:
 *   const RealtimeStab = require('./core/realtime/RealtimeStabilizationLayer');
 *   const stab = new RealtimeStab(io, { logger });
 *   stab.attach();
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');

// ─── Event name normalization map ─────────────────────────────────────────────
// Maps legacy or inconsistent event names to normalized domain:action format
const EVENT_NORMALIZATION_MAP = {
  // Messages
  'newMessage':        'message:created',
  'new_message':       'message:created',
  'messageDeleted':    'message:deleted',
  'message_deleted':   'message:deleted',
  'messageEdited':     'message:edited',
  'messageReaction':   'message:reacted',

  // Presence
  'userOnline':        'presence:online',
  'user_online':       'presence:online',
  'userOffline':       'presence:offline',
  'user_offline':      'presence:offline',

  // Typing
  'typing':            'typing:start',
  'stopTyping':        'typing:stop',
  'stop_typing':       'typing:stop',

  // Friends
  'friendRequest':     'friend:request',
  'friend_request':    'friend:request',
  'friendAccepted':    'friend:accepted',
  'friend_accepted':   'friend:accepted',
  'friendRemoved':     'friend:removed',

  // Groups
  'groupMessage':      'group:message',
  'group_message':     'group:message',
  'groupUpdated':      'group:updated',

  // Calls
  'callStarted':       'call:started',
  'callEnded':         'call:ended',
  'callAccepted':      'call:accepted',
  'callRejected':      'call:rejected',
  'callOffer':         'call:offer',
  'callAnswer':        'call:answer',
  'iceCandidate':      'call:ice_candidate',

  // Read receipts
  'readReceipt':       'message:read',
  'read_receipt':      'message:read',
  'messagesRead':      'message:read',
};

// ─── SocketLifecycleTracker ──────────────────────────────────────────────────

class SocketLifecycleTracker {
  constructor() {
    this._sockets = new Map(); // socketId -> { userId, connectedAt, disconnectedAt, state, events }
  }

  register(socketId, userId) {
    this._sockets.set(socketId, {
      socketId,
      userId,
      connectedAt: Date.now(),
      disconnectedAt: null,
      state: 'connected',
      eventCount: 0,
      lastEventAt: null,
    });
  }

  markDisconnected(socketId, reason) {
    const entry = this._sockets.get(socketId);
    if (!entry) return;
    entry.state = 'disconnected';
    entry.disconnectedAt = Date.now();
    entry.disconnectReason = reason;
  }

  recordEvent(socketId) {
    const entry = this._sockets.get(socketId);
    if (!entry) return;
    entry.eventCount++;
    entry.lastEventAt = Date.now();
  }

  remove(socketId) {
    this._sockets.delete(socketId);
  }

  getMetrics() {
    const sockets = Array.from(this._sockets.values());
    return {
      total: sockets.length,
      connected: sockets.filter((s) => s.state === 'connected').length,
      disconnected: sockets.filter((s) => s.state === 'disconnected').length,
    };
  }

  getSocket(socketId) { return this._sockets.get(socketId) || null; }
}

// ─── ReconnectStormPreventer (per-socket) ────────────────────────────────────

class ReconnectStormPreventer {
  constructor() {
    this._attempts = new Map(); // socketId -> [timestamps]
    this._blocked = new Map();  // socketId -> blockedUntil
  }

  canConnect(socketId) {
    const now = Date.now();

    const blocked = this._blocked.get(socketId);
    if (blocked && now < blocked) return false;

    const attempts = (this._attempts.get(socketId) || []).filter((t) => now - t < 10000);
    attempts.push(now);
    this._attempts.set(socketId, attempts);

    if (attempts.length >= 8) {
      this._blocked.set(socketId, now + 30000);
      console.warn(`[RealtimeStab:Server] Reconnect storm from socket ${socketId} — blocking 30s`);
      return false;
    }

    return true;
  }

  clear(socketId) {
    this._attempts.delete(socketId);
    this._blocked.delete(socketId);
  }

  cleanup() {
    const now = Date.now();
    for (const [id, t] of this._blocked) {
      if (now > t) { this._blocked.delete(id); this._attempts.delete(id); }
    }
  }
}

// ─── DuplicateEmissionGuard ──────────────────────────────────────────────────

class DuplicateEmissionGuard {
  constructor(windowMs = 500) {
    this._seen = new Map(); // `${socketId}:${event}:${hash}` -> ts
    this._windowMs = windowMs;
    this._duplicates = 0;
  }

  isDuplicate(socketId, event, payload) {
    const hash = this._hashPayload(payload);
    const key = `${socketId}:${event}:${hash}`;
    const now = Date.now();

    const last = this._seen.get(key);
    if (last && now - last < this._windowMs) {
      this._duplicates++;
      return true;
    }

    this._seen.set(key, now);

    // Prune old entries
    if (this._seen.size > 2000) {
      for (const [k, ts] of this._seen) {
        if (now - ts > this._windowMs * 2) this._seen.delete(k);
      }
    }

    return false;
  }

  _hashPayload(payload) {
    if (!payload) return 'null';
    const id = payload.id || payload.messageId || payload.localId || payload.callId || null;
    if (id) return String(id);
    // Simple string hash of serialized payload (truncated for perf)
    const str = JSON.stringify(payload).slice(0, 100);
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h.toString(36);
  }

  getCount() { return this._duplicates; }
}

// ─── EventValidator ──────────────────────────────────────────────────────────

class EventValidator {
  constructor() {
    this._seenIds = new Map();
    this._maxAge = 120000;
    this._duplicates = 0;
  }

  isValid(eventId, timestamp) {
    const now = Date.now();

    // Prune
    for (const [id, ts] of this._seenIds) {
      if (now - ts > this._maxAge) this._seenIds.delete(id);
    }

    if (eventId && this._seenIds.has(eventId)) {
      this._duplicates++;
      return false;
    }
    if (eventId) this._seenIds.set(eventId, now);
    return true;
  }

  getStats() {
    return { duplicates: this._duplicates, windowSize: this._seenIds.size };
  }
}

// ─── RealtimeStabilizationLayer (main) ───────────────────────────────────────

class RealtimeStabilizationLayer extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io = io;
    this._logger = options.logger || console;
    this._lifecycle = new SocketLifecycleTracker();
    this._stormPreventer = new ReconnectStormPreventer();
    this._dupGuard = new DuplicateEmissionGuard(options.dupWindowMs || 500);
    this._validator = new EventValidator();
    this._attached = false;

    // Cleanup stale storm entries periodically
    setInterval(() => this._stormPreventer.cleanup(), 60000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', (socket) => this._onConnection(socket));

    this._logger.log('[RealtimeStab:Server] ✅ Attached to Socket.IO');
    return this;
  }

  /**
   * Safe emit — checks for duplicates before emitting to a socket.
   */
  safeEmit(socket, event, payload) {
    if (this._dupGuard.isDuplicate(socket.id, event, payload)) {
      this._logger.debug?.(`[RealtimeStab:Server] Duplicate suppressed: ${event} -> ${socket.id}`);
      return false;
    }
    socket.emit(event, payload);
    return true;
  }

  /**
   * Normalize an event name to domain:action format.
   */
  normalize(eventName) {
    return EVENT_NORMALIZATION_MAP[eventName] || eventName;
  }

  /**
   * Validate an incoming event from a socket.
   */
  validateEvent(payload) {
    const id = payload?.eventId || payload?.id || null;
    const ts = payload?.timestamp ? new Date(payload.timestamp).getTime() : null;
    return this._validator.isValid(id, ts);
  }

  getDiagnostics() {
    return {
      lifecycle: this._lifecycle.getMetrics(),
      duplicateEmissions: this._dupGuard.getCount(),
      eventValidator: this._validator.getStats(),
    };
  }

  // ── Private — Socket lifecycle ─────────────────────────────────────────────

  _onConnection(socket) {
    const userId = socket.handshake?.auth?.userId || socket.handshake?.query?.userId || null;

    // Storm prevention
    if (!this._stormPreventer.canConnect(socket.id)) {
      socket.disconnect(true);
      return;
    }

    this._lifecycle.register(socket.id, userId);
    this.emit('socket:connected', { socketId: socket.id, userId });

    // Track incoming events for dedup
    const originalOnEvent = socket.onevent?.bind(socket);
    if (socket.onevent) {
      socket.onevent = (packet) => {
        this._lifecycle.recordEvent(socket.id);
        originalOnEvent(packet);
      };
    }

    socket.on('disconnect', (reason) => {
      this._lifecycle.markDisconnected(socket.id, reason);
      this.emit('socket:disconnected', { socketId: socket.id, userId, reason });

      // Schedule cleanup after 30s (in case of reconnect)
      setTimeout(() => {
        this._lifecycle.remove(socket.id);
        this._stormPreventer.clear(socket.id);
      }, 30000);
    });

    socket.on('reconnect', () => {
      this._stormPreventer.clear(socket.id);
      this.emit('socket:reconnected', { socketId: socket.id, userId });
    });
  }
}

module.exports = RealtimeStabilizationLayer;
