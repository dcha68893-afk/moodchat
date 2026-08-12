const { Op } = require('sequelize');
const db = require('../models');
const Call = db.Calls || db.Call;
const User = db.Users || db.User;
const Chat = db.Chats || db.Chat;

const MAX_CALL_DURATION = parseInt(process.env.MAX_CALL_DURATION) || 3600;
const CALL_TIMEOUT_SECONDS = parseInt(process.env.CALL_TIMEOUT_SECONDS) || 180;
const MAX_GROUP_CALL_PARTICIPANTS = parseInt(process.env.MAX_GROUP_CALL_PARTICIPANTS) || 10;

const _initiateCallLocks = new Map();
async function _withCalleeLock(calleeId, fn) {
  const key = String(calleeId);
  const previous = _initiateCallLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const chain = previous.then(() => gate);
  _initiateCallLocks.set(key, chain);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (_initiateCallLocks.get(key) === chain) _initiateCallLocks.delete(key);
  }
}

let _wsService = null;
function ws() {
  if (!_wsService) {
    try { _wsService = require('./webSocketService'); } catch (_) {}
  }
  return _wsService;
}

function _normalizeCallEvent(event) {
  if (!event) return event;
  if (event.includes(':')) return event;
  if (event.startsWith('call_')) return 'call:' + event.slice(5);
  return event;
}

// SINGLE EVENT CONTRACT: the call system emits one canonical colon-style event
// per lifecycle signal. Compatibility aliases are intentionally not emitted
// here because multiple event names delivered through the same transport were
// being consumed by different call engines and caused duplicate UI/WebRTC work.
async function emitToAll(participants, event, data) {
  const wsService = ws();
  const canonicalEvent = _normalizeCallEvent(event);
  const io = global.__socketIO || (wsService && wsService.getIO && wsService.getIO()) || null;
  if (!io && !(wsService && typeof wsService.sendToUser === 'function')) return false;

  let delivered = false;
  for (const participant of participants || []) {
    const uid = parseInt(typeof participant === 'object' ? (participant.id || participant.userId) : participant, 10);
    if (!uid) continue;
    try {
      if (wsService && typeof wsService.sendToUser === 'function') {
        await wsService.sendToUser(uid, canonicalEvent, data);
        delivered = true;
      } else if (io) {
        io.to(`user:${uid}`).emit(canonicalEvent, data);
        io.to(`user_${uid}`).emit(canonicalEvent, data);
        delivered = true;
      }
    } catch (err) {
      console.warn(`[CallService] emit ${canonicalEvent} → ${uid} failed:`, err.message);
    }
  }
  return delivered;
}

class CallService {
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

  async initiateCall(callerId, calleeId, callType = 'audio', chatId = null) {
    if (!callerId || !calleeId) throw new Error('callerId and calleeId are required');
    if (!['audio', 'video'].includes(callType)) throw new Error('Invalid call type');
    if (parseInt(callerId, 10) === parseInt(calleeId, 10)) throw new Error('Cannot call yourself');

    const [caller, callee] = await Promise.all([
      User.findByPk(parseInt(callerId, 10), { attributes: ['id', 'username', 'avatar', 'email'] }),
      User.findByPk(parseInt(calleeId, 10), { attributes: ['id', 'username', 'avatar', 'email'] }),
    ]);
    if (!caller) throw new Error('Caller not found');
    if (!callee) throw new Error('Callee not found');

    await this._forceCleanupStaleCallsForUsers([parseInt(callerId, 10), parseInt(calleeId, 10)]);

    const { call } = await _withCalleeLock(calleeId, async () => {
      const activeCall = await Call.findOne({
        where: {
          participants: { [Op.contains]: [parseInt(calleeId, 10)] },
          status: { [Op.in]: ['ringing', 'initiated', 'in-progress'] },
        },
        order: [['createdAt', 'DESC']],
      });

      if (activeCall) {
        const age = (Date.now() - new Date(activeCall.createdAt).getTime()) / 1000;
        const answered = Array.isArray(activeCall.answeredBy) && activeCall.answeredBy.length > 0;
        if (activeCall.status === 'in-progress') {
          throw new Error('Callee is already in an active call');
        }
        if (age >= CALL_TIMEOUT_SECONDS && !answered) {
          await activeCall.update({ status: 'missed', endedAt: new Date() });
          await emitToAll(activeCall.participants, 'call:force_ended', { callId: activeCall.id, reason: 'timeout_on_new_call', timestamp: Date.now() });
        } else {
          await activeCall.update({ status: 'cancelled', endedAt: new Date() });
          await emitToAll(activeCall.participants, 'call:force_ended', { callId: activeCall.id, reason: 'replaced_by_new_call', timestamp: Date.now() });
        }
      }

      return {
        call: await Call.create({
          callerId: parseInt(callerId, 10),
          receiverId: parseInt(calleeId, 10),
          chatId: chatId ? parseInt(chatId, 10) : null,
          type: callType,
          status: 'ringing',
          isGroupCall: false,
          participants: [parseInt(callerId, 10), parseInt(calleeId, 10)],
          answeredBy: [],
          declinedBy: [],
          readBy: [],
          startedAt: null,
          metadata: { ringStartedAt: new Date().toISOString() },
        }),
      };
    });

    const callerDisplayName = caller.username || 'Caller';
    const calleeDisplayName = callee.username || 'User';
    const payload = {
      callId: call.id,
      callerId: parseInt(callerId, 10),
      receiverId: parseInt(calleeId, 10),
      callType,
      type: callType,
      status: 'ringing',
      callerName: callerDisplayName,
      callerAvatar: caller.avatar || null,
      calleeName: calleeDisplayName,
      calleeAvatar: callee.avatar || null,
      caller: { id: caller.id, username: caller.username, avatar: caller.avatar, displayName: callerDisplayName },
      callee: { id: callee.id, username: callee.username, avatar: callee.avatar, displayName: calleeDisplayName },
      chatId: call.chatId,
      isGroupCall: false,
      timestamp: Date.now(),
    };

    const svc = ws();
    if (!svc || typeof svc.sendToUser !== 'function') {
      throw new Error('Call signaling service unavailable');
    }

    // Exactly one incoming event and one caller acknowledgement.
    await svc.sendToUser(parseInt(calleeId, 10), 'call:incoming', payload);
    await svc.sendToUser(parseInt(callerId, 10), 'call:initiated', payload);

    return this._format(call);
  }

  async answerCall(callId, userId, sdpAnswer = null) {
    if (!callId || !userId) throw new Error('callId and userId are required');
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [parseInt(userId, 10)] }, status: { [Op.in]: ['ringing', 'initiated'] } } });
    if (!call) throw new Error('Call not found or not in ringing state');
    const ringStart = call.metadata?.ringStartedAt ? new Date(call.metadata.ringStartedAt) : new Date(call.createdAt);
    if ((Date.now() - ringStart.getTime()) / 1000 > CALL_TIMEOUT_SECONDS) {
      await call.update({ status: 'missed', endedAt: new Date() });
      throw new Error('Call has timed out');
    }
    const answeredBy = Array.isArray(call.answeredBy) ? call.answeredBy : [];
    if (!answeredBy.includes(parseInt(userId, 10))) answeredBy.push(parseInt(userId, 10));
    await call.update({ answeredBy, status: 'in-progress', startedAt: new Date(), ...(sdpAnswer ? { sdpAnswer } : {}) });
    const fresh = await Call.findOne({ where: { id: call.id }, include: this._buildIncludes() });
    const source = fresh || call;
    await emitToAll(call.participants, 'call:accepted', {
      callId: call.id, callerId: call.callerId, receiverId: call.receiverId, callType: call.type, type: call.type,
      participants: call.participants || [], answeredBy, status: 'in-progress', startedAt: call.startedAt,
      callerName: source.callInitiatorUser?.username || 'Caller', calleeName: source.callTargetUser?.username || 'User',
      callerAvatar: source.callInitiatorUser?.avatar || null, calleeAvatar: source.callTargetUser?.avatar || null,
      timestamp: Date.now(),
    });
    return this._format(call);
  }

  async rejectCall(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [parseInt(userId, 10)] }, status: { [Op.in]: ['ringing', 'initiated'] } } });
    if (!call) throw new Error('Call not found or not in ringing state');
    if (call.callerId === parseInt(userId, 10)) throw new Error('Caller cannot reject — use cancel instead');
    const declinedBy = Array.isArray(call.declinedBy) ? call.declinedBy : [];
    if (!declinedBy.includes(parseInt(userId, 10))) declinedBy.push(parseInt(userId, 10));
    await call.update({ declinedBy, status: 'rejected', endedAt: new Date() });
    await emitToAll(call.participants, 'call:rejected', { callId: call.id, callerId: call.callerId, receiverId: call.receiverId, callType: call.type, participants: call.participants || [], declinedBy, status: 'rejected', reason: 'declined', timestamp: Date.now() });
    return this._format(call);
  }

  async cancelCall(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, callerId: parseInt(userId, 10), status: { [Op.in]: ['ringing', 'initiated'] } } });
    if (!call) throw new Error('Call not found or cannot be cancelled');
    await call.update({ status: 'cancelled', endedAt: new Date() });
    await emitToAll(call.participants, 'call:cancelled', { callId: call.id, callerId: call.callerId, receiverId: call.receiverId, callType: call.type, participants: call.participants || [], status: 'cancelled', endedAt: call.endedAt, timestamp: Date.now() });
    return this._format(call);
  }

  async endCall(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, [Op.or]: [{ participants: { [Op.contains]: [parseInt(userId, 10)] } }, { callerId: parseInt(userId, 10) }, { receiverId: parseInt(userId, 10) }] } });
    if (!call) throw new Error('Call not found or not in progress');
    if (['completed', 'missed', 'cancelled', 'rejected', 'failed'].includes(call.status)) return this._format(call);
    const endedAt = new Date();
    const startedAt = call.startedAt ? new Date(call.startedAt) : endedAt;
    const duration = Math.min(Math.max(0, Math.floor((endedAt - startedAt) / 1000)), MAX_CALL_DURATION);
    const status = Array.isArray(call.answeredBy) && call.answeredBy.length ? 'completed' : 'missed';
    await call.update({ status, endedAt, duration });
    await emitToAll(call.participants, 'call:ended', { callId: call.id, callerId: call.callerId, receiverId: call.receiverId, callType: call.type, participants: call.participants || [], status, duration, endedAt, timestamp: Date.now() });
    return this._format(call);
  }

  async joinCall(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, status: 'in-progress' } });
    if (!call) throw new Error('Call not found or not in progress');
    if (!call.participants.includes(parseInt(userId, 10))) call.participants = [...call.participants, parseInt(userId, 10)];
    if (!call.answeredBy.includes(parseInt(userId, 10))) call.answeredBy = [...call.answeredBy, parseInt(userId, 10)];
    await call.save();
    return this._format(call);
  }

  async leaveCall(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [parseInt(userId, 10)] }, status: 'in-progress' } });
    if (!call) throw new Error('Call not found or not in progress');
    call.answeredBy = (call.answeredBy || []).filter(id => id !== parseInt(userId, 10));
    if (!call.answeredBy.length) {
      call.status = 'completed'; call.endedAt = new Date();
      call.duration = call.startedAt ? Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000) : 0;
      await emitToAll(call.participants, 'call:ended', { callId: call.id, status: 'completed', duration: call.duration, timestamp: Date.now() });
    }
    await call.save();
    return this._format(call);
  }

  async addIceCandidate(callId, userId, candidate) {
    if (!callId || !userId || !candidate) throw new Error('callId, userId and candidate are required');
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [parseInt(userId, 10)] } } });
    if (!call) throw new Error('Call not found or user not a participant');
    call.iceCandidates = [...(call.iceCandidates || []), { userId: parseInt(userId, 10), candidate, timestamp: new Date() }];
    await call.save();
    const svc = ws();
    if (svc && typeof svc.sendToUser === 'function') {
      for (const pid of (call.participants || []).filter(id => parseInt(id, 10) !== parseInt(userId, 10))) {
        await svc.sendToUser(parseInt(pid, 10), 'webrtc:signal', { callId, type: 'candidate', candidate, senderId: parseInt(userId, 10), timestamp: Date.now() });
      }
    }
    return { success: true };
  }

  async getCallDetails(callId, userId) {
    const where = { id: callId };
    if (userId) where.participants = { [Op.contains]: [parseInt(userId, 10)] };
    const call = await Call.findOne({ where, include: this._buildIncludes() });
    if (!call) throw new Error('Call not found or access denied');
    return this._format(call);
  }

  async getUserCalls(userId, options = {}) {
    const { status, limit = 50, offset = 0 } = options;
    const whereClause = { [Op.or]: [{ callerId: parseInt(userId, 10) }, { receiverId: parseInt(userId, 10) }, { participants: { [Op.contains]: [parseInt(userId, 10)] } }] };
    if (status) whereClause.status = status;
    const { count, rows } = await Call.findAndCountAll({ where: whereClause, include: this._buildIncludes(), order: [['createdAt', 'DESC']], limit: parseInt(limit), offset: parseInt(offset), distinct: true });
    return { calls: rows.map(c => this._format(c)), total: count };
  }

  async initiateGroupCall(callerId, participantIds, callType = 'audio', chatId = null) {
    if (!callerId || !Array.isArray(participantIds)) throw new Error('callerId and participantIds are required');
    const allIds = [...new Set([parseInt(callerId, 10), ...participantIds.map(Number)])];
    if (allIds.length > MAX_GROUP_CALL_PARTICIPANTS) throw new Error(`Group call cannot have more than ${MAX_GROUP_CALL_PARTICIPANTS} participants`);
    if (!['audio', 'video'].includes(callType)) throw new Error('Invalid call type');
    await this._forceCleanupStaleCallsForUsers(allIds);
    const { call } = await _withCalleeLock(`group:${callerId}`, async () => {
      const active = await Call.findOne({ where: { participants: { [Op.overlap]: allIds }, status: { [Op.in]: ['ringing', 'initiated', 'in-progress'] } } });
      if (active) throw new Error('One or more participants are already in a call');
      return { call: await Call.create({ callerId: parseInt(callerId, 10), chatId: chatId ? parseInt(chatId, 10) : null, type: callType, status: 'ringing', isGroupCall: true, participants: allIds, answeredBy: [], declinedBy: [], readBy: [], startedAt: null, metadata: { ringStartedAt: new Date().toISOString() } }) };
    });
    return this._format(call);
  }

  async getActiveCalls(userId) {
    await this._cleanupTimedOut();
    const calls = await Call.findAll({ where: { participants: { [Op.contains]: [parseInt(userId, 10)] }, status: { [Op.in]: ['ringing', 'initiated', 'in-progress'] } }, include: this._buildIncludes(), order: [['createdAt', 'DESC']] });
    return calls.map(c => this._format(c));
  }

  async getCallHistory(userId, page = 1, limit = 20) {
    page = parseInt(page); limit = parseInt(limit);
    const { count, rows } = await Call.findAndCountAll({ where: { participants: { [Op.contains]: [parseInt(userId, 10)] }, endedAt: { [Op.ne]: null } }, include: this._buildIncludes(), order: [['endedAt', 'DESC']], offset: (page - 1) * limit, limit });
    return { calls: rows.map(c => this._format(c)), pagination: { currentPage: page, totalPages: Math.ceil(count / limit), totalCalls: count, hasNext: page < Math.ceil(count / limit), hasPrevious: page > 1 } };
  }

  async getCallById(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [parseInt(userId, 10)] } }, include: this._buildIncludes() });
    if (!call) throw new Error('Call not found or access denied');
    return this._format(call);
  }

  async getMissedCalls(userId, limit = 50) {
    const calls = await Call.findAll({ where: { receiverId: parseInt(userId, 10), status: 'missed', createdAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }, include: this._buildIncludes(), order: [['createdAt', 'DESC']], limit: parseInt(limit) });
    return calls.map(c => this._format(c));
  }

  async markCallAsRead(callId, userId) {
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [parseInt(userId, 10)] } } });
    if (!call) throw new Error('Call not found or access denied');
    call.readBy = call.readBy || [];
    if (!call.readBy.includes(parseInt(userId, 10))) { call.readBy.push(parseInt(userId, 10)); await call.save(); }
    return { success: true };
  }

  async _forceCleanupStaleCallsForUsers(userIds) {
    try {
      const stale = await Call.findAll({ where: { [Op.or]: userIds.map(id => ({ participants: { [Op.contains]: [id] } })), status: { [Op.in]: ['ringing', 'initiated'] }, createdAt: { [Op.lt]: new Date(Date.now() - CALL_TIMEOUT_SECONDS * 1000) } } });
      for (const call of stale) {
        if ((call.answeredBy || []).length) continue;
        await call.update({ status: 'missed', endedAt: new Date() });
        await emitToAll(call.participants, 'call:force_ended', { callId: call.id, reason: 'stale_cleanup', timestamp: Date.now() });
      }
    } catch (err) {
      console.warn('[CallService] stale cleanup failed:', err.message);
    }
  }

  async _cleanupTimedOut() {
    try {
      const cutoff = new Date(Date.now() - CALL_TIMEOUT_SECONDS * 1000);
      const timedOut = await Call.findAll({ where: { status: { [Op.in]: ['ringing', 'initiated'] }, createdAt: { [Op.lt]: cutoff }, endedAt: null }, include: this._buildIncludes() });
      for (const call of timedOut) {
        await call.update({ status: 'missed', endedAt: new Date() });
        await emitToAll(call.participants, 'call:missed', { callId: call.id, callType: call.type, callerId: call.callerId, receiverId: call.receiverId, timestamp: Date.now() });
        await emitToAll(call.participants, 'call:force_ended', { callId: call.id, reason: 'timeout', timestamp: Date.now() });
      }
    } catch (err) {
      console.error('[CallService] timeout cleanup failed:', err.message);
    }
  }

  _format(call) {
    const obj = call.toJSON ? call.toJSON() : { ...(call.dataValues || call) };
    if (obj.startedAt && obj.endedAt) obj.duration = obj.duration || Math.floor((new Date(obj.endedAt) - new Date(obj.startedAt)) / 1000);
    obj.participants = obj.participants || [];
    obj.answeredBy = obj.answeredBy || [];
    obj.declinedBy = obj.declinedBy || [];
    obj.readBy = obj.readBy || [];
    obj.callerInfo = obj.callInitiatorUser || null;
    obj.calleeInfo = obj.callTargetUser || null;
    obj.isMissed = obj.status === 'missed';
    obj.displayDuration = obj.duration > 0 ? `${Math.floor(obj.duration / 60)}:${String(obj.duration % 60).padStart(2, '0')}` : '0:00';
    obj.otherParticipants = [];
    if (obj.callInitiatorUser) obj.otherParticipants.push({ ...obj.callInitiatorUser, displayName: obj.callInitiatorUser.username });
    if (obj.callTargetUser) obj.otherParticipants.push({ ...obj.callTargetUser, displayName: obj.callTargetUser.username });
    if (!obj.callerName && obj.callInitiatorUser) obj.callerName = obj.callInitiatorUser.username || null;
    if (!obj.callerAvatar && obj.callInitiatorUser) obj.callerAvatar = obj.callInitiatorUser.avatar || null;
    if (!obj.calleeName && obj.callTargetUser) obj.calleeName = obj.callTargetUser.username || null;
    if (!obj.calleeAvatar && obj.callTargetUser) obj.calleeAvatar = obj.callTargetUser.avatar || null;
    if (!obj.callType && obj.type) obj.callType = obj.type;
    return obj;
  }
}

module.exports = new CallService();