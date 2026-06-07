/**
 * callService.js — Sequelize/PostgreSQL call service
 * FIXED VERSION — patches:
 *  1. answerCall: was checking startedAt (null) for timeout instead of createdAt/metadata.ringStartedAt
 *  2. FIX-003: All WS emits now use ONE canonical colon-style event name (call:xxx only)
 *     so calls-core.js socket listeners get them regardless of naming convention.
 *  3. getCallDetails(callId) — accepts 1-arg form used by callController.getCallDetails
 *  4. _forceCleanupStaleCallsForUsers — emits 'call_force_ended' + 'CALL_FORCE_ENDED' (postMessage)
 *  5. isUserOnline check deferred to wsService so it can't crash on undefined
 */

'use strict';

const { Op } = require('sequelize');
const db      = require('../models');
const Call    = db.Calls || db.Call;
const User    = db.Users || db.User;
const Chat    = db.Chats || db.Chat;

const MAX_CALL_DURATION           = parseInt(process.env.MAX_CALL_DURATION)           || 3600;
const CALL_TIMEOUT_SECONDS        = parseInt(process.env.CALL_TIMEOUT_SECONDS)        || 120;
const MAX_GROUP_CALL_PARTICIPANTS = parseInt(process.env.MAX_GROUP_CALL_PARTICIPANTS)  || 10;

// Lazy-require helper — avoids circular dependency at startup
let _wsService = null;
function ws() {
  if (!_wsService) {
    try { _wsService = require('./webSocketService'); } catch (_) {}
  }
  return _wsService;
}

// FIX-003: Emit ONE canonical colon-style event per participant.
// Previous triple-emit (call:ended + call_ended + original) caused:
//   - Phone ringing twice (two call:incoming events)
//   - Black screen on 2nd call (UI destroyed twice by two call:ended events)
//   - ICE candidate handlers firing twice → broken peer connection
// Frontend calls-core.js must listen for colon-style events only.
function _normalizeCallEvent(event) {
  if (!event) return event;
  if (event.includes(':')) return event;
  if (event.startsWith('call_')) return 'call:' + event.slice(5);
  return event;
}

async function emitToAll(participants, event, data) {
  const wsService = ws();
  const colonEvent     = _normalizeCallEvent(event);                          // e.g. call:accepted
  const underscoreEvent = colonEvent.replace(/:/g, '_');                      // e.g. call_accepted
  const resolvedIo = global.__socketIO || (wsService && wsService.getIO && wsService.getIO()) || null;

  if (!resolvedIo && !wsService) {
    console.warn(`[CallService] emitToAll: no delivery channel for event=${colonEvent}`);
    return false;
  }

  // Build deduplicated set of event names to emit (both colon and underscore forms)
  const eventNames = [...new Set([colonEvent, underscoreEvent, event])].filter(Boolean);

  let delivered = false;
  for (const participant of participants) {
    const uid = typeof participant === 'object' ? (participant.id || participant.userId) : participant;
    if (!uid) continue;
    const uidInt = parseInt(uid, 10);
    const uidStr = String(uidInt);

    if (resolvedIo) {
      try {
        const rooms = [`user:${uidInt}`, `user_${uidInt}`, `user:${uidStr}`, `user_${uidStr}`];
        for (const evName of eventNames) {
          for (const room of rooms) {
            resolvedIo.to(room).emit(evName, data);
          }
        }
        console.log(`[CallService] emitToAll: [${eventNames.join('|')}] → uid:${uidInt}`);
        delivered = true;
      } catch (e) {
        console.warn(`[CallService] emit error uid=${uidInt}:`, e.message);
      }
    } else if (wsService && typeof wsService.sendToUser === 'function') {
      for (const evName of eventNames) {
        try { await wsService.sendToUser(uidInt, evName, data); delivered = true; } catch (_) {}
      }
    }
  }
  return delivered;
}

// ─────────────────────────────────────────────────────────────────────────────

class CallService {

  // ── _buildIncludes ──────────────────────────────────────────────────────────
  _buildIncludes() {
    const includes = [];
    try {
      if (Call.associations && Call.associations.callInitiatorUser) {
        includes.push({ model: User, as: 'callInitiatorUser', attributes: ['id', 'username', 'avatar', 'email'] });
      }
      if (Call.associations && Call.associations.callTargetUser) {
        includes.push({ model: User, as: 'callTargetUser', attributes: ['id', 'username', 'avatar', 'email'] });
      }
    } catch (_) {}
    return includes;
  }

  // ── initiateCall ────────────────────────────────────────────────────────────
  async initiateCall(callerId, calleeId, callType = 'audio', chatId = null) {
    // CRITICAL SECURITY: Validate all required fields
    if (!callerId || !calleeId) throw new Error('callerId and calleeId are required');
    if (callerId === undefined || callerId === null || calleeId === undefined || calleeId === null) {
      throw new Error('Invalid callerId or calleeId - undefined/null not allowed');
    }
    if (!['audio', 'video'].includes(callType)) throw new Error('Invalid call type');
    
    // ── FORENSIC LOG: CALL_START ──────────────────────────────────────────────
    console.log(`[FORENSIC] CALL_START | callerId=${callerId} | calleeId=${calleeId} | type=${callType} | ts=${Date.now()}`);
    
    // CRITICAL SECURITY: Prevent self-calls
    if (callerId === calleeId) {
      throw new Error('Cannot call yourself');
    }

    const [caller, callee] = await Promise.all([
      User.findByPk(parseInt(callerId), { attributes: ['id', 'username', 'avatar', 'email'] }),
      User.findByPk(parseInt(calleeId), { attributes: ['id', 'username', 'avatar', 'email'] }),
    ]);
    if (!caller) throw new Error('Caller not found');
    if (!callee) throw new Error('Callee not found');

    // Auto-cleanup stale calls for both parties first — runs before busy-check
    await this._forceCleanupStaleCallsForUsers([parseInt(callerId), parseInt(calleeId)]);

    // Check callee not already in a GENUINE in-progress call
    // We only block if the call is actively in-progress AND recent (< CALL_TIMEOUT_SECONDS)
    const activeCall = await Call.findOne({
      where: {
        participants: { [Op.contains]: [parseInt(calleeId)] },
        status:       { [Op.in]: ['ringing', 'initiated', 'in-progress'] },
      },
      order: [['createdAt', 'DESC']],  // most recent first
    });
    if (activeCall) {
      const callAge = (Date.now() - new Date(activeCall.createdAt).getTime()) / 1000;
      // Force-clean any call older than CALL_TIMEOUT_SECONDS regardless of status
      if (callAge >= CALL_TIMEOUT_SECONDS) {
        const wasAnswered = activeCall.answeredBy && activeCall.answeredBy.length > 0;
        await activeCall.update({ status: wasAnswered ? 'completed' : 'missed', endedAt: new Date() });
        await emitToAll(activeCall.participants || [], 'call_force_ended', {
          callId: activeCall.id, reason: 'timeout_on_new_call', timestamp: new Date()
        });
        console.log(`[CallService] Auto-cleaned stale blocking call ${activeCall.id} (age=${Math.round(callAge)}s)`);
      } else if (activeCall.status === 'in-progress') {
        // Only block if callee is genuinely IN a live call (not just ringing)
        throw new Error('Callee is already in an active call');
      } else {
        // status is 'ringing' or 'initiated' and < timeout — cancel the old one to allow new call
        await activeCall.update({ status: 'cancelled', endedAt: new Date() });
        await emitToAll(activeCall.participants || [], 'call_force_ended', {
          callId: activeCall.id, reason: 'replaced_by_new_call', timestamp: new Date()
        });
        console.log(`[CallService] Cancelled old ringing call ${activeCall.id} to allow new call`);
      }
    }

    const allParticipants = [parseInt(callerId), parseInt(calleeId)];

    const call = await Call.create({
      callerId:     parseInt(callerId),
      receiverId:   parseInt(calleeId),
      chatId:       chatId ? parseInt(chatId) : null,
      type:         callType,
      status:       'ringing',
      isGroupCall:  false,
      participants: allParticipants,
      answeredBy:   [],
      declinedBy:   [],
      readBy:       [],
      startedAt:    null,
      metadata:     { ringStartedAt: new Date().toISOString() },
    });

    // ✅ FIX: Emit call:incoming to callee NOW — this was completely missing and is why
    // receivers never saw incoming calls.  Also emit to caller as confirmation.
    const formatted = this._format(call, caller, callee);
    // ── FIX: callerName / callerAvatar MUST be top-level for calls-ui.js
    //    AND callType alias added (frontend checks callType not type)
    const callerDisplayName = (caller.firstName
      ? `${caller.firstName}${caller.lastName ? ' ' + caller.lastName : ''}`.trim()
      : null) || caller.username || 'Unknown';
    const callPayload = {
      callId:       call.id,
      callerId:     parseInt(callerId),
      receiverId:   parseInt(calleeId),
      callType:     callType,   // ← alias: UI checks callType
      type:         callType,
      status:       'ringing',
      callerName:   callerDisplayName,     // ← top-level critical for UI
      callerAvatar: caller.avatar || null, // ← top-level critical for UI
      caller:       { id: caller.id, username: caller.username, avatar: caller.avatar, displayName: callerDisplayName },
      callee:       { id: callee.id, username: callee.username, avatar: callee.avatar },
      chatId:       call.chatId,
      isGroupCall:  false,
      timestamp:    Date.now(),
    };

    const svc = ws();
    if (svc) {
      // ── FORENSIC LOG: CALL_SIGNAL_SENT ──────────────────────────────────────
      console.log(`[FORENSIC] CALL_SIGNAL_SENT | callId=${call.id} | callerId=${callerId} | calleeId=${calleeId} | events=[call:incoming,incoming_call,call_incoming] | ts=${Date.now()}`);
      // Primary: all naming variants to callee
      await svc.sendToUser(parseInt(calleeId), 'call:incoming',  callPayload);
      await svc.sendToUser(parseInt(calleeId), 'incoming_call',  callPayload);
      await svc.sendToUser(parseInt(calleeId), 'call_incoming',  callPayload);
      console.log(`[FORENSIC] CALL_SIGNAL_SENT complete | calleeId=${calleeId} | ts=${Date.now()}`);
      // Confirmation to caller
      await svc.sendToUser(parseInt(callerId), 'call:initiated', callPayload);
      await svc.sendToUser(parseInt(callerId), 'call_initiated', callPayload);
      console.log(`[CallService] ✅ EMITTED call:initiated to caller ${callerId}`);
    } else {
      console.warn('[CallService] ⚠️  webSocketService not available — call:incoming NOT emitted');
    }

    return formatted;
  }

  // ── answerCall ──────────────────────────────────────────────────────────────
  async answerCall(callId, userId, sdpAnswer = null) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       { [Op.in]: ['ringing', 'initiated'] },
      },
    });
    if (!call) throw new Error('Call not found or not in ringing state');

    // BUG FIX: use createdAt (always set) for ring-timeout, not startedAt (null until answered)
    const ringStart = (call.metadata && call.metadata.ringStartedAt)
      ? new Date(call.metadata.ringStartedAt)
      : new Date(call.createdAt);
    const elapsed = (Date.now() - ringStart.getTime()) / 1000;

    if (elapsed > CALL_TIMEOUT_SECONDS) {
      call.status  = 'missed';
      call.endedAt = new Date();
      await call.save();
      throw new Error('Call has timed out');
    }

    if (!call.answeredBy.includes(parseInt(userId))) {
      call.answeredBy = [...call.answeredBy, parseInt(userId)];
    }
    call.status    = 'in-progress';
    call.startedAt = new Date();   // now set — this is actual call start time
    if (sdpAnswer) call.sdpAnswer = sdpAnswer;

    // ── FORENSIC LOG: WEBRTC_CONNECTED ───────────────────────────────────────
    console.log(`[FORENSIC] WEBRTC_CONNECTED | callId=${callId} | answeredBy=${userId} | sdpAnswer=${sdpAnswer?'present':'none'} | ts=${Date.now()}`);
    await call.save();

    // FIX 7/8: Re-fetch with user associations so callerName/calleeName are available
    //           These are required by calls-ui.js handleCallAccepted name resolution chain
    let callWithUsers = call;
    try {
      const includes = this._buildIncludes();
      if (includes.length > 0) {
        const fetched = await Call.findOne({
          where: { id: call.id },
          include: includes,
        });
        if (fetched) callWithUsers = fetched;
      }
    } catch (fetchErr) {
      console.warn('[CallService] answerCall: could not re-fetch with users:', fetchErr.message);
    }

    const callerDisplayName =
      (callWithUsers.callInitiatorUser && (callWithUsers.callInitiatorUser.displayName || callWithUsers.callInitiatorUser.username)) ||
      callWithUsers.callerName || 'Caller';
    const calleeDisplayName =
      (callWithUsers.callTargetUser && (callWithUsers.callTargetUser.displayName || callWithUsers.callTargetUser.username)) ||
      callWithUsers.calleeName || 'User';
    const callerAvatarUrl =
      (callWithUsers.callInitiatorUser && callWithUsers.callInitiatorUser.avatar) || null;
    const calleeAvatarUrl =
      (callWithUsers.callTargetUser && callWithUsers.callTargetUser.avatar) || null;

    const eventData = {
      callId:       call.id,
      callerId:     call.callerId,
      receiverId:   call.receiverId,
      callType:     call.type,
      type:         call.type,
      participants: call.participants || [],
      answeredBy:   call.answeredBy || [],
      status:       'in-progress',
      startedAt:    call.startedAt,
      timestamp:    Date.now(),
      // FIX 7: Always include caller/callee names at top-level for frontend name resolution
      callerName:   callerDisplayName,
      calleeName:   calleeDisplayName,
      receiverName: calleeDisplayName,
      userName:     calleeDisplayName,      // generic fallback used by older UI code
      callerAvatar: callerAvatarUrl,
      calleeAvatar: calleeAvatarUrl,
      // Structured user objects for rich UI
      callerInfo:   callWithUsers.callInitiatorUser || null,
      calleeInfo:   callWithUsers.callTargetUser    || null,
    };
    await emitToAll(call.participants, 'call_accepted', eventData);   // matches calls-core.js CALL_ACCEPTED
    await emitToAll(call.participants, 'call_answered', eventData);

    return this._format(call);
  }

  // ── rejectCall ──────────────────────────────────────────────────────────────
  async rejectCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       { [Op.in]: ['ringing', 'initiated'] },
      },
    });
    if (!call) throw new Error('Call not found or not in ringing state');
    if (call.callerId === parseInt(userId)) throw new Error('Caller cannot reject — use cancel instead');

    if (!call.declinedBy.includes(parseInt(userId))) {
      call.declinedBy = [...call.declinedBy, parseInt(userId)];
    }

    const remaining = call.participants.filter(pid => pid !== call.callerId && !call.declinedBy.includes(pid));
    if (remaining.length === 0) {
      call.status  = 'missed';
      call.endedAt = new Date();
    }
    await call.save();

    const eventData = {
      callId:     call.id,
      callerId:   call.callerId,
      receiverId: call.receiverId,
      callType:   call.type,
      participants: call.participants || [],
      declinedBy: call.declinedBy,
      status:     call.status,
      reason:     'declined',
      timestamp:  Date.now(),
    };
    await emitToAll(call.participants, 'call_rejected', eventData);

    return this._format(call);
  }

  // ── cancelCall ──────────────────────────────────────────────────────────────
  async cancelCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:       callId,
        callerId: parseInt(userId),
        status:   { [Op.in]: ['ringing', 'initiated'] },
      },
    });
    if (!call) throw new Error('Call not found or cannot be cancelled');

    call.status  = 'cancelled';
    call.endedAt = new Date();
    await call.save();

    const eventData = {
      callId:    call.id,
      callerId:  call.callerId,
      receiverId: call.receiverId,
      callType:  call.type,
      participants: call.participants || [],
      status:    'cancelled',
      endedAt:   call.endedAt,
      timestamp: Date.now(),
    };
    // CALL_CANCELLED is what calls-ui.js watches for to dismiss the incoming modal
    await emitToAll(call.participants, 'call_cancelled', eventData);

    return this._format(call);
  }

  // ── endCall ─────────────────────────────────────────────────────────────────
  async endCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id: callId,
        [Op.or]: [
          { participants: { [Op.contains]: [parseInt(userId)] } },
          { callerId:   parseInt(userId) },
          { receiverId: parseInt(userId) },
        ],
      },
    });
    if (!call) throw new Error('Call not found or not in progress');

    // Already ended — return without error
    if (['completed', 'missed', 'cancelled', 'rejected', 'failed'].includes(call.status)) {
      return this._format(call);
    }

    const endedAt  = new Date();
    const start    = call.startedAt ? new Date(call.startedAt) : endedAt;
    const duration = Math.floor((endedAt - start) / 1000);

    if (duration > MAX_CALL_DURATION) throw new Error(`Call exceeded maximum duration of ${MAX_CALL_DURATION}s`);

    call.status   = (call.answeredBy && call.answeredBy.length > 0) ? 'completed' : 'missed';
    call.endedAt  = endedAt;
    call.duration = duration;
    await call.save();

    const eventData = {
      callId:     call.id,
      callerId:   call.callerId,
      receiverId: call.receiverId,
      callType:   call.type,
      participants: call.participants || [],
      status:     call.status,
      duration:   call.duration,
      endedAt:    call.endedAt,
      timestamp:  Date.now(),
    };
    // Emit both call_ended and call_force_ended so every listener in calls-core / calls-ui is hit
    await emitToAll(call.participants, 'call_ended',        eventData);
    await emitToAll(call.participants, 'call_force_ended',  { ...eventData, forceEnd: true });

    return this._format(call);
  }

  // ── joinCall ────────────────────────────────────────────────────────────────
  async joinCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:     callId,
        status: 'in-progress',
      },
    });
    if (!call) throw new Error('Call not found or not in progress');

    // Add user to participants if not already there
    if (!call.participants.includes(parseInt(userId))) {
      call.participants = [...call.participants, parseInt(userId)];
    }
    if (!call.answeredBy.includes(parseInt(userId))) {
      call.answeredBy = [...call.answeredBy, parseInt(userId)];
    }
    await call.save();

    return this._format(call);
  }

  // ── leaveCall ───────────────────────────────────────────────────────────────
  async leaveCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       'in-progress',
      },
    });
    if (!call) throw new Error('Call not found or not in progress');

    call.answeredBy = (call.answeredBy || []).filter(id => id !== parseInt(userId));

    if (call.answeredBy.length === 0) {
      call.status  = 'completed';
      call.endedAt = new Date();
      if (call.startedAt) {
        call.duration = Math.floor((new Date() - new Date(call.startedAt)) / 1000);
      }
      await emitToAll(call.participants, 'call_ended', {
        callId:    call.id,
        status:    'completed',
        duration:  call.duration,
        timestamp: Date.now(),
      });
    }

    await call.save();
    return this._format(call);
  }

  // ── addIceCandidate ─────────────────────────────────────────────────────────
  async addIceCandidate(callId, userId, candidate) {
    if (!callId || !userId) throw new Error('callId and userId are required');
    if (!candidate) throw new Error('ICE candidate is required');

    const call = await Call.findOne({
      where: { id: callId, participants: { [Op.contains]: [parseInt(userId)] } },
    });
    if (!call) throw new Error('Call not found or user not a participant');

    // Persist the candidate
    call.iceCandidates = [...(call.iceCandidates || []), { userId: parseInt(userId), candidate, timestamp: new Date() }];
    await call.save();

    // ── CRITICAL FIX: Relay ICE candidate to the OTHER participants via WS ──
    // Without this relay the ICE negotiation never completes → no audio.
    const svc = ws();
    if (svc && typeof svc.sendToUser === 'function') {
      const otherParticipants = (call.participants || []).filter(pid => pid !== parseInt(userId));
      const icePayload = {
        callId:    callId,
        candidate: candidate,
        from:      parseInt(userId),
        timestamp: Date.now(),
      };
      for (const pid of otherParticipants) {
        try { svc.sendToUser(pid, 'ice_candidate',      icePayload); } catch (_) {}
        try { svc.sendToUser(pid, 'call:ice_candidate', icePayload); } catch (_) {}
        try { svc.sendToUser(pid, 'call_ice_candidate', icePayload); } catch (_) {}
      }
    }

    return { success: true };
  }

  // ── getCallDetails ──────────────────────────────────────────────────────────
  // FIX: callController calls getCallDetails(callId) with ONE arg; accept both forms.
  async getCallDetails(callId, userId) {
    if (!callId) throw new Error('callId is required');

    const where = { id: callId };
    if (userId) {
      where.participants = { [Op.contains]: [parseInt(userId)] };
    }

    const call = await Call.findOne({ where, include: this._buildIncludes() });
    if (!call) throw new Error('Call not found or access denied');
    return this._format(call);
  }

  // ── getUserCalls ────────────────────────────────────────────────────────────
  async getUserCalls(userId, options = {}) {
    if (!userId) throw new Error('userId is required');

    const { status, limit = 50, offset = 0 } = options;
    const whereClause = {
      [Op.or]: [
        { callerId:    parseInt(userId) },
        { receiverId:  parseInt(userId) },
        { participants: { [Op.contains]: [parseInt(userId)] } },
      ],
    };
    if (status) whereClause.status = status;

    const { count, rows } = await Call.findAndCountAll({
      where: whereClause,
      include: this._buildIncludes(),
      order: [['createdAt', 'DESC']],
      limit:  parseInt(limit),
      offset: parseInt(offset),
      distinct: true,
    });

    return { calls: rows.map(c => this._format(c)), total: count };
  }

  // ── initiateGroupCall ───────────────────────────────────────────────────────
  async initiateGroupCall(callerId, participantIds, callType = 'audio', chatId = null) {
    if (!callerId || !Array.isArray(participantIds)) throw new Error('callerId and participantIds are required');

    const allIds = [...new Set([parseInt(callerId), ...participantIds.map(Number)])];
    if (allIds.length > MAX_GROUP_CALL_PARTICIPANTS)
      throw new Error(`Group call cannot have more than ${MAX_GROUP_CALL_PARTICIPANTS} participants`);
    if (!['audio', 'video'].includes(callType)) throw new Error('Invalid call type');

    await this._forceCleanupStaleCallsForUsers(allIds);

    const active = await Call.findOne({
      where: {
        participants: { [Op.overlap]: allIds },
        status:       { [Op.in]: ['ringing', 'initiated', 'in-progress'] },
      },
    });
    if (active) throw new Error('One or more participants are already in a call');

    const call = await Call.create({
      callerId:     parseInt(callerId),
      chatId:       chatId ? parseInt(chatId) : null,
      type:         callType,
      status:       'ringing',
      isGroupCall:  true,
      participants: allIds,
      answeredBy:   [],
      declinedBy:   [],
      readBy:       [],
      startedAt:    new Date(),
      metadata:     { ringStartedAt: new Date().toISOString() },
    });

    return this._format(call);
  }

  // ── getActiveCalls ──────────────────────────────────────────────────────────
  async getActiveCalls(userId) {
    if (!userId) throw new Error('userId is required');
    await this._cleanupTimedOut();

    const calls = await Call.findAll({
      where: {
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       { [Op.in]: ['ringing', 'initiated', 'in-progress'] },
      },
      include: this._buildIncludes(),
      order:  [['createdAt', 'DESC']],
    });
    return calls.map(c => this._format(c));
  }

  // ── getCallHistory ──────────────────────────────────────────────────────────
  async getCallHistory(userId, page = 1, limit = 20) {
    if (!userId) throw new Error('userId is required');
    page  = parseInt(page);
    limit = parseInt(limit);
    if (page < 1 || limit < 1 || limit > 100) throw new Error('Invalid pagination parameters');

    const { count, rows } = await Call.findAndCountAll({
      where: {
        participants: { [Op.contains]: [parseInt(userId)] },
        endedAt:      { [Op.ne]: null },
      },
      include: this._buildIncludes(),
      order:   [['endedAt', 'DESC']],
      offset:  (page - 1) * limit,
      limit,
    });

    return {
      calls: rows.map(c => this._format(c)),
      pagination: {
        currentPage: page,
        totalPages:  Math.ceil(count / limit),
        totalCalls:  count,
        hasNext:     page < Math.ceil(count / limit),
        hasPrevious: page > 1,
      },
    };
  }

  // ── getCallById ─────────────────────────────────────────────────────────────
  async getCallById(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');
    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
      },
      include: this._buildIncludes(),
    });
    if (!call) throw new Error('Call not found or access denied');
    return this._format(call);
  }

  // ── getMissedCalls ──────────────────────────────────────────────────────────
  async getMissedCalls(userId, limit = 50) {
    if (!userId) throw new Error('userId is required');
    const calls = await Call.findAll({
      where: {
        receiverId: parseInt(userId),
        status:     'missed',
        createdAt:  { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      include: this._buildIncludes(),
      order:   [['createdAt', 'DESC']],
      limit:   parseInt(limit),
    });
    return calls.map(c => this._format(c));
  }

  // ── markCallAsRead ──────────────────────────────────────────────────────────
  async markCallAsRead(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');
    const call = await Call.findOne({
      where: { id: callId, participants: { [Op.contains]: [parseInt(userId)] } },
    });
    if (!call) throw new Error('Call not found or access denied');
    if (!call.readBy) call.readBy = [];
    if (!call.readBy.includes(parseInt(userId))) {
      call.readBy = [...call.readBy, parseInt(userId)];
      await call.save();
    }
    return { success: true };
  }

  // ── _forceCleanupStaleCallsForUsers ─────────────────────────────────────────
  async _forceCleanupStaleCallsForUsers(userIds) {
    try {
      const stale = await Call.findAll({
        where: {
          [Op.or]: userIds.map(id => ({ participants: { [Op.contains]: [id] } })),
          status:    { [Op.in]: ['ringing', 'initiated', 'in-progress'] },
          createdAt: { [Op.lt]: new Date(Date.now() - CALL_TIMEOUT_SECONDS * 1000) },
        },
      });
      for (const call of stale) {
        const wasAnswered = call.answeredBy && call.answeredBy.length > 0;
        await call.update({ status: wasAnswered ? 'completed' : 'missed', endedAt: new Date() });
        emitToAll(call.participants, 'call_force_ended', {
          callId:    call.id,
          reason:    'stale_cleanup',
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.warn('[CallService] _forceCleanupStaleCallsForUsers error (non-fatal):', err.message);
    }
  }

  // ── _cleanupTimedOut ────────────────────────────────────────────────────────
  async _cleanupTimedOut() {
    try {
      const cutoff      = new Date(Date.now() - CALL_TIMEOUT_SECONDS * 1000);
      const timedOut    = await Call.findAll({
        where: {
          status:    { [Op.in]: ['ringing', 'initiated'] },
          createdAt: { [Op.lt]: cutoff },
          endedAt:   null,
        },
        include: this._buildIncludes(),
      });

      for (const call of timedOut) {
        call.status  = 'missed';
        call.endedAt = new Date();
        await call.save();

        const data = { callId: call.id, callType: call.type, timestamp: new Date() };
        // Notify callee
        if (call.receiverId) {
          emitToAll([call.receiverId], 'call_missed', {
            ...data,
            callerId:   call.callerId,
            callerName: call.callInitiatorUser && call.callInitiatorUser.username || 'Unknown',
          });
        }
        // Notify caller
        emitToAll([call.callerId], 'call_timeout', {
          ...data,
          calleeId:   call.receiverId,
          calleeName: call.callTargetUser && call.callTargetUser.username || 'Unknown',
        });
        // Force-end on both sides so UI resets
        emitToAll(call.participants, 'call_force_ended', { ...data, reason: 'timeout' });
      }

      if (timedOut.length > 0) {
        console.log(`[CallService] Cleaned up ${timedOut.length} timed-out calls`);
      }
    } catch (err) {
      console.error('[CallService] _cleanupTimedOut error:', err.message);
    }
  }

  // ── _format ─────────────────────────────────────────────────────────────────
  _format(call) {
    const obj = call.toJSON ? call.toJSON() : { ...(call.dataValues || call) };

    if (obj.startedAt && obj.endedAt) {
      obj.duration = obj.duration || Math.floor((new Date(obj.endedAt) - new Date(obj.startedAt)) / 1000);
    }

    obj.participants    = obj.participants    || [];
    obj.answeredBy      = obj.answeredBy      || [];
    obj.declinedBy      = obj.declinedBy      || [];
    obj.readBy          = obj.readBy          || [];
    obj.callerInfo      = obj.callInitiatorUser || null;
    obj.calleeInfo      = obj.callTargetUser    || null;
    obj.isMissed        = obj.status === 'missed';
    obj.displayDuration = obj.duration > 0
      ? `${Math.floor(obj.duration / 60)}:${String(obj.duration % 60).padStart(2, '0')}`
      : '0:00';

    obj.otherParticipants = [];
    if (obj.callInitiatorUser) obj.otherParticipants.push({ ...obj.callInitiatorUser, displayName: obj.callInitiatorUser.username });
    if (obj.callTargetUser)    obj.otherParticipants.push({ ...obj.callTargetUser,    displayName: obj.callTargetUser.username    });

    // FIX-PHASE15: Always populate top-level callerName / callerAvatar so the
    // receiver's calls-ui.js can display the real name regardless of which code
    // path triggered the emit. Without these fields the UI falls back to "user 1".
    if (!obj.callerName && obj.callInitiatorUser) {
      const u = obj.callInitiatorUser;
      const first = u.firstName || '';
      const last  = u.lastName  || '';
      obj.callerName   = (first + (last ? ' ' + last : '')).trim() || u.username || null;
      obj.callerAvatar = u.avatar || null;
    }
    if (!obj.calleeName && obj.callTargetUser) {
      const u = obj.callTargetUser;
      const first = u.firstName || '';
      const last  = u.lastName  || '';
      obj.calleeName   = (first + (last ? ' ' + last : '')).trim() || u.username || null;
      obj.calleeAvatar = u.avatar || null;
    }
    // Alias callType for frontends that check callType instead of type
    if (!obj.callType && obj.type) obj.callType = obj.type;

    return obj;
  }
}

module.exports = new CallService();
