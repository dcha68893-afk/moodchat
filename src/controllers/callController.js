/**
 * callController.js
 * FIXED VERSION — patches:
 *  1. wsIsUserOnline: was crashing if wsService.isUserOnline not a function
 *     → now always falls back gracefully (assume online = let call proceed)
 *  2. answerCall: passes sdpAnswer through to callService
 *  3. getCallDetails: passes userId through so callService can authorise
 *  4. All WS notifications use both sendToUser variants for reliability
 */

'use strict';

const callService = require('../services/callService');
const db          = require('../models');

// Attempt to load logger; fall back to console if not found
let logger;
try { logger = require('../utils/logger'); } catch (_) {
  logger = { info: console.log, warn: console.warn, error: console.error };
}

// Attempt to load AppError; fall back to plain Error
let AppError;
try { ({ AppError } = require('../middleware/errorHandler')); } catch (_) {
  AppError = class AppError extends Error { constructor(msg, status) { super(msg); this.status = status; } };
}

// ── Lazy wsService with safe wrappers ─────────────────────────────────────────
let _wsService = null;
function getWsService() {
  if (!_wsService) {
    try { _wsService = require('../services/webSocketService'); } catch (e) {
      logger.warn('[callController] wsService not available:', e.message);
    }
  }
  return _wsService;
}

/**
 * Safe isUserOnline check.
 * NEVER throws — returns true (assume online) if wsService isn't ready,
 * so the call can still be created and the frontend can handle "user offline" UI.
 */
async function wsIsUserOnline(userId) {
  const svc = getWsService();
  if (!svc) return true;                                          // service not loaded → assume online

  if (typeof svc.isUserOnline === 'function') {
    try { return !!(await svc.isUserOnline(parseInt(userId, 10))); } catch (_) {}
  }

  // Legacy fallback: check onlineUsers / userSockets maps
  const uid = parseInt(userId, 10);
  if (svc.onlineUsers instanceof Map && svc.onlineUsers.has(uid)) return true;
  if (svc.userSockets  instanceof Map && svc.userSockets.has(uid))  return true;

  return true; // final fallback: let the call proceed
}

async function wsNotifyCallInitiated(userId, data) {
  const svc = getWsService();
  if (!svc) { logger.warn('[callController] wsService not available for notifyCallInitiated'); return; }
  try {
    if (typeof svc.notifyCallInitiated === 'function') {
      await svc.notifyCallInitiated(parseInt(userId, 10), data);
    } else if (typeof svc.sendToUser === 'function') {
      await svc.sendToUser(parseInt(userId, 10), 'call:incoming',  data);
      await svc.sendToUser(parseInt(userId, 10), 'incoming_call',  data);
    }
  } catch (e) {
    logger.warn('[callController] wsNotifyCallInitiated error:', e.message);
  }
}

/**
 * Find or create a direct 1:1 chat between two users.
 * Falls back to null (safe) so the call can still proceed without a chatId.
 *
 * ROOT-CAUSE FIX (calls-message-invisible): this used to be a fourth,
 * independent reimplementation of find-or-create-direct-chat — with two
 * bugs neither of the other three copies had:
 *   1. It created chats with type: 'private', while every other part of
 *      the app (Chat History, the messages send path, notifications)
 *      only ever queries for type: 'direct'. A chat created here was
 *      therefore permanently invisible to the normal messaging pipeline
 *      — not a race, a guaranteed miss, every single time a call's
 *      "message" flow touched a pair of users with no prior direct chat.
 *   2. It had no locking, so even if the type had matched, concurrent
 *      requests for the same pair could still create two rows.
 * Fix: delegate to messageDeliveryService.resolveOrCreateDirectChat,
 * the same locked, type:'direct' resolver POST /messages already uses.
 * One Conversation Engine, not four.
 */
async function findOrCreateDirectChat(userId1, userId2) {
  try {
    const messageDeliveryService = require('../services/messageDeliveryService');
    return await messageDeliveryService.resolveOrCreateDirectChat(userId1, userId2);
  } catch (err) {
    logger.warn('[callController] findOrCreateDirectChat error (non-fatal):', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

class CallController {

  // ── initiateCall ────────────────────────────────────────────────────────────
  async initiateCall(req, res, next) {
    try {
      const callerId  = req.user.id;
      const rawType   = req.body.callType || req.body.type || 'audio';
      const type      = rawType === 'voice' ? 'audio' : rawType;
      let   chatId    = req.body.chatId || null;
      // FIX-GROUP-CALL-NOTICE: a groupId may be supplied instead of (or in
      // addition to) an explicit calleeIds list — the frontend group-chat
      // "call" button only knows the group it's in, not every member's id.
      // When groupId is present, resolve the live member list from the DB
      // ourselves rather than trusting the client to enumerate members.
      const groupId   = req.body.groupId ? parseInt(req.body.groupId, 10) : null;
      const isGroupCallFlag = req.body.isGroupCall === true || req.body.isGroupCall === 'true';
      let   calleeIds = req.body.calleeIds ||
        (Array.isArray(req.body.participantIds) && req.body.participantIds.length > 1 ? req.body.participantIds : null);
      const calleeId  = req.body.calleeId ||
        (Array.isArray(req.body.participantIds) && req.body.participantIds.length === 1 && !groupId ? req.body.participantIds[0] : null);

      let resolvedGroupName = null;
      if (groupId && (isGroupCallFlag || !calleeIds || !calleeIds.length)) {
        try {
          const memberRows = await db.sequelize.query(
            `SELECT "userId" FROM "GroupMembers" WHERE "groupId" = :groupId AND "leftAt" IS NULL`,
            { replacements: { groupId }, type: db.sequelize.QueryTypes.SELECT }
          );
          const memberIds = (memberRows || []).map(r => r.userId).filter(id => Number(id) !== Number(callerId));
          if (memberIds.length) calleeIds = memberIds;
          const grpRows = await db.sequelize.query(
            `SELECT name FROM "Groups" WHERE id = :groupId LIMIT 1`,
            { replacements: { groupId }, type: db.sequelize.QueryTypes.SELECT }
          ).catch(() => []);
          if (grpRows && grpRows[0]) resolvedGroupName = grpRows[0].name;
        } catch (e) {
          logger.warn('[callController] group member lookup failed:', e.message);
        }
      }

      // ── Group call ──────────────────────────────────────────────────────────
      // FIX-GROUP-CALL-NOTICE: previously required calleeIds.length > 1, which
      // meant a 2-member group (only one other callee) fell through to the 1:1
      // branch and never emitted group:call-started. groupId presence is what
      // actually determines "this is a group call", not headcount.
      if (Array.isArray(calleeIds) && calleeIds.length >= 1 && (groupId || calleeIds.length > 1)) {
        const call = await callService.initiateGroupCall(callerId, calleeIds.map(Number), type, chatId ? parseInt(chatId, 10) : null);

        // FIX-PHASE16: Look up real caller name for group calls too
        let groupCallerName = req.user.username || `User ${callerId}`;
        try {
          const gcRows = await db.sequelize.query(
            `SELECT u.username, u."firstName", u."lastName", p."displayName", p."fullName"
             FROM "Users" u LEFT JOIN "Profiles" p ON p."userId" = u.id
             WHERE u.id = :callerId LIMIT 1`,
            { replacements: { callerId }, type: db.sequelize.QueryTypes.SELECT }
          ).catch(() => []);
          if (gcRows && gcRows[0]) {
            const r = gcRows[0];
            groupCallerName = (r.fullName || r.displayName ||
              ((r.firstName || '') + (r.lastName ? ' ' + r.lastName : '')).trim()) || r.username || groupCallerName;
          }
        } catch (_) {}

        for (const id of calleeIds) {
          await wsNotifyCallInitiated(id, {
            callId:       call.id,
            callerId,
            callerName:   groupCallerName,
            callerAvatar: req.user.avatar   || null,
            isGroupCall:  true,
            groupId:      groupId || null,
            callType:     type,
            chatId:       chatId ? parseInt(chatId, 10) : null,
            timestamp:    Date.now(),
          });
        }

        // FIX-GROUP-CALL-NOTICE: also broadcast a group-wide "call started" event
        // (distinct from the per-user ringing notification above) so anyone with
        // the group chat open sees a "<name> started a call — Join" banner and can
        // hop in without having received a direct ring themselves.
        if (groupId) {
          try {
            const svc = getWsService();
            if (svc && typeof svc.notifyGroupCallStarted === 'function') {
              await svc.notifyGroupCallStarted(groupId, {
                callId: call.id, callerId, callerName: groupCallerName,
                callType: type, groupName: resolvedGroupName,
              });
            }
          } catch (e) {
            logger.warn('[callController] notifyGroupCallStarted failed:', e.message);
          }
        }

        return res.status(201).json({ success: true, message: 'Group call initiated', data: { call } });
      }

      // ── 1:1 call ────────────────────────────────────────────────────────────
      if (!calleeId) throw new AppError('calleeId is required', 400);

      if (!chatId) chatId = await findOrCreateDirectChat(callerId, parseInt(calleeId, 10));

      // NOTE: isOnline is a hint only — we ALWAYS proceed with the call.
      // The online check is unreliable across server restarts / race conditions.
      // The 30s ring timeout or receiver rejection will handle genuine no-answer.
      const isOnline = await wsIsUserOnline(parseInt(calleeId, 10));
      console.log(`[callController] wsIsUserOnline(${calleeId}) = ${isOnline} (hint only — call proceeds regardless)`);

      const call = await callService.initiateCall(callerId, parseInt(calleeId, 10), type, chatId ? parseInt(chatId, 10) : null);

      // ── FIX-PHASE16: Fetch caller's real display name from the database.
      // The JWT only contains userId, email, username (no firstName/lastName).
      // Previously the code tried req.user.firstName which is always undefined,
      // so callerName fell back to req.user.username or 'Unknown'.
      // Now we JOIN Users + Profiles to get the richest possible name.
      let callerDisplayName = req.user.username || null;
      try {
        const rows = await db.sequelize.query(
          `SELECT u.username, u."firstName", u."lastName",
                  p."displayName", p."fullName"
           FROM "Users" u
           LEFT JOIN "Profiles" p ON p."userId" = u.id
           WHERE u.id = :callerId LIMIT 1`,
          { replacements: { callerId }, type: db.sequelize.QueryTypes.SELECT }
        ).catch(() => []);
        if (rows && rows[0]) {
          const r = rows[0];
          const fullName = (r.fullName || r.displayName ||
            ((r.firstName || '') + (r.lastName ? ' ' + r.lastName : '')).trim()) || r.username;
          if (fullName) callerDisplayName = fullName;
        }
      } catch (_) { /* non-fatal — fall back to username */ }

      callerDisplayName = callerDisplayName
        || (call.callerInfo && (call.callerInfo.displayName || call.callerInfo.username))
        || req.user.username
        || `User ${callerId}`;

      console.log(`[callController] 📞 CALLING wsNotifyCallInitiated → receiverId=${calleeId} callerName="${callerDisplayName}"`);
      await wsNotifyCallInitiated(parseInt(calleeId, 10), {
        callId:       call.id,
        callerId,
        callerName:   callerDisplayName,
        callerAvatar: (call.callerInfo && call.callerInfo.avatar) || req.user.avatar || null,
        callType:     type,   // top-level alias expected by calls-ui
        type:         type,
        isGroupCall:  false,
        chatId:       chatId ? parseInt(chatId, 10) : null,
        timestamp:    Date.now(),
      });
      console.log(`[callController] ✅ wsNotifyCallInitiated sent for call=${call.id}`);

      return res.status(201).json({
        success:  true,
        message:  'Call initiated successfully',
        data:     { call, receiverOnline: isOnline },
      });

    } catch (error) {
      logger.error('[callController] initiateCall error:', error);
      next(error);
    }
  }

  // ── answerCall ──────────────────────────────────────────────────────────────
  async answerCall(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;
      const { sdpAnswer } = req.body;   // pass SDP answer to service

      const call = await callService.answerCall(callId, userId, sdpAnswer || null);

      return res.json({ success: true, message: 'Call answered', data: { call } });
    } catch (error) {
      logger.error('[callController] answerCall error:', error);
      next(error);
    }
  }

  // ── rejectCall ──────────────────────────────────────────────────────────────
  async rejectCall(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;

      const call = await callService.rejectCall(callId, userId);
      return res.json({ success: true, message: 'Call rejected', data: { call } });
    } catch (error) {
      logger.error('[callController] rejectCall error:', error);
      next(error);
    }
  }

  // ── cancelCall ──────────────────────────────────────────────────────────────
  async cancelCall(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;

      const call = await callService.cancelCall(callId, userId);
      return res.json({ success: true, message: 'Call cancelled', data: { call } });
    } catch (error) {
      logger.error('[callController] cancelCall error:', error);
      next(error);
    }
  }

  // ── endCall ─────────────────────────────────────────────────────────────────
  async endCall(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;

      const call = await callService.endCall(callId, userId);
      return res.json({ success: true, message: 'Call ended', data: { call } });
    } catch (error) {
      logger.error('[callController] endCall error:', error);
      next(error);
    }
  }

  // ── joinCall ────────────────────────────────────────────────────────────────
  async joinCall(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;

      const call = await callService.joinCall(callId, userId);
      return res.json({ success: true, message: 'Joined call', data: { call } });
    } catch (error) {
      logger.error('[callController] joinCall error:', error);
      next(error);
    }
  }

  // ── leaveCall ───────────────────────────────────────────────────────────────
  async leaveCall(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;

      const call = await callService.leaveCall(callId, userId);
      return res.json({ success: true, message: 'Left call', data: { call } });
    } catch (error) {
      logger.error('[callController] leaveCall error:', error);
      next(error);
    }
  }

  // ── addIceCandidate ─────────────────────────────────────────────────────────
  async addIceCandidate(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;
      const { candidate } = req.body;

      await callService.addIceCandidate(callId, userId, candidate);
      return res.json({ success: true, message: 'ICE candidate added' });
    } catch (error) {
      logger.error('[callController] addIceCandidate error:', error);
      next(error);
    }
  }

  // ── getCallDetails ──────────────────────────────────────────────────────────
  async getCallDetails(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;

      // FIX: pass userId so callService can authorise + populate associations
      const call = await callService.getCallDetails(callId, userId);

      return res.json({ success: true, data: { call } });
    } catch (error) {
      logger.error('[callController] getCallDetails error:', error);
      next(error);
    }
  }

  // ── getActiveCalls ──────────────────────────────────────────────────────────
  async getActiveCalls(req, res, next) {
    try {
      const userId  = req.user.id;
      const calls   = await callService.getActiveCalls(userId);
      return res.json({ success: true, data: { calls, count: calls.length } });
    } catch (error) {
      logger.error('[callController] getActiveCalls error:', error);
      next(error);
    }
  }

  // ── getUserCalls ────────────────────────────────────────────────────────────
  async getUserCalls(req, res, next) {
    try {
      const userId             = req.user.id;
      const { page = 1, limit = 20, status, type } = req.query;
      const options = { offset: (parseInt(page, 10) - 1) * parseInt(limit, 10), limit: parseInt(limit, 10) };
      if (status) options.status = status;
      if (type)   options.type   = type;

      const result    = await callService.getUserCalls(userId, options);
      const callsList = Array.isArray(result) ? result : (result.calls || []);
      const total     = result.total || callsList.length;

      return res.json({ success: true, data: { calls: callsList, pagination: { page: parseInt(page, 10), limit: parseInt(limit, 10), total, pages: Math.ceil(total / parseInt(limit, 10)) } } });
    } catch (error) {
      logger.error('[callController] getUserCalls error:', error);
      next(error);
    }
  }

  // ── getCallLink ─────────────────────────────────────────────────────────────
  async getCallLink(req, res, next) {
    try {
      const { callId } = req.params;
      await callService.getCallById(callId, req.user.id);
      const linkToken  = Buffer.from(`${callId}:${Date.now()}:${req.user.id}`).toString('base64');
      const baseUrl    = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
      const callLink   = `${baseUrl}/join-call?token=${linkToken}&callId=${callId}`;
      return res.json({ success: true, data: { callLink, callId, expiresIn: 3600 } });
    } catch (error) {
      logger.error('[callController] getCallLink error:', error);
      next(error);
    }
  }

  // ── joinViaLink ─────────────────────────────────────────────────────────────
  async joinViaLink(req, res, next) {
    try {
      const { callId, token } = req.query;
      const userId = req.user.id;
      if (!callId) throw new AppError('callId is required', 400);

      if (token) {
        const decoded = Buffer.from(token, 'base64').toString();
        const [tokenCallId, timestamp] = decoded.split(':');
        if (tokenCallId !== callId) throw new AppError('Invalid call link', 403);
        if (Date.now() - parseInt(timestamp, 10) > 3_600_000) throw new AppError('Call link has expired', 403);
      }

      const call = await callService.joinCall(callId, userId);
      return res.json({ success: true, data: { call, message: 'Joined call via link' } });
    } catch (error) {
      logger.error('[callController] joinViaLink error:', error);
      next(error);
    }
  }

  // ── getMissedCalls ──────────────────────────────────────────────────────────
  async getMissedCalls(req, res, next) {
    try {
      const userId       = req.user.id;
      const { limit = 50 } = req.query;
      const missedCalls  = await callService.getMissedCalls(userId, parseInt(limit, 10));
      return res.json({ success: true, data: { calls: missedCalls, count: missedCalls.length } });
    } catch (error) {
      logger.error('[callController] getMissedCalls error:', error);
      next(error);
    }
  }

  // ── markCallAsRead ──────────────────────────────────────────────────────────
  async markCallAsRead(req, res, next) {
    try {
      const userId    = req.user.id;
      const { callId } = req.params;
      await callService.markCallAsRead(callId, userId);
      return res.json({ success: true, message: 'Call marked as read' });
    } catch (error) {
      logger.error('[callController] markCallAsRead error:', error);
      next(error);
    }
  }

  // ── getCallHistory ──────────────────────────────────────────────────────────
  async getCallHistory(req, res, next) {
    try {
      const userId          = req.user.id;
      const { page = 1, limit = 50 } = req.query;
      const result          = callService.getCallHistory
        ? await callService.getCallHistory(userId, parseInt(page, 10), parseInt(limit, 10))
        : await callService.getUserCalls(userId, { offset: (parseInt(page, 10) - 1) * parseInt(limit, 10), limit: parseInt(limit, 10) });
      const callsList = Array.isArray(result) ? result : (result.calls || []);
      return res.json({ success: true, data: { calls: callsList } });
    } catch (error) {
      logger.error('[callController] getCallHistory error:', error);
      next(error);
    }
  }
}

module.exports = new CallController();