'use strict';

/**
 * webSocketService.js
 * FIXED VERSION — adds:
 *  • this.onlineUsers = new Map()  (userId → Set<socket>)
 *  • isUserOnline(userId)          ← was crashing callController / calls.js
 *  • registerUser / removeUser     ← called from socket-init code in chat.html / server
 *  • unified sendToUser            ← works via Socket.IO rooms AND raw WebSocket clients
 *  • notifyCallInitiated / sendSignal / sendNotification helpers
 *  • handleReconnect exposed for app_stability_bridge
 */

const db   = require('../models');
const User = db.Users || db.User;

class WebSocketService {
  constructor() {
    this.io          = null;

    // ── Primary online-user registry (userId → Set<socketId>) ──────────────
    // THIS WAS MISSING — caused "wsService.isUserOnline is not a function" crash
    this.onlineUsers = new Map();   // userId(int) → Set<socketId(string)>

    // ── Legacy maps kept for backward compat ───────────────────────────────
    this.userSockets = new Map();   // userId(int) → Set<socketId(string)>  (alias of onlineUsers)
    this.wsClients   = new Map();   // userId(int) → Set<WebSocket>  (raw WS, e.g. ws:// clients)
  }

  // ── IO setup ───────────────────────────────────────────────────────────────

  setIO(io) {
    this.io = io || null;
    return this;
  }

  getIO() {
    return this.io || global.__socketIO || null;
  }

  // ── PRIMARY: register / remove by userId+socketId ─────────────────────────

  /**
   * Called on socket 'connect'. Registers the socket under this user.
   * Also joins the socket to the canonical room so room-based emits work.
   */
  registerUser(userId, socketOrSocketId) {
    const uid      = parseInt(userId, 10);
    const socketId = typeof socketOrSocketId === 'string'
      ? socketOrSocketId
      : (socketOrSocketId && socketOrSocketId.id);

    if (!uid || !socketId) return false;

    // onlineUsers
    if (!this.onlineUsers.has(uid)) this.onlineUsers.set(uid, new Set());
    this.onlineUsers.get(uid).add(socketId);

    // keep userSockets in sync (legacy)
    if (!this.userSockets.has(uid)) this.userSockets.set(uid, new Set());
    this.userSockets.get(uid).add(socketId);

    // If the caller passed a socket object, join it to the user room
    if (socketOrSocketId && typeof socketOrSocketId.join === 'function') {
      try {
        socketOrSocketId.join(`user:${uid}`);
        socketOrSocketId.join(`user_${uid}`);
      } catch (_) {}
    }

    console.log(`[WSService] registerUser uid=${uid} socketId=${socketId} (total=${this.onlineUsers.get(uid).size})`);
    return true;
  }

  /**
   * Called on socket 'disconnect'. Removes the socket from this user's entry.
   */
  removeUser(userId, socketOrSocketId) {
    const uid      = parseInt(userId, 10);
    const socketId = typeof socketOrSocketId === 'string'
      ? socketOrSocketId
      : (socketOrSocketId && socketOrSocketId.id);

    if (!uid) return false;

    const removeFromMap = (map, key, value) => {
      const set = map.get(key);
      if (!set) return;
      if (value) set.delete(value);
      if (!value || set.size === 0) map.delete(key);
    };

    removeFromMap(this.onlineUsers, uid, socketId);
    removeFromMap(this.userSockets, uid, socketId);

    console.log(`[WSService] removeUser uid=${uid} socketId=${socketId}`);
    return true;
  }

  // ── isUserOnline — THE KEY FIX ─────────────────────────────────────────────

  /**
   * Returns true if the given user has at least one active socket connection.
   * PREVIOUSLY MISSING — caused "wsService.isUserOnline is not a function".
   */
  async isUserOnline(userId) {
    const uid = parseInt(userId, 10);
    if (!uid) return false;

    // 1. Check in-memory map first (fast path)
    const sockets = this.onlineUsers.get(uid);
    if (sockets && sockets.size > 0) return true;

    // 2. Check raw WebSocket clients
    const wsClients = this.wsClients.get(uid);
    if (wsClients && wsClients.size > 0) {
      // Prune dead clients
      for (const ws of wsClients) {
        if (ws.readyState === 1 /* OPEN */) return true;
      }
    }

    // 3. Check Socket.IO adapter rooms
    const io = this.getIO();
    if (io && io.sockets && io.sockets.adapter && io.sockets.adapter.rooms) {
      const rooms = [`user:${uid}`, `user_${uid}`];
      for (const room of rooms) {
        if (io.sockets.adapter.rooms.has(room)) return true;
      }
    }

    // 4. Fallback: DB socketIds column (legacy)
    if (User && typeof User.findByPk === 'function') {
      try {
        const user = await User.findByPk(uid, { attributes: ['id', 'socketIds'] });
        if (Array.isArray(user && user.socketIds) && user.socketIds.length > 0) return true;
      } catch (_) {}
    }

    return false;
  }

  // ── Socket registration (lower-level, used by chat.html socket-connect) ──

  registerUserSocket(userId, socketId) {
    return this.registerUser(userId, socketId);
  }

  unregisterUserSocket(userId, socketId) {
    return this.removeUser(userId, socketId);
  }

  // ── Raw WebSocket client registration (non-Socket.IO) ─────────────────────

  registerWebSocketClient(userId, ws) {
    const uid = parseInt(userId, 10);
    if (!uid || !ws) return false;
    if (!this.wsClients.has(uid)) this.wsClients.set(uid, new Set());
    this.wsClients.get(uid).add(ws);
    return true;
  }

  unregisterWebSocketClient(userId, ws) {
    const uid = parseInt(userId, 10);
    if (!uid) return false;
    const set = this.wsClients.get(uid);
    if (!set) return false;
    set.delete(ws);
    if (set.size === 0) this.wsClients.delete(uid);
    return true;
  }

  // ── getSocketIdsForUser ────────────────────────────────────────────────────

  async getSocketIdsForUser(userId) {
    const uid = parseInt(userId, 10);
    if (!uid) return [];

    const inMemory = this.onlineUsers.get(uid);
    if (inMemory && inMemory.size > 0) return Array.from(inMemory);

    if (User && typeof User.findByPk === 'function') {
      try {
        const user = await User.findByPk(uid, { attributes: ['id', 'socketIds'] });
        return Array.isArray(user && user.socketIds) ? user.socketIds.filter(Boolean) : [];
      } catch (_) {}
    }
    return [];
  }

  // ── sendToUser — unified delivery ─────────────────────────────────────────

  /**
   * Send an event+payload to every active connection for a user.
   * Tries: raw WS clients → Socket.IO rooms → individual socketIds.
   */
  async sendToUser(userId, event, data = {}) {
    const uid = parseInt(userId, 10);
    if (!uid || !event) return false;

    const payload = {
      ...data,
      timestamp: data.timestamp || new Date().toISOString(),
    };

    let delivered = false;
    const io      = this.getIO();

    // 1. Raw WebSocket clients (non-Socket.IO)
    const wsClients = this.wsClients.get(uid);
    if (wsClients && wsClients.size > 0) {
      const raw = JSON.stringify({ type: event, payload, timestamp: payload.timestamp });
      for (const client of wsClients) {
        try {
          if (client && client.readyState === 1) {
            client.send(raw);
            delivered = true;
          }
        } catch (_) {}
      }
    }

    if (!io) return delivered;

    // 2. Socket.IO rooms (canonical — fastest)
    for (const room of [`user:${uid}`, `user_${uid}`]) {
      try {
        io.to(room).emit(event, payload);
        delivered = true;
      } catch (_) {}
    }

    // 3. Individual socket IDs (catches sockets not yet in a room)
    const socketIds = await this.getSocketIdsForUser(uid);
    for (const sid of socketIds) {
      try {
        io.to(sid).emit(event, payload);
        delivered = true;
      } catch (_) {}
    }

    return delivered;
  }

  // ── Call-specific helpers ─────────────────────────────────────────────────

  /**
   * Send an incoming_call event to a user.
   * Maps to the 'call:incoming' event that calls-core.js listens for.
   */
  async notifyCallInitiated(userId, data = {}) {
    // Emit BOTH naming conventions — calls.js uses 'call:incoming',
    // calls-core.js socket listener handles both variants.
    await this.sendToUser(userId, 'call:incoming',  data);
    await this.sendToUser(userId, 'incoming_call',  data);
    return true;
  }

  async sendSignal(userId, payload = {}) {
    return this.sendToUser(userId, 'webrtc:signal', payload);
  }

  async sendNotification(userId, notification = {}) {
    return this.sendToUser(userId, 'notification:new', notification);
  }

  async notifyMoodShared(userId, payload = {}) {
    return this.sendToUser(userId, 'mood:shared', payload);
  }

  async notifyFriendMood(userId, payload = {}) {
    return this.sendToUser(userId, 'mood:friend', payload);
  }

  // ── Reconnect / connect helpers ───────────────────────────────────────────

  /**
   * Called by app_stability_bridge.js on network restore.
   * Re-registers the user's socket if a socketId is provided.
   */
  handleReconnect(userId, socketId) {
    if (userId && socketId) return this.registerUser(userId, socketId);
    return true;
  }

  connect(io) { return this.setIO(io); }

  disconnect(userId, socketId) {
    if (userId && socketId) return this.removeUser(userId, socketId);
    return true;
  }

  // ── Broadcast helpers ─────────────────────────────────────────────────────

  /** Broadcast to all connected clients (e.g. server-wide announcements). */
  broadcast(event, data = {}) {
    const io = this.getIO();
    if (!io) return false;
    try { io.emit(event, data); return true; } catch (_) { return false; }
  }

  /** Get count of currently-online users. */
  getOnlineCount() {
    return this.onlineUsers.size;
  }

  /** Get all currently-online userIds. */
  getOnlineUserIds() {
    return Array.from(this.onlineUsers.keys());
  }

  // ── ADDED: broadcastToChat ────────────────────────────────────────────────

  /**
   * Broadcast an event to every socket in a chat room.
   * Used by messages.js after edit / delete / react operations.
   * @param {string|number} chatId
   * @param {string} event  e.g. 'message:edited', 'message:deleted', 'message:reaction'
   * @param {object} payload
   */
  broadcastToChat(chatId, event, payload = {}) {
    const io = this.getIO();
    if (!io || !chatId || !event) return false;
    try {
      io.to(`chat:${chatId}`).emit(event, {
        ...payload,
        timestamp: payload.timestamp || new Date().toISOString(),
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── ADDED: init alias ─────────────────────────────────────────────────────

  /**
   * Alias for setIO(io) — lets server.js use the pattern:
   *   wsService.init(io);
   * alongside the existing wsService.setIO(io) call pattern.
   */
  init(io) {
    return this.setIO(io);
  }
}

module.exports = new WebSocketService();