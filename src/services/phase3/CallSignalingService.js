/**
 * CallSignalingService.js (Backend)
 * Phase 3 — Call Signaling Engine
 *
 * Integrates with the EXISTING webSocketService.js:
 *  - Uses wsService.sendToUser() / wsService.sendSignal() (already defined)
 *  - Adds normalized call events + deduplication on top
 *  - Room-based group call signaling
 *  - LAN peer signaling coordination
 *  - TURN credential generation
 *  - Scheduled call management
 *
 * DOES NOT replace webSocketService — wraps and extends it.
 *
 * @version 3.0.0
 * @phase 3 — Call Signaling
 */

'use strict';

const EventEmitter = require('events');
const crypto       = require('crypto');

// ─── Call Room Registry ───────────────────────────────────────────────────────

class CallRoomRegistry {
  constructor() {
    // callId → { callId, callType, hostId, participants: Map<userId, state>, createdAt, expiresAt }
    this._rooms   = new Map();
    this._expiry  = 4 * 60 * 60 * 1000; // 4h max call
    setInterval(() => this._pruneExpired(), 5 * 60 * 1000);
  }

  create(callId, callType, hostId) {
    const room = {
      callId,
      callType:     callType || 'audio',
      hostId:       String(hostId),
      participants: new Map(),
      createdAt:    Date.now(),
      expiresAt:    Date.now() + this._expiry,
      active:       true,
    };
    this._rooms.set(callId, room);
    return room;
  }

  get(callId)      { return this._rooms.get(callId) || null; }
  has(callId)      { return this._rooms.has(callId); }

  addParticipant(callId, userId, socketId) {
    const room = this._rooms.get(callId);
    if (!room) return false;
    room.participants.set(String(userId), { userId: String(userId), socketId, joinedAt: Date.now() });
    return true;
  }

  removeParticipant(callId, userId) {
    const room = this._rooms.get(callId);
    if (!room) return;
    room.participants.delete(String(userId));
    if (room.participants.size === 0) this.endRoom(callId);
  }

  endRoom(callId) {
    const room = this._rooms.get(callId);
    if (room) { room.active = false; }
    setTimeout(() => this._rooms.delete(callId), 30000);
  }

  getParticipants(callId) {
    const room = this._rooms.get(callId);
    return room ? Array.from(room.participants.values()) : [];
  }

  isParticipant(callId, userId) {
    return this._rooms.get(callId)?.participants.has(String(userId)) || false;
  }

  isHost(callId, userId) {
    return this._rooms.get(callId)?.hostId === String(userId);
  }

  _pruneExpired() {
    const now = Date.now();
    for (const [id, room] of this._rooms) {
      if (room.expiresAt < now) this._rooms.delete(id);
    }
  }

  snapshot() {
    return {
      total:  this._rooms.size,
      active: Array.from(this._rooms.values()).filter(r => r.active).length,
    };
  }
}

// ─── SignalDeduplicator ───────────────────────────────────────────────────────

class SignalDeduplicator {
  constructor() {
    this._seen    = new Map();
    this._windowMs = 5000;
  }

  isDuplicate(key) {
    const now  = Date.now();
    const last = this._seen.get(key);
    for (const [k, ts] of this._seen) {
      if (now - ts > this._windowMs) this._seen.delete(k);
    }
    if (last && now - last < this._windowMs) return true;
    this._seen.set(key, now);
    return false;
  }
}

// ─── TURNCredentialManager ────────────────────────────────────────────────────

class TURNCredentialManager {
  constructor() {
    this._secret = process.env.TURN_SECRET || null;
    this._host   = process.env.TURN_HOST   || null;
    this._port   = process.env.TURN_PORT   || '3478';
  }

  isConfigured() { return !!(this._secret && this._host); }

  generateCredentials(userId) {
    if (!this.isConfigured()) return null;
    const ttl      = 86400; // 24h
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
    const password = crypto.createHmac('sha1', this._secret).update(username).digest('base64');

    return [{
      urls:       [`turn:${this._host}:${this._port}`, `turns:${this._host}:${this._port}`],
      username,
      credential: password,
    }];
  }

  getSTUNServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
  }
}

// ─── ScheduledCallManager ─────────────────────────────────────────────────────

class ScheduledCallManager {
  constructor(wsService) {
    this._wsService  = wsService;
    this._scheduled  = new Map(); // scheduleId → { participants, startTime, callId, timer }
  }

  schedule(scheduleData) {
    const id = 'sched_' + crypto.randomBytes(6).toString('hex');
    const { participants, startTime, callType, title, hostId } = scheduleData;

    const entry = { id, participants, startTime, callType, title, hostId, callId: null };
    this._scheduled.set(id, entry);

    const delay = startTime - Date.now();
    if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
      // Send reminder 5 min before
      const reminderDelay = delay - 5 * 60 * 1000;
      if (reminderDelay > 0) {
        entry.reminderTimer = setTimeout(() => this._sendReminder(entry), reminderDelay);
      }
      // Notify at call time
      entry.timer = setTimeout(() => this._notifyCallTime(entry), delay);
    }

    return entry;
  }

  cancel(scheduleId) {
    const entry = this._scheduled.get(scheduleId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.reminderTimer) clearTimeout(entry.reminderTimer);
    this._scheduled.delete(scheduleId);
    return true;
  }

  getAll(userId) {
    return Array.from(this._scheduled.values())
      .filter(e => e.hostId === String(userId) || (e.participants || []).includes(String(userId)));
  }

  async _sendReminder(entry) {
    const payload = {
      type:       'scheduled_call:reminder',
      scheduleId: entry.id,
      title:      entry.title,
      startTime:  entry.startTime,
      callType:   entry.callType,
      startsIn:   5,
    };
    for (const uid of [entry.hostId, ...(entry.participants || [])]) {
      await this._wsService.sendToUser(uid, 'scheduled_call:reminder', payload).catch(() => {});
    }
  }

  async _notifyCallTime(entry) {
    const callId = 'sched_call_' + entry.id;
    entry.callId = callId;

    const payload = {
      type:       'scheduled_call:starting',
      scheduleId: entry.id,
      callId,
      title:      entry.title,
      callType:   entry.callType,
    };
    for (const uid of [entry.hostId, ...(entry.participants || [])]) {
      await this._wsService.sendToUser(uid, 'scheduled_call:starting', payload).catch(() => {});
    }
  }
}

// ─── CallSignalingService (main) ──────────────────────────────────────────────

class CallSignalingService extends EventEmitter {
  constructor(io, wsService, options = {}) {
    super();
    this._io          = io;
    this._wsService   = wsService;  // existing webSocketService instance
    this._logger      = options.logger || console;
    this._rooms       = new CallRoomRegistry();
    this._dedup       = new SignalDeduplicator();
    this._turn        = new TURNCredentialManager();
    this._scheduler   = new ScheduledCallManager(wsService);
    this._attached    = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', socket => this._onConnection(socket));

    this._logger.log('[CallSignaling:Server] ✅ Attached');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async initiateCall(callerId, targetUserId, callData = {}) {
    const callId = callData.callId || 'call_' + crypto.randomBytes(8).toString('hex');
    const room   = this._rooms.create(callId, callData.callType || 'audio', callerId);

    this._rooms.addParticipant(callId, callerId, null);

    // Push TURN credentials to caller
    this._pushTURNConfig(callerId);

    // Notify target via existing wsService.notifyCallInitiated()
    await this._wsService.notifyCallInitiated(targetUserId, {
      callId,
      callerId:  String(callerId),
      callType:  callData.callType || 'audio',
      callerName: callData.callerName || null,
      timestamp: Date.now(),
    });

    this._logger.log(`[CallSignaling] Call initiated: ${callId} ${callerId}→${targetUserId}`);
    this.emit('call:initiated', { callId, callerId, targetUserId });
    return callId;
  }

  scheduleCall(data) { return this._scheduler.schedule(data); }
  cancelScheduled(id) { return this._scheduler.cancel(id); }
  getScheduled(userId) { return this._scheduler.getAll(userId); }

  getDiagnostics() {
    return {
      rooms:       this._rooms.snapshot(),
      turnEnabled: this._turn.isConfigured(),
      scheduled:   this._scheduler._scheduled.size,
    };
  }

  // ── Private — Socket handlers ──────────────────────────────────────────────

  _onConnection(socket) {
    const userId = socket.handshake?.auth?.userId || socket.data?.userId || null;
    if (!userId) return;

    // ── Call initiation ──────────────────────────────────────────────────────

    socket.off('call:initiate').on('call:initiate', async data => {
      try {
        const { targetUserId, callType, callId: existingId } = data || {};
        if (!targetUserId) return;

        const key = `initiate:${userId}:${targetUserId}`;
        if (this._dedup.isDuplicate(key)) {
          this._logger.warn('[CallSignaling] Duplicate call:initiate suppressed');
          return;
        }

        const callId = await this.initiateCall(userId, targetUserId, {
          callId:     existingId,
          callType:   callType || 'audio',
          callerName: data.callerName,
        });

        socket.emit('call:initiated_ack', { callId, success: true });

        // Join call room
        socket.join(`call:${callId}`);
        this._rooms.addParticipant(callId, userId, socket.id);
      } catch (err) {
        this._logger.warn('[CallSignaling] call:initiate error:', err.message);
      }
    });

    // ── Call accept ──────────────────────────────────────────────────────────

    socket.off('call:accept').on('call:accept', async data => {
      const { callId, callerId } = data || {};
      if (!callId || !callerId) return;

      const key = `accept:${userId}:${callId}`;
      if (this._dedup.isDuplicate(key)) return;

      socket.join(`call:${callId}`);
      this._rooms.addParticipant(callId, userId, socket.id);
      this._pushTURNConfig(userId);

      await this._wsService.sendToUser(callerId, 'call:accepted', {
        callId, accepterId: userId, timestamp: Date.now(),
      });

      this._io.to(`call:${callId}`).emit('call:participant_joined', {
        callId, userId, timestamp: Date.now(),
      });

      this.emit('call:accepted', { callId, callerId, accepterId: userId });
      this._logger.log(`[CallSignaling] Call accepted: ${callId} by user ${userId}`);
    });

    // ── Call reject ──────────────────────────────────────────────────────────

    socket.off('call:reject').on('call:reject', async data => {
      const { callId, callerId, reason } = data || {};
      if (!callId || !callerId) return;

      await this._wsService.sendToUser(callerId, 'call:rejected', {
        callId, rejectedBy: userId, reason, timestamp: Date.now(),
      });

      this._rooms.endRoom(callId);
      this.emit('call:rejected', { callId, callerId, rejectedBy: userId });
    });

    // ── Call end ────────────────────────────────────────────────────────────

    socket.off('call:end').on('call:end', async data => {
      const { callId, reason } = data || {};
      if (!callId) return;

      const participants = this._rooms.getParticipants(callId);

      this._io.to(`call:${callId}`).emit('call:ended', {
        callId, endedBy: userId, reason, timestamp: Date.now(),
      });

      // Notify all participants via user rooms too
      for (const p of participants) {
        if (String(p.userId) !== String(userId)) {
          await this._wsService.sendToUser(p.userId, 'call:ended', {
            callId, endedBy: userId, reason, timestamp: Date.now(),
          }).catch(() => {});
        }
      }

      socket.leave(`call:${callId}`);
      this._rooms.endRoom(callId);
      this.emit('call:ended', { callId, endedBy: userId, reason });
      this._logger.log(`[CallSignaling] Call ended: ${callId} by user ${userId}`);
    });

    // ── WebRTC signal relay ──────────────────────────────────────────────────

    socket.off('webrtc:signal').on('webrtc:signal', async data => {
      const { targetUserId, callId, type } = data || {};
      if (!targetUserId || !callId) return;

      // Validate participant
      const room = this._rooms.get(callId);
      if (room && !this._rooms.isParticipant(callId, userId) && !this._rooms.isParticipant(callId, targetUserId)) {
        return; // Not a participant in this call
      }

      const signalPayload = { ...data, senderId: userId, timestamp: Date.now() };

      // Relay via user room (existing approach) + call room
      await this._wsService.sendToUser(targetUserId, 'webrtc:signal', signalPayload);
      this._io.to(`call:${callId}`).except(socket.id).emit('webrtc:signal', signalPayload);
    });

    // ── Group call events ────────────────────────────────────────────────────

    socket.off('group:call:join').on('group:call:join', async data => {
      const { groupId, callId } = data || {};
      if (!groupId || !callId) return;

      if (!this._rooms.has(callId)) {
        this._rooms.create(callId, data.callType || 'group', userId);
      }
      socket.join(`call:${callId}`);
      this._rooms.addParticipant(callId, userId, socket.id);
      this._pushTURNConfig(userId);

      // Notify existing participants
      socket.to(`call:${callId}`).emit('group:call:participant_joined', {
        callId, groupId, userId, displayName: data.displayName, timestamp: Date.now(),
      });

      // Send current participants list to new joiner
      const existing = this._rooms.getParticipants(callId)
        .filter(p => String(p.userId) !== String(userId));
      socket.emit('group:call:current_participants', { callId, participants: existing });
    });

    socket.off('group:call:leave').on('group:call:leave', data => {
      const { groupId, callId } = data || {};
      if (!callId) return;

      socket.leave(`call:${callId}`);
      this._rooms.removeParticipant(callId, userId);

      this._io.to(`call:${callId}`).emit('group:call:participant_left', {
        callId, groupId, userId, timestamp: Date.now(),
      });
    });

    // Participant state updates (mute, video, screen share)
    socket.off('group:call:participant_update').on('group:call:participant_update', data => {
      const { callId } = data || {};
      if (!callId) return;
      socket.to(`call:${callId}`).emit('group:call:participant_update', {
        ...data, userId, timestamp: Date.now(),
      });
    });

    // ── Scheduled call routes ────────────────────────────────────────────────

    socket.off('scheduled_call:create').on('scheduled_call:create', data => {
      const entry = this._scheduler.schedule({ ...data, hostId: userId });
      socket.emit('scheduled_call:created', { scheduleId: entry.id, ...entry });
    });

    socket.off('scheduled_call:cancel').on('scheduled_call:cancel', data => {
      const ok = this._scheduler.cancel(data?.scheduleId);
      socket.emit('scheduled_call:cancelled', { scheduleId: data?.scheduleId, success: ok });
    });

    // ── ICE restart relay ────────────────────────────────────────────────────

    socket.off('call:reconnect').on('call:reconnect', async data => {
      const { callId, peerId } = data || {};
      if (!callId || !peerId) return;
      await this._wsService.sendToUser(peerId, 'call:reconnect', {
        callId, fromUserId: userId, timestamp: Date.now(),
      });
    });

    // ── Disconnect cleanup ───────────────────────────────────────────────────

    socket.on('disconnect', () => {
      // Find any calls this user was in and notify participants
      for (const [callId, room] of this._rooms._rooms) {
        if (room.participants.has(String(userId))) {
          room.participants.delete(String(userId));
          this._io.to(`call:${callId}`).emit('call:participant_left', {
            callId, userId, reason: 'disconnected', timestamp: Date.now(),
          });
          if (room.participants.size === 0) this._rooms.endRoom(callId);
        }
      }
    });
  }

  async _pushTURNConfig(userId) {
    if (!this._turn.isConfigured()) return;
    const creds   = this._turn.generateCredentials(userId);
    const servers = [...this._turn.getSTUNServers(), ...(creds || [])];
    await this._wsService.sendToUser(userId, 'turn:config', { servers }).catch(() => {});
  }
}

module.exports = CallSignalingService;
