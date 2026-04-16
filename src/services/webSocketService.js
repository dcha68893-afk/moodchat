'use strict';

const db = require('../models');

const User = db.Users || db.User;

class WebSocketService {
  constructor() {
    this.io = null;
    this.userSockets = new Map();
    this.wsClients = new Map();
  }

  setIO(io) {
    this.io = io || null;
    return this;
  }

  getIO() {
    return this.io || global.__socketIO || null;
  }

  registerUserSocket(userId, socketId) {
    const normalizedUserId = parseInt(userId, 10);
    if (!normalizedUserId || !socketId) return false;

    const existing = this.userSockets.get(normalizedUserId) || new Set();
    existing.add(socketId);
    this.userSockets.set(normalizedUserId, existing);
    return true;
  }

  registerWebSocketClient(userId, ws) {
    const normalizedUserId = parseInt(userId, 10);
    if (!normalizedUserId || !ws) return false;

    const existing = this.wsClients.get(normalizedUserId) || new Set();
    existing.add(ws);
    this.wsClients.set(normalizedUserId, existing);
    return true;
  }

  unregisterUserSocket(userId, socketId) {
    const normalizedUserId = parseInt(userId, 10);
    if (!normalizedUserId || !socketId) return false;

    const existing = this.userSockets.get(normalizedUserId);
    if (!existing) return false;

    existing.delete(socketId);
    if (existing.size === 0) {
      this.userSockets.delete(normalizedUserId);
    }
    return true;
  }

  unregisterWebSocketClient(userId, ws) {
    const normalizedUserId = parseInt(userId, 10);
    if (!normalizedUserId || !ws) return false;

    const existing = this.wsClients.get(normalizedUserId);
    if (!existing) return false;

    existing.delete(ws);
    if (existing.size === 0) {
      this.wsClients.delete(normalizedUserId);
    }
    return true;
  }

  async getSocketIdsForUser(userId) {
    const normalizedUserId = parseInt(userId, 10);
    if (!normalizedUserId) return [];

    const inMemory = this.userSockets.get(normalizedUserId);
    if (inMemory && inMemory.size > 0) {
      return Array.from(inMemory);
    }

    if (!User || typeof User.findByPk !== 'function') {
      return [];
    }

    try {
      const user = await User.findByPk(normalizedUserId, { attributes: ['id', 'socketIds'] });
      return Array.isArray(user?.socketIds) ? user.socketIds.filter(Boolean) : [];
    } catch (error) {
      console.warn('[WebSocketService] getSocketIdsForUser failed:', error.message);
      return [];
    }
  }

  async isUserOnline(userId) {
    const normalizedUserId = parseInt(userId, 10);
    const wsClients = this.wsClients.get(normalizedUserId);
    if (wsClients && wsClients.size > 0) return true;

    const socketIds = await this.getSocketIdsForUser(userId);
    if (socketIds.length > 0) return true;

    const io = this.getIO();
    if (!io || !io.sockets?.adapter?.rooms) return false;

    const userRooms = [`user:${userId}`, `user_${userId}`];
    return userRooms.some((room) => io.sockets.adapter.rooms.has(room));
  }

  async sendToUser(userId, event, data = {}) {
    const io = this.getIO();
    const normalizedUserId = parseInt(userId, 10);
    if (!normalizedUserId || !event) return false;

    const payload = {
      ...data,
      timestamp: data.timestamp || new Date().toISOString(),
    };

    let delivered = false;

    const wsClients = this.wsClients.get(normalizedUserId);
    if (wsClients && wsClients.size > 0) {
      const rawPayload = JSON.stringify({
        type: event,
        payload,
        timestamp: payload.timestamp
      });

      wsClients.forEach((client) => {
        try {
          if (client && client.readyState === 1) {
            client.send(rawPayload);
            delivered = true;
          }
        } catch (_) {}
      });
    }

    if (!io) {
      return delivered;
    }

    const rooms = [`user:${normalizedUserId}`, `user_${normalizedUserId}`];
    rooms.forEach((room) => {
      try {
        io.to(room).emit(event, payload);
        delivered = true;
      } catch (_) {}
    });

    const socketIds = await this.getSocketIdsForUser(normalizedUserId);
    socketIds.forEach((socketId) => {
      try {
        io.to(socketId).emit(event, payload);
        delivered = true;
      } catch (_) {}
    });

    return delivered;
  }

  async notifyCallInitiated(userId, data = {}) {
    return this.sendToUser(userId, 'call:incoming', data);
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

  async sendSignal(userId, payload = {}) {
    return this.sendToUser(userId, 'webrtc:signal', payload);
  }

  handleReconnect(userId, socketId) {
    return this.registerUserSocket(userId, socketId);
  }

  connect(io) {
    return this.setIO(io);
  }

  disconnect(userId, socketId) {
    if (userId && socketId) {
      return this.unregisterUserSocket(userId, socketId);
    }
    return true;
  }
}

module.exports = new WebSocketService();
