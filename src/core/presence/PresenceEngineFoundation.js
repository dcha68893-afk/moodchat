/**
 * PresenceEngineFoundation.js (Backend)
 * Phase 1 — Presence Engine Foundation
 *
 * Server-side presence coordination:
 *  - Tracks online/offline/idle/typing per user
 *  - Heartbeat validation — ghost user prevention
 *  - Multi-device / multi-socket session management
 *  - Reconnect presence re-synchronization
 *  - Stale typing indicator cleanup
 *
 * Usage:
 *   const PresenceEngine = require('./core/presence/PresenceEngineFoundation');
 *   const presence = new PresenceEngine(io, { logger });
 *   presence.attach();
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');

// ─── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 75000;   // Mark offline if no heartbeat for 75s
const TYPING_TIMEOUT_MS    = 6000;    // Auto-clear typing after 6s
const IDLE_THRESHOLD_MS    = 5 * 60 * 1000; // 5 min without activity = idle
const GHOST_SWEEP_INTERVAL = 30000;   // Check for ghosts every 30s

const PresenceStatus = Object.freeze({
  ONLINE:       'online',
  OFFLINE:      'offline',
  IDLE:         'idle',
  TYPING:       'typing',
  BACKGROUNDED: 'backgrounded',
  RECONNECTING: 'reconnecting',
});

// ─── UserSessionRegistry ─────────────────────────────────────────────────────

class UserSessionRegistry {
  constructor() {
    // userId -> Set<socketId>
    this._userSockets = new Map();
    // socketId -> userId
    this._socketUser = new Map();
  }

  registerSocket(socketId, userId) {
    this._socketUser.set(socketId, userId);
    if (!this._userSockets.has(userId)) {
      this._userSockets.set(userId, new Set());
    }
    this._userSockets.get(userId).add(socketId);
  }

  unregisterSocket(socketId) {
    const userId = this._socketUser.get(socketId);
    if (!userId) return null;
    this._socketUser.delete(socketId);
    const sockets = this._userSockets.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) this._userSockets.delete(userId);
    }
    return userId;
  }

  getUserId(socketId) {
    return this._socketUser.get(socketId) || null;
  }

  getSocketIds(userId) {
    return Array.from(this._userSockets.get(userId) || []);
  }

  isOnline(userId) {
    const sockets = this._userSockets.get(userId);
    return !!(sockets && sockets.size > 0);
  }

  getSessionCount(userId) {
    return this._userSockets.get(userId)?.size || 0;
  }

  getAllOnlineUserIds() {
    return Array.from(this._userSockets.keys());
  }
}

// ─── HeartbeatTracker ────────────────────────────────────────────────────────

class HeartbeatTracker {
  constructor() {
    // userId -> { lastBeat, socketId }
    this._beats = new Map();
  }

  record(userId, socketId) {
    this._beats.set(userId, { lastBeat: Date.now(), socketId });
  }

  remove(userId) {
    this._beats.delete(userId);
  }

  isStale(userId) {
    const entry = this._beats.get(userId);
    if (!entry) return true;
    return Date.now() - entry.lastBeat > HEARTBEAT_TIMEOUT_MS;
  }

  getStaleBefore(cutoff) {
    const stale = [];
    for (const [userId, entry] of this._beats) {
      if (entry.lastBeat < cutoff) stale.push(userId);
    }
    return stale;
  }

  getLastBeat(userId) {
    return this._beats.get(userId)?.lastBeat || null;
  }

  count() { return this._beats.size; }
}

// ─── TypingManager ───────────────────────────────────────────────────────────

class TypingManager {
  constructor(onStop) {
    // `${chatId}:${userId}` -> timeoutId
    this._timers = new Map();
    this._onStop = onStop;
  }

  start(chatId, userId) {
    const key = `${chatId}:${userId}`;
    if (this._timers.has(key)) clearTimeout(this._timers.get(key));
    const timer = setTimeout(() => {
      this._timers.delete(key);
      this._onStop(chatId, userId);
    }, TYPING_TIMEOUT_MS);
    this._timers.set(key, timer);
  }

  stop(chatId, userId) {
    const key = `${chatId}:${userId}`;
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key));
      this._timers.delete(key);
    }
    this._onStop(chatId, userId);
  }

  stopAllForUser(userId) {
    for (const [key, timer] of this._timers) {
      if (key.endsWith(`:${userId}`)) {
        clearTimeout(timer);
        this._timers.delete(key);
        const chatId = key.split(':')[0];
        this._onStop(chatId, userId);
      }
    }
  }

  activeCount() { return this._timers.size; }
}

// ─── PresenceEngineFoundation (main) ─────────────────────────────────────────

class PresenceEngineFoundation extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io = io;
    this._logger = options.logger || console;

    this._sessions = new UserSessionRegistry();
    this._heartbeats = new HeartbeatTracker();
    this._userStatus = new Map();   // userId -> PresenceStatus
    this._lastActivity = new Map(); // userId -> timestamp
    this._typing = new TypingManager((chatId, userId) => {
      this._broadcastTypingStop(chatId, userId);
    });

    this._ghostSweepTimer = null;
    this._attached = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', (socket) => this._onConnection(socket));
    this._startGhostSweep();

    this._logger.log('[PresenceEngine:Server] ✅ Attached');
    return this;
  }

  getStatus(userId) {
    if (!this._sessions.isOnline(userId)) return PresenceStatus.OFFLINE;
    return this._userStatus.get(userId) || PresenceStatus.ONLINE;
  }

  getOnlineUsers() {
    return this._sessions.getAllOnlineUserIds().map((userId) => ({
      userId,
      status: this.getStatus(userId),
      sessionCount: this._sessions.getSessionCount(userId),
      lastSeen: this._heartbeats.getLastBeat(userId) || Date.now(),
    }));
  }

  isTyping(chatId, userId) {
    // Check via internal typing manager (has active timer)
    return false; // Typing state is event-driven; callers listen to events
  }

  /**
   * Send full presence snapshot to a newly connected socket.
   */
  syncToSocket(socket, userId) {
    const onlineUsers = this.getOnlineUsers();
    socket.emit('presence:sync', { users: onlineUsers });
  }

  getDiagnostics() {
    return {
      onlineUsers: this._sessions.getAllOnlineUserIds().length,
      heartbeatTracked: this._heartbeats.count(),
      activeTyping: this._typing.activeCount(),
      statusMap: Object.fromEntries(this._userStatus),
    };
  }

  // ── Private — Connection handling ─────────────────────────────────────────

  _onConnection(socket) {
    const userId = socket.handshake?.auth?.userId
      || socket.handshake?.query?.userId
      || null;

    if (!userId) return; // Anonymous socket — skip presence

    this._sessions.registerSocket(socket.id, userId);
    this._heartbeats.record(userId, socket.id);
    this._setStatus(userId, PresenceStatus.ONLINE);

    // Send current presence to this socket
    this.syncToSocket(socket, userId);

    // Broadcast this user's online status to their contacts
    this._broadcastStatus(userId, PresenceStatus.ONLINE, socket);

    // ── Socket event listeners ───────────────────────────────────────────────
    // FIX: use removeAllListeners() before each registration (matching the
    // defensive pattern in CallSignalingService.js) so this is safe even if
    // _onConnection is ever invoked more than once for the same socket.

    socket.removeAllListeners('heartbeat').on('heartbeat', () => {
      this._heartbeats.record(userId, socket.id);
      this._lastActivity.set(userId, Date.now());

      // If user was idle/backgrounded, restore online
      const current = this._userStatus.get(userId);
      if (current === PresenceStatus.IDLE || current === PresenceStatus.BACKGROUNDED) {
        this._setStatus(userId, PresenceStatus.ONLINE);
        this._broadcastStatus(userId, PresenceStatus.ONLINE, socket);
      }
    });

    socket.removeAllListeners('presence:idle').on('presence:idle', () => {
      this._setStatus(userId, PresenceStatus.IDLE);
      this._broadcastStatus(userId, PresenceStatus.IDLE, socket);
    });

    socket.removeAllListeners('presence:backgrounded').on('presence:backgrounded', () => {
      this._setStatus(userId, PresenceStatus.BACKGROUNDED);
      this._broadcastStatus(userId, PresenceStatus.BACKGROUNDED, socket);
    });

    socket.removeAllListeners('presence:active').on('presence:active', () => {
      this._heartbeats.record(userId, socket.id);
      this._setStatus(userId, PresenceStatus.ONLINE);
      this._broadcastStatus(userId, PresenceStatus.ONLINE, socket);
    });

    socket.removeAllListeners('typing:start').on('typing:start', (data) => {
      const chatId = data?.chatId || data?.conversationId;
      if (!chatId) return;
      this._typing.start(chatId, userId);
      this._broadcastTypingStart(chatId, userId, socket);
    });

    socket.removeAllListeners('typing:stop').on('typing:stop', (data) => {
      const chatId = data?.chatId || data?.conversationId;
      if (!chatId) return;
      this._typing.stop(chatId, userId);
    });

    // Legacy event aliases
    socket.removeAllListeners('typing').on('typing', (data) => socket.emit('typing:start', data));
    socket.removeAllListeners('stopTyping').on('stopTyping', (data) => socket.emit('typing:stop', data));

    socket.removeAllListeners('disconnect').on('disconnect', (reason) => {
      this._onDisconnect(socket, userId, reason);
    });
  }

  _onDisconnect(socket, userId, reason) {
    const userId2 = this._sessions.unregisterSocket(socket.id) || userId;
    this._typing.stopAllForUser(userId2);

    // Only mark offline if this was their last socket
    if (!this._sessions.isOnline(userId2)) {
      this._setStatus(userId2, PresenceStatus.OFFLINE);
      this._heartbeats.remove(userId2);
      this._broadcastStatus(userId2, PresenceStatus.OFFLINE, socket);
    }

    this.emit('presence:disconnected', { userId: userId2, socketId: socket.id, reason });
  }

  // ── Status management ──────────────────────────────────────────────────────

  _setStatus(userId, status) {
    const prev = this._userStatus.get(userId);
    this._userStatus.set(userId, status);
    if (prev !== status) {
      this.emit('presence:changed', { userId, status, prev });
    }
  }

  // ── Broadcasting ───────────────────────────────────────────────────────────

  _broadcastStatus(userId, status, socket) {
    // Broadcast to all rooms/contacts this user is in
    // We emit to a user-specific room that contacts subscribe to
    socket.broadcast.emit('presence:update', {
      userId,
      status,
      timestamp: Date.now(),
    });

    this.emit('presence:broadcast', { userId, status });
  }

  _broadcastTypingStart(chatId, userId, socket) {
    socket.to(chatId).emit('typing:start', {
      chatId,
      userId,
      timestamp: Date.now(),
    });
    this.emit('typing:start', { chatId, userId });
  }

  _broadcastTypingStop(chatId, userId) {
    this._io.to(chatId).emit('typing:stop', {
      chatId,
      userId,
      timestamp: Date.now(),
    });
    this.emit('typing:stop', { chatId, userId });
  }

  // ── Ghost sweep ────────────────────────────────────────────────────────────

  _startGhostSweep() {
    this._ghostSweepTimer = setInterval(() => {
      const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
      const staleUsers = this._heartbeats.getStaleBefore(cutoff);

      for (const userId of staleUsers) {
        if (this._sessions.isOnline(userId)) {
          this._logger.warn(`[PresenceEngine:Server] Ghost detected: ${userId} — marking offline`);
          this._setStatus(userId, PresenceStatus.OFFLINE);
          this._heartbeats.remove(userId);

          this._io.emit('presence:update', {
            userId,
            status: PresenceStatus.OFFLINE,
            reason: 'heartbeat_timeout',
            timestamp: Date.now(),
          });

          this.emit('presence:ghost_cleared', { userId });
        }
      }
    }, GHOST_SWEEP_INTERVAL);
  }
}

module.exports = { PresenceEngineFoundation, PresenceStatus };
