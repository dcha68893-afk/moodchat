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
    if (!room) return { removed: false, newHostId: null };
    const wasHost = room.hostId === String(userId);
    room.participants.delete(String(userId));

    if (room.participants.size === 0) {
      this.endRoom(callId);
      return { removed: true, newHostId: null };
    }

    // FIX-ROOT-CAUSE-NO-HOST-TRANSFER: hostId was set once at room creation
    // and never touched again anywhere in this file. If the host left or
    // disconnected without explicitly calling group:call:end, every
    // remaining participant would permanently fail isHost() — no one could
    // ever end the call for everyone or mute/remove a participant again for
    // the rest of that call's lifetime. Promote the longest-standing
    // remaining participant (a stable, predictable choice — not random, not
    // "whoever happens to send the next action first") to host.
    let newHostId = null;
    if (wasHost) {
      let earliest = null;
      for (const p of room.participants.values()) {
        if (!earliest || p.joinedAt < earliest.joinedAt) earliest = p;
      }
      if (earliest) {
        room.hostId = earliest.userId;
        newHostId = earliest.userId;
      }
    }
    return { removed: true, newHostId };
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

  // FIX-STRUCTURED-LOGGING (Phase 13): the calling module's log lines were
  // plain strings via this._logger.warn/error (which defaults to bare
  // console) — no consistent timestamp/callId/userId/socketId/state fields,
  // making call-related incidents hard to correlate against each other or
  // against a client-side session. This wraps warn/error with a structured
  // second argument carrying exactly those fields, without changing the
  // human-readable message (so anything already grepping log text for
  // specific strings keeps working) or introducing a new logging
  // dependency. Scoped to the calling module per the audit's stated scope,
  // not a whole-app logging retrofit.
  _logCall(level, message, { callId = null, userId = null, socketId = null, state = null } = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      module:    'CallSignalingService',
      event:     message,
      callId:    callId,
      userId:    userId,
      socketId:  socketId,
      state:     state,
    };
    try {
      const fn = (this._logger && typeof this._logger[level] === 'function') ? this._logger[level] : console.log;
      fn.call(this._logger, `[CallSignaling] ${message}`, record);
    } catch (_) {}
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

    socket.removeAllListeners('call:initiate').on('call:initiate', async data => {
      try {
        const { targetUserId, callType, callId: existingId } = data || {};
        if (!targetUserId) return;

        // SEC-04 FIX: callerId must come from the authenticated socket session,
        // NOT from the client payload. Previously the code used
        // `data.callerId || userId` — a client could send any callerId and
        // impersonate another user as the caller. Now it's always `userId`
        // (set from socket.handshake.auth at connection time, which is
        // server-controlled). Downstream payloads are also forced to use
        // `callerId: userId` so spoofed callerId values in data are ignored.
        // Self-call guard added here too (the REST endpoint had it; the socket
        // path did not).
        if (String(targetUserId) === String(userId)) {
          socket.emit('call:error', { code: 'SELF_CALL', message: 'Cannot call yourself', timestamp: Date.now() });
          return;
        }

        // ── PRIVACY ENFORCEMENT: whoCanCallMe ────────────────────────────────
        // FIX: settings.calls.whoCanCallMe existed in the settings UI, was saved
        // to the DB, and was even propagated down to the client's own calls.html
        // page — but nothing anywhere, client or server, ever actually checked it
        // before letting a call ring through. This is the one server-side choke
        // point every real call passes through (the frontend always uses
        // socket 'call:initiate', not the REST /api/calls endpoints), so this is
        // the right place to enforce it — it can't be bypassed by a modified
        // client the way a client-only check could be.
        // Fails open on any lookup error so a DB hiccup never blocks a call that
        // should otherwise be allowed.
        try {
          const db = require('../../models');
          const UserModel = db.Users || db.User;
          if (UserModel) {
            const targetUser = await UserModel.findByPk(parseInt(targetUserId, 10), {
              attributes: ['id', 'settings'],
            });
            const whoCanCallMe = targetUser?.settings?.calls?.whoCanCallMe || 'everyone';

            if (whoCanCallMe === 'nobody') {
              socket.emit('call:error', {
                code: 'CALLS_RESTRICTED',
                message: 'This user is not accepting calls right now',
                timestamp: Date.now(),
              });
              return;
            }

            if (whoCanCallMe === 'friends') {
              const FriendModel = db.Friend;
              const friendship = FriendModel
                ? await FriendModel.getFriendship(parseInt(userId, 10), parseInt(targetUserId, 10))
                : null;
              if (!friendship || friendship.status !== 'accepted') {
                socket.emit('call:error', {
                  code: 'CALLS_RESTRICTED',
                  message: 'This user only accepts calls from friends',
                  timestamp: Date.now(),
                });
                return;
              }
            }
          }
        } catch (privacyErr) {
          console.warn('[CallSignaling] whoCanCallMe privacy check failed (failing open):', privacyErr.message);
        }

        // FIX: this dedup key was referenced below but never declared, so
        // `this._dedup.isDuplicate(key)` threw ReferenceError on every single
        // call:initiate event — caught by the outer try/catch, logged, and
        // the call was never actually created. That means the socket-based
        // call:initiate path (which the frontend's calls-core.js does use —
        // see its retry-wrapped safeSend('call:initiate', ...)) was silently
        // broken end to end. Declared using the same pattern as call:accept's
        // dedup key further below.
        const key = `initiate:${userId}:${targetUserId}`;

        // Check whether target is already in an active call (call-waiting signal)
        // We still CREATE the call record so it shows in history, but we flag it
        // immediately so the caller knows the callee is busy. The callee gets a
        // call:waiting notification rather than a full incoming-call ring, which
        // is how WhatsApp/Signal handle a second incoming call.
        let targetBusy = false;
        if (this._rooms) {
          for (const [_cid, room] of this._rooms._rooms) {
            if (room.active && room.participants.has(String(targetUserId))) {
              targetBusy = true;
              break;
            }
          }
        }

        if (targetBusy) {
          // FIX: `callId` isn't defined yet at this point in the handler (the
          // call record — and its id — isn't created until further down, via
          // `this.initiateCall(...)`), so this was also a ReferenceError,
          // just one that only fired in the narrower "target already busy"
          // case. Use the caller-supplied id if this is a retry of an
          // already-started attempt; otherwise there simply isn't one yet.
          socket.emit('call:busy', {
            callId:       existingId || null,
            targetUserId,
            message:      'User is currently in another call',
            timestamp:    Date.now(),
          });
          this._logger.log(`[CallSignaling] call:busy for uid=${targetUserId} called by uid=${userId}`);
          // Emit call:waiting to the callee so they can optionally accept/decline
          await this._wsService.sendToUser(targetUserId, 'call:waiting', {
            callId: existingId || null,
            callerId:  userId,
            callType:  callType || 'audio',
            timestamp: Date.now(),
          }).catch(() => {});
          return;
        }
        if (this._dedup.isDuplicate(key)) {
          this._logCall('warn', 'Duplicate call:initiate suppressed', { userId, socketId: socket.id });
          // C-09 FIX: previously this silently dropped the event with no
          // feedback, so the caller's UI stayed stuck on the outgoing screen
          // even though the call was refused. A legitimate "call back
          // immediately after they declined" within the 5-second window hits
          // this branch and the caller sees nothing. Now we emit
          // 'call:dedup_rejected' back to the caller's socket so the frontend
          // can show "Please wait a moment before calling again" and reset
          // the outgoing call UI to idle — the same way a normal rejection
          // would.
          socket.emit('call:dedup_rejected', {
            targetUserId,
            reason: 'rate_limited',
            retryAfterMs: this._dedup._windowMs,
            timestamp: Date.now(),
          });
          return;
        }

        // FIX-PHASE15: Resolve callerName from DB when frontend doesn't supply it.
        // This is the root cause of "user 1" appearing on the receiver's screen —
        // the frontend sometimes omits callerName in the socket event, so we
        // always look it up from the DB to guarantee the real name is sent.
        let resolvedCallerName = data.callerName || null;
        if (!resolvedCallerName) {
          try {
            const db = require('../../models');
            const UserModel = db.Users || db.User;
            if (UserModel) {
              const callerUser = await UserModel.findByPk(parseInt(userId, 10), {
                attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
              });
              if (callerUser) {
                const first = callerUser.firstName || '';
                const last  = callerUser.lastName  || '';
                resolvedCallerName = (first + (last ? ' ' + last : '')).trim() || callerUser.username || `User ${userId}`;
              }
            }
          } catch (lookupErr) {
            console.warn('[CallSignaling] callerName DB lookup failed:', lookupErr.message);
          }
        }

        const callId = await this.initiateCall(userId, targetUserId, {
          callId:     existingId,
          callType:   callType || 'audio',
          callerName: resolvedCallerName,
        });

        // FIX-CALLER-NAME-FLIP-REAL: call:initiated_ack (the confirmation sent
        // back to the CALLER) used to carry nothing but {callId, success} — no
        // name at all. The caller's UI shows the correct name from the local
        // contact list right when the call starts, then this ack arrives and
        // overwrites it with nothing usable, so it falls back to displaying
        // "user". Resolve the callee's display name the same way
        // resolvedCallerName is resolved above and include it here.
        let resolvedCalleeName = null;
        try {
          const db = require('../../models');
          const UserModel = db.Users || db.User;
          if (UserModel) {
            const calleeUser = await UserModel.findByPk(parseInt(targetUserId, 10), {
              attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
            });
            if (calleeUser) {
              const first = calleeUser.firstName || '';
              const last  = calleeUser.lastName  || '';
              resolvedCalleeName = (first + (last ? ' ' + last : '')).trim() || calleeUser.username || `User ${targetUserId}`;
            }
          }
        } catch (lookupErr) {
          console.warn('[CallSignaling] calleeName DB lookup failed:', lookupErr.message);
        }

        socket.emit('call:initiated_ack', {
          callId,
          success: true,
          calleeName: resolvedCalleeName,
          targetUserId,
        });

        // Join call room
        socket.join(`call:${callId}`);
        this._rooms.addParticipant(callId, userId, socket.id);

        // FIX-CALL-DIRECT: Also make sure target user joins their call room
        // so webrtc:signal events can be routed without relying on postMessage
        const targetSockets = await this._wsService.getSocketIdsForUser(targetUserId).catch(() => []);
        const io = this._io;
        if (io && targetSockets.length > 0) {
          for (const sid of targetSockets) {
            const s = io.sockets.sockets.get(sid);
            if (s) { s.join(`call:${callId}`); this._rooms.addParticipant(callId, targetUserId, sid); }
          }
          console.log(`[CallSignaling] ✅ Target uid=${targetUserId} pre-joined call:${callId}`);
        }
      } catch (err) {
        this._logCall('warn', `call:initiate error: ${err.message}`, { userId, socketId: socket.id });
      }
    });

    // ── FIX-CALL-DIRECT: webrtc:offer relay via Socket.IO (bypass postMessage) ─
    // FIX-SIGNALING-ACK (Phase 20): accept an optional Socket.IO ack callback
    // so the sender can know whether the offer was actually delivered and
    // retry if not, instead of firing-and-forgetting a message that could be
    // silently lost (e.g. the target's socket dropped a moment earlier and
    // hasn't been pruned yet). sendToUser() already tells us whether it
    // reached at least one of the target's live connections.
    socket.removeAllListeners('call:webrtc_offer').on('call:webrtc_offer', async ({ callId, targetUserId: tgt, offer } = {}, ack) => {
      if (!callId || !tgt || !offer) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'invalid_payload' });
        return;
      }
      // FIX-DUP-SIGNAL: previously this both sent directly to the target user
      // AND re-broadcast to the call room (which the target is also a member
      // of), so the target received the same offer twice. A second
      // setRemoteDescription('offer') call on an already-stable connection
      // throws InvalidStateError and can break the handshake. Deliver via a
      // single path only — sendToUser already fans out to all of the
      // target's connected devices/sockets.
      const delivered = await this._wsService.sendToUser(tgt, 'call:webrtc_offer', {
        callId, offer, callerId: userId, timestamp: Date.now(),
      }).catch(() => false);
      this._logCall('log', `webrtc:offer relayed for call ${callId}, delivered=${delivered}`, { callId, userId, socketId: socket.id });
      if (typeof ack === 'function') ack({ delivered: !!delivered });
    });

    // ── Call accept ──────────────────────────────────────────────────────────

    socket.removeAllListeners('call:accept').on('call:accept', async data => {
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

      // FEAT-02 FIX: Multi-device call dedup — when a user has two active
      // sockets (two browser tabs, phone + laptop, etc.) and accepts on one,
      // the other device still shows the incoming call ring UI indefinitely.
      // We emit 'call:accepted_elsewhere' to all OTHER sockets of this userId
      // so each can dismiss the incoming call UI without ending the call itself.
      // This mirrors how WhatsApp/Signal handle multi-device ring cancellation.
      await this._wsService.sendToUser(userId, 'call:accepted_elsewhere', {
        callId,
        acceptedBySocketId: socket.id,
        timestamp: Date.now(),
      }).catch(() => {});

      this._io.to(`call:${callId}`).emit('call:participant_joined', {
        callId, userId, timestamp: Date.now(),
      });

      this.emit('call:accepted', { callId, callerId, accepterId: userId });
      this._logger.log(`[CallSignaling] Call accepted: ${callId} by user ${userId}`);
    });

    // ── Call reject ──────────────────────────────────────────────────────────

    socket.removeAllListeners('call:reject').on('call:reject', async data => {
      const { callId, callerId, reason } = data || {};
      if (!callId || !callerId) return;

      await this._wsService.sendToUser(callerId, 'call:rejected', {
        callId, rejectedBy: userId, reason, timestamp: Date.now(),
      });

      this._rooms.endRoom(callId);
      this.emit('call:rejected', { callId, callerId, rejectedBy: userId });
    });

    // ── Call end ────────────────────────────────────────────────────────────

    socket.removeAllListeners('call:end').on('call:end', async data => {
      const { callId, reason } = data || {};
      if (!callId) return;

      const participants = this._rooms.getParticipants(callId);

      // FIX-DUP-SIGNAL: previously this both broadcast 'call:ended' to the
      // whole call room AND looped over participants sending it again via
      // sendToUser, so every other participant's client received two
      // call-ended events (harmless for UI state, but doubles socket
      // traffic and can race the room-cleanup teardown). Use a single
      // delivery path: sendToUser per participant, which also reaches
      // devices that may not currently hold a socket in the call room.
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

    socket.removeAllListeners('webrtc:signal').on('webrtc:signal', async data => {
      const { targetUserId, callId, type } = data || {};
      if (!targetUserId || !callId) return;

      // Validate participant
      const room = this._rooms.get(callId);
      if (room && !this._rooms.isParticipant(callId, userId) && !this._rooms.isParticipant(callId, targetUserId)) {
        return; // Not a participant in this call
      }

      const signalPayload = { ...data, senderId: userId, timestamp: Date.now() };

      // FIX-DUP-SIGNAL: only relay via the target's personal user-room.
      // The previous implementation ALSO broadcast to the call room
      // (`except(socket.id)`), and since the target's socket already joins
      // that room on call:initiate/call:accept, every offer/answer/ICE
      // candidate was delivered twice — causing duplicate
      // setRemoteDescription calls (InvalidStateError) and duplicate ICE
      // candidates, which manifested as calls failing to connect or audio
      // glitching mid-call.
      await this._wsService.sendToUser(targetUserId, 'webrtc:signal', signalPayload);
    });

    // ── Group call events ────────────────────────────────────────────────────

    socket.removeAllListeners('group:call:join').on('group:call:join', async data => {
      const { callId } = data || {};
      // FIX-ADHOC-GROUP-CALL: this previously required BOTH groupId and
      // callId and silently no-op'd otherwise. But the REST ad-hoc
      // group-call flow (POST /calls with isGroupCall:true + participantIds
      // — see callController.js / callService.initiateGroupCall) creates a
      // group call from a plain list of selected contacts with no chat
      // 'groupId' at all; it only ever has a callId. Requiring groupId made
      // it impossible for that flow's invited participants to ever join the
      // call room — 'group:call:join' would just silently return. groupId
      // is now optional and only used for display/analytics, not as a
      // join gate; callId is the actual room key.
      const groupId = data?.groupId || null;
      if (!callId) return;

      // SEC-03 FIX: previously the socket handler admitted any connected
      // socket to the signaling room with no authorization check. An
      // attacker who knew (or guessed) a callId could emit group:call:join
      // and receive all ICE candidates, SDP offers/answers and media tracks
      // for the call — equivalent to joining silently. Now we verify the
      // socket's userId is in the DB participants list for this call.
      // We only skip the check if the room doesn't exist yet (caller is
      // creating it for the first time).
      if (this._wsService?.db || global.__db) {
        try {
          const db   = this._wsService?.db || global.__db;
          const Call = db.Calls || db.Call;
          if (Call) {
            const call = await Call.findOne({
              where:      { id: callId },
              attributes: ['id', 'participants', 'callerId', 'isGroupCall'],
            }).catch(() => null);
            if (call) {
              const parts     = Array.isArray(call.participants) ? call.participants.map(String) : [];
              const isInvited = parts.includes(String(userId)) || String(call.callerId) === String(userId);
              if (!isInvited) {
                socket.emit('group:call:error', {
                  callId,
                  code:      'NOT_INVITED',
                  message:   'You are not a participant of this call',
                  timestamp: Date.now(),
                });
                this._logCall('warn', `SEC-03 blocked uid=${userId} from joining call ${callId}`, { callId, userId, socketId: socket.id });
                return;
              }
            }
          }
        } catch (_) { /* DB check failed — allow join as fallback */ }
      }

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

    socket.removeAllListeners('group:call:leave').on('group:call:leave', data => {
      const { groupId, callId } = data || {};
      if (!callId) return;

      socket.leave(`call:${callId}`);
      const { newHostId } = this._rooms.removeParticipant(callId, userId);

      this._io.to(`call:${callId}`).emit('group:call:participant_left', {
        callId, groupId, userId, timestamp: Date.now(),
      });

      if (newHostId) {
        this._io.to(`call:${callId}`).emit('group:call:host_changed', {
          callId, newHostId, reason: 'previous_host_left', timestamp: Date.now(),
        });
      }
    });

    // Participant state updates (mute, video, screen share)
    socket.removeAllListeners('group:call:participant_update').on('group:call:participant_update', data => {
      const { callId } = data || {};
      if (!callId) return;
      socket.to(`call:${callId}`).emit('group:call:participant_update', {
        ...data, userId, timestamp: Date.now(),
      });
    });

    // ── Host moderation: mute participant ────────────────────────────────────
    // H-02 FIX: these handlers were completely missing. The frontend had
    // 'group:call:mute_participant' and 'group:call:remove_participant' wired
    // to socket.emit() and registered in the event list (Round 3), but the
    // server never handled them — so the events arrived and were silently
    // dropped. Added here with isHost() authorization so only the call creator
    // can mute or remove other participants.
    socket.removeAllListeners('group:call:mute_participant').on('group:call:mute_participant', data => {
      const { callId, targetUserId: targetId, muted } = data || {};
      if (!callId || !targetId) return;

      // Authorization: only the host may mute others
      if (!this._rooms.isHost(callId, userId)) {
        socket.emit('group:call:error', {
          callId,
          code: 'NOT_HOST',
          message: 'Only the call host can mute participants',
          timestamp: Date.now(),
        });
        this._logCall('warn', `Non-host uid=${userId} tried to mute uid=${targetId} in call ${callId}`, { callId, userId, socketId: socket.id });
        return;
      }

      // Relay the mute command to the target participant via their user room
      this._wsService.sendToUser(targetId, 'group:call:muted_by_host', {
        callId,
        muted: !!muted,
        by: userId,
        timestamp: Date.now(),
      }).catch(() => {});

      // Notify all other participants so their UI reflects the change
      socket.to(`call:${callId}`).emit('group:call:participant_update', {
        callId,
        userId: targetId,
        muted: !!muted,
        mutedBy: userId,
        timestamp: Date.now(),
      });
    });

    // ── Host moderation: remove participant ──────────────────────────────────
    socket.removeAllListeners('group:call:remove_participant').on('group:call:remove_participant', data => {
      const { callId, targetUserId: targetId } = data || {};
      if (!callId || !targetId) return;

      // Authorization: only the host may remove others
      if (!this._rooms.isHost(callId, userId)) {
        socket.emit('group:call:error', {
          callId,
          code: 'NOT_HOST',
          message: 'Only the call host can remove participants',
          timestamp: Date.now(),
        });
        this._logCall('warn', `Non-host uid=${userId} tried to remove uid=${targetId} from call ${callId}`, { callId, userId, socketId: socket.id });
        return;
      }

      // Remove from room state so they don't receive further call events
      this._rooms.removeParticipant(callId, targetId);

      // Tell the target they've been removed
      this._wsService.sendToUser(targetId, 'group:call:removed_by_host', {
        callId,
        by: userId,
        timestamp: Date.now(),
      }).catch(() => {});

      // Notify remaining participants
      this._io.to(`call:${callId}`).emit('group:call:participant_left', {
        callId,
        userId: targetId,
        reason: 'removed_by_host',
        timestamp: Date.now(),
      });
    });

    // ── Host moderation: end call for everyone ────────────────────────────────
    // In a group call, any participant may leave on their own (group:call:leave
    // above just removes them). But ending the call for *every* participant is
    // a host-only action — otherwise any single participant tapping "End" would
    // terminate the call for the whole group. Mirrors the isHost() authorization
    // already used for mute/remove.
    socket.removeAllListeners('group:call:end').on('group:call:end', data => {
      const { callId, reason } = data || {};
      if (!callId) return;

      if (!this._rooms.isHost(callId, userId)) {
        socket.emit('group:call:error', {
          callId,
          code: 'NOT_HOST',
          message: 'Only the call host can end the call for everyone',
          timestamp: Date.now(),
        });
        this._logCall('warn', `Non-host uid=${userId} tried to end call ${callId} for everyone`, { callId, userId, socketId: socket.id });
        return;
      }

      // Tell every other participant the host ended the call, so their
      // clients can tear down and leave without needing their own signal.
      socket.to(`call:${callId}`).emit('group:call:ended_by_host', {
        callId,
        by: userId,
        reason: reason || 'host_ended',
        timestamp: Date.now(),
      });

      this._rooms.endRoom(callId);
    });

    // ── Hand raise / lower ───────────────────────────────────────────────────
    socket.removeAllListeners('group:call:hand_raised').on('group:call:hand_raised', data => {
      const { callId } = data || {};
      if (!callId) return;
      socket.to(`call:${callId}`).emit('group:call:hand_raised', {
        callId, userId, timestamp: Date.now(),
      });
    });

    socket.removeAllListeners('group:call:lower_hand').on('group:call:lower_hand', data => {
      const { callId } = data || {};
      if (!callId) return;
      socket.to(`call:${callId}`).emit('group:call:hand_lowered', {
        callId, userId, timestamp: Date.now(),
      });
    });

    // ── Scheduled call routes ────────────────────────────────────────────────

    socket.removeAllListeners('scheduled_call:create').on('scheduled_call:create', data => {
      const entry = this._scheduler.schedule({ ...data, hostId: userId });
      socket.emit('scheduled_call:created', { scheduleId: entry.id, ...entry });
    });

    socket.removeAllListeners('scheduled_call:cancel').on('scheduled_call:cancel', data => {
      const ok = this._scheduler.cancel(data?.scheduleId);
      socket.emit('scheduled_call:cancelled', { scheduleId: data?.scheduleId, success: ok });
    });

    // ── ICE restart relay ────────────────────────────────────────────────────

    socket.removeAllListeners('call:reconnect').on('call:reconnect', async data => {
      const { callId, peerId } = data || {};
      if (!callId || !peerId) return;
      await this._wsService.sendToUser(peerId, 'call:reconnect', {
        callId, fromUserId: userId, timestamp: Date.now(),
      });
    });

    // ── Disconnect cleanup ───────────────────────────────────────────────────


    // ── In-call chat ─────────────────────────────────────────────────────────
    // Relay chat messages to all other participants in the call.
    // FIX: this event was emitted by calls-core.js sendChatMessage() but had
    // no server handler — messages were silently dropped and never reached
    // any other participant. Added relay here via the call room.
    socket.removeAllListeners('call:chat_message').on('call:chat_message', data => {
      const { callId, message, timestamp, senderId } = data || {};
      if (!callId || !message) return;
      if (!this._rooms.isParticipant(callId, userId)) {
        socket.emit('call:error', { code: 'NOT_IN_CALL', callId });
        return;
      }
      const payload = {
        callId,
        message:   String(message).slice(0, 2000), // 2k char limit
        senderId:  userId, // always use server-authoritative userId, ignore client senderId
        timestamp: timestamp || Date.now(),
      };
      // Broadcast to all other participants in the call
      this._io.to(`call:${callId}`).except(socket.id).emit('call:chat_message', payload);
      // Echo back to sender with server timestamp for ordering
      socket.emit('call:chat_message_ack', { ...payload, ack: true });
      this._logger.log(`[CallSignaling] Chat in call ${callId} from uid=${userId}`);
    });

    // ── Screen share notification ─────────────────────────────────────────────
    // Notify all other participants that someone started or stopped screen sharing.
    // FIX: screen share track was sent via WebRTC (replaceTrack) but remote
    // participants had no way to know it was a screen share vs a camera — they
    // needed to switch their UI from avatar view to full-screen display.
    socket.removeAllListeners('call:screen_share_started').on('call:screen_share_started', data => {
      const { callId } = data || {};
      if (!callId || !this._rooms.isParticipant(callId, userId)) return;
      this._io.to(`call:${callId}`).except(socket.id).emit('call:screen_share_started', {
        callId, userId, timestamp: Date.now(),
      });
      this._logger.log(`[CallSignaling] Screen share started by uid=${userId} in call ${callId}`);
    });

    socket.removeAllListeners('call:screen_share_stopped').on('call:screen_share_stopped', data => {
      const { callId } = data || {};
      if (!callId || !this._rooms.isParticipant(callId, userId)) return;
      this._io.to(`call:${callId}`).except(socket.id).emit('call:screen_share_stopped', {
        callId, userId, timestamp: Date.now(),
      });
    });
    // FIX-DISCONNECT-COLLISION: was removeAllListeners('call:heartbeat'), which
    // destroyed webSocketService's cross-peer heartbeat relay registered
    // earlier on the same socket. Guard on a private flag so both this
    // ack/room-bookkeeping handler and webSocketService's relay can coexist.
    if (!socket.__callSignalHeartbeatBound) {
      socket.__callSignalHeartbeatBound = true;
      socket.on('call:heartbeat', data => {
        const { callId } = data || {};
        if (!callId) return;
        if (this._rooms.isParticipant(callId, userId)) {
          socket.emit('call:heartbeat_ack', { callId, ts: Date.now() });
          const room = this._rooms.get(callId);
          if (room) { const p = room.participants.get(String(userId)); if (p) p.lastHeartbeat = Date.now(); }
        }
      });
    }

    // ── Presence ─────────────────────────────────────────────────────────────
    socket.removeAllListeners('call:presence').on('call:presence', async data => {
      const { targetUserId: target, status } = data || {};
      if (!target || !status) return;
      await this._wsService.sendToUser(target, 'call:presence_update', {
        fromUserId: userId, status, timestamp: Date.now(),
      }).catch(() => {});
    });

    // ── Offline recovery resync ───────────────────────────────────────────────
    socket.removeAllListeners('call:resync').on('call:resync', data => {
      const { callId } = data || {};
      if (!callId || !this._rooms.isParticipant(callId, userId)) return;
      socket.emit('call:resync_response', {
        callId, participants: this._rooms.getParticipants(callId),
        roomState: { active: this._rooms.get(callId)?.active }, timestamp: Date.now(),
      });
    });

    socket.on('disconnect', () => {
      // Find any calls this user was in and notify participants
      for (const [callId, room] of this._rooms._rooms) {
        if (room.participants.has(String(userId))) {
          const { newHostId } = this._rooms.removeParticipant(callId, userId);
          this._io.to(`call:${callId}`).emit('call:participant_left', {
            callId, userId, reason: 'disconnected', timestamp: Date.now(),
          });
          if (newHostId) {
            this._io.to(`call:${callId}`).emit('group:call:host_changed', {
              callId, newHostId, reason: 'previous_host_disconnected', timestamp: Date.now(),
            });
          }
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
