/**
 * callService.js — Sequelize/PostgreSQL call service
 *
 * COMPLETELY REWRITTEN: original used Mongoose (MongoDB ODM) which is incompatible
 * with this project's Sequelize + PostgreSQL stack. All methods now use Sequelize
 * models, Op operators, and ARRAY column access instead of MongoDB $in/$set syntax.
 */

'use strict';

const { Op } = require('sequelize');
const db      = require('../models');
const Call    = db.Calls || db.Call;
const User    = db.Users || db.User;
const Chat    = db.Chats || db.Chat;

const MAX_CALL_DURATION         = parseInt(process.env.MAX_CALL_DURATION)         || 3600;
const CALL_TIMEOUT_SECONDS      = parseInt(process.env.CALL_TIMEOUT_SECONDS)      || 40; // Changed from 30 to 40 seconds
const MAX_GROUP_CALL_PARTICIPANTS = parseInt(process.env.MAX_GROUP_CALL_PARTICIPANTS) || 10;

// ─── helpers ─────────────────────────────────────────────────────────────────

class CallService {

  // ── _buildIncludes ──────────────────────────────────────────────────────────
  _buildIncludes() {
    const includes = [];
    try {
      if (Call.associations?.callInitiatorUser) {
        includes.push({ 
          model: User, 
          as: 'callInitiatorUser', 
          attributes: ['id', 'username', 'avatar', 'email'] 
        });
      }
      if (Call.associations?.callTargetUser) {
        includes.push({ 
          model: User, 
          as: 'callTargetUser', 
          attributes: ['id', 'username', 'avatar', 'email'] 
        });
      }
    } catch(_) {}
    return includes;
  }

  // ── initiateCall ────────────────────────────────────────────────────────────
  async initiateCall(callerId, calleeId, callType = 'audio', chatId = null) {
    if (!callerId || !calleeId) throw new Error('callerId and calleeId are required');
    if (!['audio', 'video'].includes(callType)) throw new Error('Invalid call type');

    const [caller, callee] = await Promise.all([
      User.findByPk(parseInt(callerId), { attributes: ['id', 'username', 'avatar', 'email'] }),
      User.findByPk(parseInt(calleeId), { attributes: ['id', 'username', 'avatar', 'email'] }),
    ]);
    if (!caller) throw new Error('Caller not found');
    if (!callee) throw new Error('Callee not found');

    // Check callee not already in an active call
    const activeCall = await Call.findOne({
      where: {
        participants: { [Op.contains]: [parseInt(calleeId)] },
        status:       { [Op.in]: ['ringing', 'initiated', 'in-progress'] },
      },
    });
    if (activeCall) throw new Error('Callee is already in a call');

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
      startedAt:    new Date(),
    });

    return this._format(call, caller, callee);
  }

  // ── answerCall ──────────────────────────────────────────────────────────────
  async answerCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       { [Op.in]: ['ringing', 'initiated'] },
      },
    });
    if (!call) throw new Error('Call not found or not in ringing state');

    // Check timeout
    const elapsed = (Date.now() - new Date(call.startedAt).getTime()) / 1000;
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
    call.startedAt = call.startedAt || new Date();
    await call.save();

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
    if (call.callerId === parseInt(userId)) throw new Error('Caller cannot reject their own call — use cancel instead');

    if (!call.declinedBy.includes(parseInt(userId))) {
      call.declinedBy = [...call.declinedBy, parseInt(userId)];
    }

    const remaining = call.participants.filter(pid => pid !== call.callerId && !call.declinedBy.includes(pid));
    if (remaining.length === 0) { call.status = 'missed'; call.endedAt = new Date(); }

    await call.save();
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
    return this._format(call);
  }

  // ── endCall ─────────────────────────────────────────────────────────────────
  async endCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       { [Op.in]: ['in-progress', 'ringing', 'initiated'] },
      },
    });
    if (!call) throw new Error('Call not found or not in progress');

    const endedAt = new Date();
    const start   = call.startedAt ? new Date(call.startedAt) : endedAt;
    const duration = Math.floor((endedAt - start) / 1000);

    if (duration > MAX_CALL_DURATION) throw new Error(`Call exceeded maximum duration of ${MAX_CALL_DURATION}s`);

    call.status   = (call.answeredBy && call.answeredBy.length > 0) ? 'completed' : 'missed';
    call.endedAt  = endedAt;
    call.duration = duration;
    await call.save();

    return this._format(call);
  }

  // ── joinCall ────────────────────────────────────────────────────────────────
  async joinCall(callId, userId) {
    if (!callId || !userId) throw new Error('callId and userId are required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
        status:       'in-progress',
      },
    });
    if (!call) throw new Error('Call not found, not in progress, or user not a participant');

    if (!call.answeredBy.includes(parseInt(userId))) {
      call.answeredBy = [...call.answeredBy, parseInt(userId)];
      await call.save();
    }

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

    // Remove user from answeredBy if present
    if (call.answeredBy.includes(parseInt(userId))) {
      call.answeredBy = call.answeredBy.filter(id => id !== parseInt(userId));
    }

    // If no one is left answering, end the call
    if (call.answeredBy.length === 0) {
      call.status  = 'completed';
      call.endedAt = new Date();
      if (call.startedAt) {
        call.duration = Math.floor((new Date() - new Date(call.startedAt)) / 1000);
      }
    }

    await call.save();
    return this._format(call);
  }

  // ── addIceCandidate ─────────────────────────────────────────────────────────
  async addIceCandidate(callId, userId, candidate) {
    if (!callId || !userId) throw new Error('callId and userId are required');
    if (!candidate) throw new Error('ICE candidate is required');

    const call = await Call.findOne({
      where: {
        id:           callId,
        participants: { [Op.contains]: [parseInt(userId)] },
      },
    });
    if (!call) throw new Error('Call not found or user not a participant');

    // Store ICE candidates in the call record if needed
    if (!call.iceCandidates) {
      call.iceCandidates = [];
    }
    call.iceCandidates.push({
      userId: parseInt(userId),
      candidate,
      timestamp: new Date(),
    });
    await call.save();

    return { success: true };
  }

  // ── getCallDetails ──────────────────────────────────────────────────────────
  async getCallDetails(callId, userId) {
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

  // ── getUserCalls ────────────────────────────────────────────────────────────
  async getUserCalls(userId, options = {}) {
    if (!userId) throw new Error('userId is required');

    const { status, limit = 50, offset = 0 } = options;
    const whereClause = {
      participants: { [Op.contains]: [parseInt(userId)] },
    };

    if (status) {
      whereClause.status = status;
    }

    const calls = await Call.findAll({
      where: whereClause,
      include: this._buildIncludes(),
      order: [['startedAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    return calls.map(call => this._format(call));
  }

  // ── initiateGroupCall ───────────────────────────────────────────────────────
  async initiateGroupCall(callerId, participantIds, callType = 'audio', chatId = null) {
    if (!callerId || !Array.isArray(participantIds)) throw new Error('callerId and participantIds are required');

    const allIds = [...new Set([parseInt(callerId), ...participantIds.map(Number)])];
    if (allIds.length > MAX_GROUP_CALL_PARTICIPANTS)
      throw new Error(`Group call cannot have more than ${MAX_GROUP_CALL_PARTICIPANTS} participants`);
    if (!['audio', 'video'].includes(callType)) throw new Error('Invalid call type');

    // Check nobody already in a call
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
      order:  [['startedAt', 'DESC']],
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
      order:  [['endedAt', 'DESC']],
      offset: (page - 1) * limit,
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

  // ── _cleanupTimedOut ────────────────────────────────────────────────────────
  // FIXED BUG 7: Added WebSocket notifications for timed-out calls
  async _cleanupTimedOut() {
    try {
      const cutoff = new Date(Date.now() - CALL_TIMEOUT_SECONDS * 1000);
      
      // Find all timed-out calls first so we can notify participants
      const timedOutCalls = await Call.findAll({
        where: {
          status: { [Op.in]: ['ringing', 'initiated'] },
          startedAt: { [Op.lt]: cutoff },
          endedAt: null,
        },
        include: this._buildIncludes(),
      });

      for (const call of timedOutCalls) {
        call.status = 'missed';
        call.endedAt = new Date();
        await call.save();

        // Notify both parties via WebSocket (if websocket service is available)
        try {
          const wsService = require('./webSocketService');
          
          // Notify callee: "you missed a call"
          if (call.receiverId) {
            wsService.sendToUser(call.receiverId, 'call_missed', {
              callId: call.id,
              callerId: call.callerId,
              callerName: call.callInitiatorUser?.username || 'Unknown',
              callType: call.type,
              timestamp: new Date()
            });
          }
          
          // Notify caller: "call was not answered"
          wsService.sendToUser(call.callerId, 'call_timeout', {
            callId: call.id,
            calleeId: call.receiverId,
            calleeName: call.callTargetUser?.username || 'Unknown',
            callType: call.type,
            timestamp: new Date()
          });
        } catch (wsErr) {
          // WebSocket service might not be available in all contexts
          console.warn('[CallService] Could not send WebSocket notifications for timeout:', wsErr.message);
        }
      }
      
      if (timedOutCalls.length > 0) {
        console.log(`[CallService] Cleaned up ${timedOutCalls.length} timed-out calls (${CALL_TIMEOUT_SECONDS}s timeout)`);
      }
    } catch (err) {
      console.error('[CallService] _cleanupTimedOut error:', err.message);
    }
  }

  // ── _format ─────────────────────────────────────────────────────────────────
  _format(call) {
    const obj = call.toJSON ? call.toJSON() : { ...call.dataValues };
    if (obj.startedAt && obj.endedAt) {
      obj.duration = obj.duration || Math.floor((new Date(obj.endedAt) - new Date(obj.startedAt)) / 1000);
    }
    // Ensure arrays are properly formatted
    if (!obj.participants) obj.participants = [];
    if (!obj.answeredBy) obj.answeredBy = [];
    if (!obj.declinedBy) obj.declinedBy = [];
    if (!obj.readBy) obj.readBy = [];
    
    // Add helper fields for frontend (BUG 6 fix)
    obj.callerInfo = obj.callInitiatorUser || null;
    obj.calleeInfo = obj.callTargetUser || null;
    obj.isMissed = obj.status === 'missed';
    obj.isOutgoing = false; // Will be set by frontend with currentUserId
    
    // Add display duration in mm:ss format
    if (obj.duration && obj.duration > 0) {
      const mins = Math.floor(obj.duration / 60);
      const secs = obj.duration % 60;
      obj.displayDuration = `${mins}:${secs.toString().padStart(2, '0')}`;
    } else {
      obj.displayDuration = '0:00';
    }
    
    return obj;
  }
}

module.exports = new CallService();