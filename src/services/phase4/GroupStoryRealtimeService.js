/**
 * GroupStoryRealtimeService.js (Backend)
 * Phase 4 — Group + Story Realtime Service
 *
 * Extends the existing webSocketService with:
 *  - Group event broadcasting (wraps existing broadcastToGroup())
 *  - Story/status event broadcasting (extends existing notifyStatusViewed())
 *  - Group room management (join/leave/rejoin)
 *  - Moderation enforcement
 *  - Story viewer sync
 *  - Community discovery endpoint
 *
 * DOES NOT replace webSocketService — wraps and adds to it.
 *
 * @version 4.0.0
 * @phase 4 — Group + Social
 */

'use strict';

const EventEmitter = require('events');

// ─── GroupRoomManager ─────────────────────────────────────────────────────────

class GroupRoomManager {
  constructor(io) {
    this._io = io;
    // groupId → Set<socketId>
    this._rooms = new Map();
  }

  joinRoom(socket, groupId) {
    const roomName = `group:${groupId}`;
    socket.join(roomName);
    if (!this._rooms.has(groupId)) this._rooms.set(groupId, new Set());
    this._rooms.get(groupId).add(socket.id);
    return roomName;
  }

  leaveRoom(socket, groupId) {
    const roomName = `group:${groupId}`;
    socket.leave(roomName);
    this._rooms.get(groupId)?.delete(socket.id);
  }

  emitToGroup(groupId, event, payload, excludeSocketId = null) {
    const roomName = `group:${groupId}`;
    if (excludeSocketId) {
      this._io.to(roomName).except(excludeSocketId).emit(event, payload);
    } else {
      this._io.to(roomName).emit(event, payload);
    }
  }

  getSocketsInGroup(groupId) {
    return Array.from(this._rooms.get(groupId) || []);
  }

  memberCount(groupId) { return this._rooms.get(groupId)?.size || 0; }

  removeSocket(socketId) {
    for (const [, sockets] of this._rooms) sockets.delete(socketId);
  }

  totalRooms()   { return this._rooms.size; }
  totalMembers() {
    let t = 0;
    for (const s of this._rooms.values()) t += s.size;
    return t;
  }
}

// ─── ModerationEnforcer ───────────────────────────────────────────────────────

class ModerationEnforcer {
  constructor() {
    // groupId → Map<userId, { muted, banned, mutedUntil, bannedUntil }>
    this._state = new Map();
  }

  ban(groupId, userId, meta = {}) {
    this._ensure(groupId, userId);
    const entry = this._state.get(groupId).get(String(userId));
    entry.banned      = true;
    entry.banReason   = meta.reason || null;
    entry.bannedUntil = meta.durationMs ? Date.now() + meta.durationMs : null;
  }

  unban(groupId, userId) {
    this._ensure(groupId, userId);
    const entry = this._state.get(groupId).get(String(userId));
    entry.banned = false;
  }

  mute(groupId, userId, durationMs = null) {
    this._ensure(groupId, userId);
    const entry = this._state.get(groupId).get(String(userId));
    entry.muted      = true;
    entry.mutedUntil = durationMs ? Date.now() + durationMs : null;
    if (durationMs) setTimeout(() => this.unmute(groupId, userId), durationMs);
  }

  unmute(groupId, userId) {
    this._ensure(groupId, userId);
    const entry = this._state.get(groupId).get(String(userId));
    entry.muted = false; entry.mutedUntil = null;
  }

  isBanned(groupId, userId) {
    const entry = this._state.get(groupId)?.get(String(userId));
    if (!entry?.banned) return false;
    if (entry.bannedUntil && Date.now() > entry.bannedUntil) { entry.banned = false; return false; }
    return true;
  }

  isMuted(groupId, userId) {
    const entry = this._state.get(groupId)?.get(String(userId));
    if (!entry?.muted) return false;
    if (entry.mutedUntil && Date.now() > entry.mutedUntil) { entry.muted = false; return false; }
    return true;
  }

  canSendMessage(groupId, userId) {
    if (this.isBanned(groupId, userId)) return { allowed: false, reason: 'banned' };
    if (this.isMuted(groupId, userId))  return { allowed: false, reason: 'muted' };
    return { allowed: true };
  }

  _ensure(groupId, userId) {
    if (!this._state.has(groupId)) this._state.set(groupId, new Map());
    const uid = String(userId);
    if (!this._state.get(groupId).has(uid)) {
      this._state.get(groupId).set(uid, { banned: false, muted: false });
    }
  }

  size() { return this._state.size; }
}

// ─── StoryViewerTracker ───────────────────────────────────────────────────────

class StoryViewerTracker {
  constructor() {
    // storyId → Set<userId>
    this._views = new Map();
  }

  recordView(storyId, userId) {
    if (!this._views.has(storyId)) this._views.set(storyId, new Set());
    const before = this._views.get(storyId).size;
    this._views.get(storyId).add(String(userId));
    const after  = this._views.get(storyId).size;
    return after > before; // true = new unique view
  }

  getViewers(storyId) { return Array.from(this._views.get(storyId) || []); }
  getViewCount(storyId) { return this._views.get(storyId)?.size || 0; }
  hasViewed(storyId, userId) { return this._views.get(storyId)?.has(String(userId)) || false; }

  removeStory(storyId) { this._views.delete(storyId); }
  totalStories() { return this._views.size; }
}

// ─── GroupStoryRealtimeService (main) ─────────────────────────────────────────

class GroupStoryRealtimeService extends EventEmitter {
  constructor(io, wsService, options = {}) {
    super();
    this._io          = io;
    this._wsService   = wsService;
    this._logger      = options.logger || console;
    this._rooms       = new GroupRoomManager(io);
    this._moderation  = new ModerationEnforcer();
    this._storyViews  = new StoryViewerTracker();
    this._attached    = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;
    this._io.on('connection', socket => this._onConnection(socket));
    this._logger.log('[GroupStoryRealtime:Server] ✅ Attached');
    return this;
  }

  // ── Group broadcasting (augments existing wsService.broadcastToGroup) ──────

  broadcastGroupEvent(groupId, event, payload, excludeSocketId = null) {
    // Use Phase 4 group rooms for precision targeting
    this._rooms.emitToGroup(groupId, event, { ...payload, groupId, timestamp: Date.now() }, excludeSocketId);
    // Also use existing wsService broadcastToGroup for user:room targeting
    this._wsService.broadcastToGroup(groupId, event, payload, null);
  }

  broadcastGroupMessage(groupId, message, senderId) {
    const payload = { message, groupId, senderId, timestamp: Date.now() };
    this._rooms.emitToGroup(groupId, 'group:message', payload, null);
    this._wsService.sendGroupMessage(groupId, message, senderId);
    this.emit('group:message', { groupId, senderId });
  }

  broadcastStoryNew(ownerId, story, recipientIds) {
    const payload = { story, timestamp: Date.now() };
    // Notify each contact who can see this story
    for (const uid of recipientIds) {
      this._wsService.sendToUser(uid, 'status:new', payload).catch(() => {});
    }
    this.emit('story:new', { storyId: story.id, ownerId });
  }

  async broadcastStoryView(storyId, viewerId, ownerId) {
    const isNew = this._storyViews.recordView(storyId, viewerId);
    if (!isNew) return; // dedup — don't double-count

    const viewCount = this._storyViews.getViewCount(storyId);

    // Notify story owner (uses existing wsService.notifyStatusViewed)
    await this._wsService.notifyStatusViewed(ownerId, {
      storyId,
      viewerId,
      viewCount,
      timestamp: Date.now(),
    });

    this.emit('story:viewed', { storyId, viewerId, viewCount });
  }

  broadcastStoryExpired(statusIds, ownerIds) {
    // Already handled by server.js _pruneExpiredStatuses cron
    // This method supplements it for immediate deletion triggered by admin
    const payload = { statusIds, expiredAt: new Date().toISOString() };
    for (const ownerId of ownerIds) {
      this._wsService.sendToUser(ownerId, 'status:expired', payload).catch(() => {});
    }
  }

  // ── Moderation (server-side enforcement) ──────────────────────────────────

  banUser(groupId, userId, meta = {}) {
    this._moderation.ban(groupId, userId, meta);
    this.emit('group:banned', { groupId, userId });
  }

  unbanUser(groupId, userId) {
    this._moderation.unban(groupId, userId);
  }

  muteUser(groupId, userId, durationMs) {
    this._moderation.mute(groupId, userId, durationMs);
  }

  getDiagnostics() {
    return {
      groupRooms:   this._rooms.totalRooms(),
      roomMembers:  this._rooms.totalMembers(),
      moderated:    this._moderation.size(),
      storiesViewed: this._storyViews.totalStories(),
    };
  }

  // ── Private — Socket handlers ─────────────────────────────────────────────

  _onConnection(socket) {
    const userId = socket.handshake?.auth?.userId || socket.data?.userId || null;
    if (!userId) return;

    // ── Group room join/leave ───────────────────────────────────────────────

    socket.on('group:join_room', data => {
      const { groupId } = data || {};
      if (!groupId) return;
      this._rooms.joinRoom(socket, groupId);
      // Broadcast join (supplement existing broadcastToGroup)
      this._rooms.emitToGroup(groupId, 'group:presence', {
        groupId, userId, online: true, timestamp: Date.now(),
      }, socket.id);
    });

    socket.on('group:leave_room', data => {
      const { groupId } = data || {};
      if (!groupId) return;
      this._rooms.leaveRoom(socket, groupId);
      this._rooms.emitToGroup(groupId, 'group:presence', {
        groupId, userId, online: false, timestamp: Date.now(),
      });
    });

    socket.on('group:rejoin', data => {
      const { groupId } = data || {};
      if (!groupId) return;
      this._rooms.joinRoom(socket, groupId);
      socket.emit('group:rejoin_ack', { groupId, memberCount: this._rooms.memberCount(groupId) });
    });

    // ── Group messaging with server-side moderation ────────────────────────

    socket.on('group:send_message', async data => {
      const { groupId, message } = data || {};
      if (!groupId || !message) return;

      // Server-side moderation enforcement
      const check = this._moderation.canSendMessage(groupId, userId);
      if (!check.allowed) {
        socket.emit('group:message_rejected', { groupId, reason: check.reason, timestamp: Date.now() });
        return;
      }

      // Broadcast to group room
      const fullMsg = { ...message, senderId: userId, timestamp: Date.now() };
      this._rooms.emitToGroup(groupId, 'group:message', { groupId, message: fullMsg }, socket.id);
      // Existing service for user rooms
      this._wsService.broadcastToGroup(groupId, 'group:message', { message: fullMsg }, userId);
      this.emit('group:message', { groupId, senderId: userId });
    });

    // ── Group moderation actions ───────────────────────────────────────────

    socket.on('group:kick', data => {
      const { groupId, targetUserId, reason } = data || {};
      if (!groupId || !targetUserId) return;
      // Kick target from room
      const targetSockets = this._findSocketsForUser(targetUserId);
      targetSockets.forEach(s => this._rooms.leaveRoom(s, groupId));
      this._rooms.emitToGroup(groupId, 'group:kick', { groupId, targetUserId, reason, kickedBy: userId, timestamp: Date.now() });
      this._wsService.sendToUser(targetUserId, 'group:kicked', { groupId, reason, timestamp: Date.now() }).catch(() => {});
      this.emit('group:kicked', { groupId, targetUserId, by: userId });
    });

    socket.on('group:ban', data => {
      const { groupId, targetUserId, reason, durationMs } = data || {};
      if (!groupId || !targetUserId) return;
      this._moderation.ban(groupId, targetUserId, { reason, durationMs });
      this._rooms.emitToGroup(groupId, 'group:ban', { groupId, targetUserId, reason, bannedBy: userId, timestamp: Date.now() });
      this._wsService.sendToUser(targetUserId, 'group:banned', { groupId, reason, durationMs, timestamp: Date.now() }).catch(() => {});
    });

    socket.on('group:mute', data => {
      const { groupId, targetUserId, durationMs } = data || {};
      if (!groupId || !targetUserId) return;
      this._moderation.mute(groupId, targetUserId, durationMs);
      this._rooms.emitToGroup(groupId, 'group:mute', { groupId, targetUserId, durationMs, mutedBy: userId, timestamp: Date.now() });
    });

    socket.on('group:slow_mode', data => {
      const { groupId, intervalMs } = data || {};
      if (!groupId) return;
      this._rooms.emitToGroup(groupId, 'group:slow_mode', { groupId, intervalMs, timestamp: Date.now() });
    });

    socket.on('group:role_update', data => {
      const { groupId, targetUserId, role } = data || {};
      if (!groupId || !targetUserId) return;
      this._rooms.emitToGroup(groupId, 'group:role_update', { groupId, targetUserId, role, updatedBy: userId, timestamp: Date.now() });
      this._wsService.sendToUser(targetUserId, 'group:role_update', { groupId, role, timestamp: Date.now() }).catch(() => {});
    });

    // ── Group presence / typing ────────────────────────────────────────────

    socket.on('group:typing', data => {
      const { groupId, isTyping } = data || {};
      if (!groupId) return;
      this._rooms.emitToGroup(groupId, 'group:typing', { groupId, userId, isTyping: !!isTyping, timestamp: Date.now() }, socket.id);
    });

    socket.on('group:presence_subscribe', data => {
      const { groupId } = data || {};
      if (!groupId) return;
      this._rooms.joinRoom(socket, groupId);
    });

    // ── Story/status events ────────────────────────────────────────────────

    socket.on('status:view', async data => {
      const { storyId, ownerId } = data || {};
      if (!storyId || !ownerId) return;
      await this.broadcastStoryView(storyId, userId, ownerId);
    });

    socket.on('status:react', data => {
      const { storyId, ownerId, emoji } = data || {};
      if (!storyId || !ownerId) return;
      const payload = { storyId, userId, emoji, timestamp: Date.now() };
      this._wsService.sendToUser(ownerId, 'status:reaction', payload).catch(() => {});
      socket.emit('status:reaction_sent', { storyId, emoji });
    });

    socket.on('status:reply', data => {
      const { storyId, ownerId, text } = data || {};
      if (!storyId || !ownerId || !text) return;
      const payload = { storyId, userId, text, timestamp: Date.now() };
      this._wsService.sendToUser(ownerId, 'status:reply', payload).catch(() => {});
    });

    // ── Disconnect cleanup ─────────────────────────────────────────────────

    socket.on('disconnect', () => {
      this._rooms.removeSocket(socket.id);
    });
  }

  _findSocketsForUser(userId) {
    const result = [];
    for (const [sid, socket] of this._io.sockets.sockets || []) {
      const uid = socket.handshake?.auth?.userId || socket.data?.userId;
      if (uid && String(uid) === String(userId)) result.push(socket);
    }
    return result;
  }
}

module.exports = GroupStoryRealtimeService;
