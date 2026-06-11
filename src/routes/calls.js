/**
 * routes/calls.js
 * FIXED VERSION — patches:
 *  1. All calls to wsService.isUserOnline() are now safe (wrapped in try/catch + fallback)
 *  2. notifyUser() now tries wsService.sendToUser first, then io.to(room).emit fallback
 *  3. Emits both 'call:xxx' AND 'call_xxx' naming conventions on every event so
 *     calls-core.js (underscore) AND chat.html (colon) both get notified.
 *  4. /start route: uses wsService.isUserOnline instead of socketIds array check
 *  5. POST /        route: same fix
 *  6. Adds /socket-register endpoint for frontend to register socket manually
 *  7. Accept / reject / end route: emits via both wsService AND io
 *  8. ADDED: /initiate endpoint alias for frontend compatibility
 */

'use strict';

const path          = require('path');
const asyncHandler  = require('express-async-handler');
const express       = require('express');
const router        = express.Router();

const db            = require('../models');
const User          = db.Users  || db.User;
const Chat          = db.Chats  || db.Chat;
const Call          = db.Calls  || db.Call;

const { apiRateLimiter, callInitiationLimiter } = require('../middleware/rateLimiter');

const Sequelize         = require('sequelize');
const { Op, fn, col, literal } = Sequelize;

// ── Ring Timeout Manager ───────────────────────────────────────────────────────
// Auto-marks unanswered calls as 'missed' after RING_TIMEOUT_MS.
// Prevents zombie 'ringing' records from accumulating in the DB and cleans up
// the caller's UI when the callee never responds.
const RING_TIMEOUT_MS = parseInt(process.env.RING_TIMEOUT_MS, 10) || 45000; // default 45s
const _ringTimers = new Map(); // callId → timer handle

function scheduleRingTimeout(callId, participantIds, ioGetter) {
  if (_ringTimers.has(String(callId))) return; // already scheduled
  const timer = setTimeout(async () => {
    _ringTimers.delete(String(callId));
    try {
      const call = await Call.findOne({
        where: { id: callId, status: { [Op.in]: ['ringing', 'initiated'] } },
      });
      if (!call) return; // Already answered/declined
      call.status  = 'missed';
      call.endedAt = new Date();
      await call.save();

      const io = typeof ioGetter === 'function' ? ioGetter() : null;
      const svc = getWsService && getWsService();
      const payload = { callId, status: 'missed', timestamp: Date.now() };
      const pids = participantIds || call.participants || [];
      for (const pid of pids) {
        if (svc) {
          try { await svc.sendToUser(pid, 'call:missed',    payload); } catch (_) {}
          try { await svc.sendToUser(pid, 'call_missed',    payload); } catch (_) {}
          try { await svc.sendToUser(pid, 'call:cancelled', payload); } catch (_) {}
        }
        if (io) {
          try { io.to(`user:${pid}`).emit('call:missed',    payload); } catch (_) {}
          try { io.to(`user:${pid}`).emit('call_missed',    payload); } catch (_) {}
        }
      }
      console.log(`[RingTimeout] callId=${callId} auto-missed after ${RING_TIMEOUT_MS}ms`);
    } catch (err) {
      console.error('[RingTimeout] error:', err.message);
    }
  }, RING_TIMEOUT_MS);

  _ringTimers.set(String(callId), timer);
}

function cancelRingTimeout(callId) {
  const timer = _ringTimers.get(String(callId));
  if (timer) {
    clearTimeout(timer);
    _ringTimers.delete(String(callId));
  }
}


const CALL_HISTORY_RETENTION_DAYS = parseInt(process.env.CALL_HISTORY_RETENTION_DAYS) || 365;
const MAX_CALL_DURATION           = parseInt(process.env.MAX_CALL_DURATION)            || 14400;

console.log('✅ Calls routes initialized');

// ── CRITICAL FIX: inject req.io on every request so notifyUser always has Socket.IO ──
// server.js sets global.__socketIO when it initializes Socket.IO.
router.use((req, _res, next) => {
  if (!req.io) req.io = global.__socketIO || null;
  next();
});

// ── Lazy wsService (avoids circular-dep at startup) ──────────────────────────
let _wsService = null;
function getWsService() {
  if (!_wsService) {
    try { _wsService = require('../services/webSocketService'); } catch (_) {}
  }
  return _wsService;
}

// ── Safe isUserOnline wrapper ─────────────────────────────────────────────────
async function safeIsUserOnline(userId) {
  const svc = getWsService();
  if (!svc) return true;  // assume online if service unavailable
  try {
    if (typeof svc.isUserOnline === 'function') return !!(await svc.isUserOnline(parseInt(userId, 10)));
    // Legacy fallback
    const uid = parseInt(userId, 10);
    if (svc.onlineUsers instanceof Map && svc.onlineUsers.has(uid)) return true;
    if (svc.userSockets  instanceof Map && svc.userSockets.has(uid))  return true;
  } catch (_) {}
  return true; // final fallback: let the call proceed
}

// ── Bug 4 FIX: Resolve callerName reliably — JWT may not carry username ────────
// JWT middleware sets req.user.username from the token payload, but if the token
// was issued before a username change, or the username field was absent at sign-up,
// it will be null/undefined → callerName shows as "Unknown".
// This helper fetches the authoritative username from the DB as a fallback.
const _callerNameCache = new Map(); // short-lived in-process cache (avoids N+1 per call)
async function resolveCallerName(userId, reqUser, privacyMode = false) {
  // Privacy mode: return anonymous identity
  if (privacyMode) return 'Unknown Caller';
  // Fast path: JWT already has a non-empty username
  const jwtName = (reqUser && (reqUser.username || reqUser.displayName || reqUser.name)) || null;
  if (jwtName && jwtName !== 'Unknown') return jwtName;
  // Cache hit
  if (_callerNameCache.has(userId)) return _callerNameCache.get(userId);
  // DB lookup
  try {
    const caller = await User.findByPk(parseInt(userId, 10), { attributes: ['id', 'username', 'displayName'] });
    const name = (caller && (caller.username || caller.displayName)) || 'Unknown';
    _callerNameCache.set(userId, name);
    setTimeout(() => _callerNameCache.delete(userId), 60000); // expire after 1 min
    return name;
  } catch (_) {
    return jwtName || 'Unknown';
  }
}

// ── Call Privacy Mode ─────────────────────────────────────────────────────────
// When privacy mode is active (req.body.privacyMode === true), the caller's
// name, avatar, and userId are anonymized in the call:incoming payload.
// This allows users to call without revealing their identity until accepted.
function applyPrivacyMode(payload, privacyMode) {
  if (!privacyMode) return payload;
  return {
    ...payload,
    callerName:   'Unknown Caller',
    callerAvatar: null,
    callerId:     0,  // Masked until call is accepted
    privacyMode:  true,
  };
}



const checkAuth = (req, res) => {
  if (!req.user || (!req.user.userId && !req.user.id)) {
    res.status(401).json({ status: 'error', message: 'Authentication required' });
    return null;
  }
  return { userId: req.user.userId || req.user.id };
};

const checkModels = (res) => {
  if (!db || !Call || !User) {
    res.status(503).json({ status: 'error', message: 'Database service not available' });
    return false;
  }
  return true;
};

// ── Unified notifyUser ────────────────────────────────────────────────────────
// Tries wsService first (reaches raw WS + Socket.IO rooms),
// then falls back to io.to(room).emit.
// Emits BOTH colon-style and underscore-style event names.
// FIXED: if io param is null/undefined (req.io not set), pull from global.__socketIO
const notifyUser = async (io, userId, event, data) => {
  const uid = parseInt(userId, 10);
  // FIX-003 (calls.js): Normalize to single canonical colon-style event.
  // Old triple-emit (colon + underscore + original) caused ring twice + black screen on 2nd call.
  const canonicalEvent = event.includes(':') ? event : event.startsWith('call_') ? 'call:' + event.slice(5) : event;

  const resolvedIo = io || global.__socketIO || (getWsService() && getWsService().getIO && getWsService().getIO()) || null;
  const svc = getWsService();

  if (svc && typeof svc.sendToUser === 'function') {
    try { await svc.sendToUser(uid, canonicalEvent, data); return true; } catch (_) {}
  }

  if (resolvedIo) {
    const uidStr = String(uid);
    try { resolvedIo.to(`user:${uid}`).emit(canonicalEvent, data); } catch (_) {}
    try { resolvedIo.to(`user_${uid}`).emit(canonicalEvent, data); } catch (_) {}
    try { resolvedIo.to(`user:${uidStr}`).emit(canonicalEvent, data); } catch (_) {}
    try { resolvedIo.to(`user_${uidStr}`).emit(canonicalEvent, data); } catch (_) {}
    return true;
  }

  console.warn(`[calls.js] notifyUser: no delivery channel for uid=${uid} event=${canonicalEvent}`);
  return false;
};

const isUserParticipant = (call, userId) =>
  !!(call && call.participants && call.participants.includes(userId));

const updateArrayField = async (call, fieldName, userId, action = 'add') => {
  const current = Array.isArray(call[fieldName]) ? [...call[fieldName]] : [];
  if (action === 'add' && !current.includes(userId)) {
    current.push(userId);
    call[fieldName] = current;
    await call.save();
    return true;
  } else if (action === 'remove' && current.includes(userId)) {
    call[fieldName] = current.filter(id => id !== userId);
    await call.save();
    return true;
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// SPECIFIC ROUTES (before wildcard /:callId)
// ─────────────────────────────────────────────────────────────────────────────

// GET /missed/count
router.get('/missed/count', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const missedCount = await Call.count({
      where: {
        participants: { [Op.contains]: [userId] },
        callerId:     { [Op.ne]: userId },
        status:       'missed',
        createdAt:    { [Op.gte]: since },
      },
    });
    res.json({ status: 'success', data: { missedCount: missedCount || 0 } });
  } catch (err) {
    console.error('[GET /missed/count]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch missed calls count' });
  }
}));

// POST /missed/read
router.post('/missed/read', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callIds } = req.body;
    const since       = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const where = callIds && Array.isArray(callIds)
      ? { id: callIds, participants: { [Op.contains]: [userId] }, status: 'missed' }
      : { participants: { [Op.contains]: [userId] }, callerId: { [Op.ne]: userId }, status: 'missed', createdAt: { [Op.gte]: since } };

    const calls = await Call.findAll({ where });
    for (const call of calls) await updateArrayField(call, 'readBy', userId, 'add');

    res.json({ status: 'success', message: 'Missed calls marked as read' });
  } catch (err) {
    console.error('[POST /missed/read]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to mark missed calls as read' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST / — primary call-initiation endpoint used by calls-core.js CALL_INITIATE
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', apiRateLimiter, callInitiationLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const rawType        = req.body.callType || req.body.type || 'audio';
    const callType       = rawType === 'voice' ? 'audio' : rawType;
    const isGroupCall    = req.body.isGroupCall || false;
    const privacyMode    = !!(req.body.privacyMode || req.body.privacy_mode);
    const participantIds = req.body.participantIds || req.body.participants;
    const calleeId       = req.body.calleeId || req.body.userId ||
      (Array.isArray(participantIds) && participantIds.length === 1 ? participantIds[0] : null);

    if (!calleeId && !isGroupCall) {
      return res.status(400).json({ success: false, message: 'calleeId or participantIds is required' });
    }

    const callService = require('../services/callService');

    // ── Group call ────────────────────────────────────────────────────────────
    if (isGroupCall && Array.isArray(participantIds) && participantIds.length > 1) {
      const call = await callService.initiateGroupCall(userId, participantIds.map(Number), callType, null);
      for (const id of participantIds) {
        await notifyUser(req.io, id, 'call_incoming', {
          callId:       call.id,
          callerId:     userId,
          callerName:   req.user.username || 'Unknown',
          callerAvatar: req.user.avatar   || null,
          isGroupCall:  true,
          callType,
          timestamp:    Date.now(),
        });
      }
      return res.status(201).json({ success: true, message: 'Group call initiated', data: { call } });
    }

    // ── 1-to-1 call ──────────────────────────────────────────────────────────
    const targetId = parseInt(calleeId, 10);

    // NOTE: safeIsUserOnline is used ONLY as a hint for the response payload.
    // We ALWAYS create the call record and fire the socket notification regardless,
    // because the online check is unreliable (race conditions, delayed socket registration,
    // cross-server deployments). The 30-second ring timeout handles genuine no-answer cases.
    const isOnline = await safeIsUserOnline(targetId);
    console.log(`[POST /calls] safeIsUserOnline(${targetId}) = ${isOnline} (hint only — call proceeds regardless)`);

    // ── Busy signal: check if the target is already in an active call ────────
    let isBusy = false;
    try {
      const activeCall = await Call.findOne({
        where: {
          status: { [Op.in]: ['ringing', 'in-progress'] },
          [Op.or]: [
            { callerId: targetId },
            { receiverId: targetId },
            { participants: { [Op.contains]: [targetId] } },
          ],
        },
      });
      isBusy = !!activeCall;
    } catch (_) {}

    const call = await callService.initiateCall(userId, targetId, callType, null);

    // Always notify — if they are online, they'll get it; if not, it'll be a missed call
    const _callerDisplayName = await resolveCallerName(userId, req.user);
    const _rawCallPayload = {
      callId:       call.id,
      callerId:     userId,
      callerName:   _callerDisplayName,
      callerAvatar: (call.callerInfo && call.callerInfo.avatar)   || req.user.avatar   || null,
      callType,
      isBusy,
      timestamp:    Date.now(),
    };
    // Apply privacy mode — anonymize caller identity if requested
    const _callIncomingPayload = applyPrivacyMode(_rawCallPayload, privacyMode);

    // If target is busy, notify the CALLER immediately with a busy signal
    // (the call record is still created so it appears in history as missed)
    if (isBusy) {
      await notifyUser(req.io, userId, 'call:busy', {
        callId:   call.id,
        calleeId: targetId,
        message:  'User is currently in another call',
        timestamp: Date.now(),
      });
      await notifyUser(req.io, userId, 'call_busy', {
        callId:   call.id,
        calleeId: targetId,
        message:  'User is currently in another call',
        timestamp: Date.now(),
      });
    }

    await notifyUser(req.io, targetId, 'call_incoming', _callIncomingPayload);
    // FIX: Also emit canonical 'call:incoming' (the frontend listens on this too)
    await notifyUser(req.io, targetId, 'call:incoming', _callIncomingPayload);

    // FIX: If the CallSignalingService is attached, use its initiateCall() which
    // also sets up the call room so webrtc:signal events route correctly.
    try {
        const _sigSvc = global.__CallSignalingService;
        if (_sigSvc && typeof _sigSvc.initiateCall === 'function') {
            // Only call initiateCall if it hasn't already been triggered via socket
            // (socket path: client emits call:initiate → CallSignalingService handles it)
            // HTTP path: no socket event yet, so we call directly
            await _sigSvc.initiateCall(userId, targetId, {
                callId:    call.id,
                callType,
                callerName: _callIncomingPayload.callerName,
            }).catch(() => {});
        }
    } catch(_) {}

    // Schedule auto-miss if no answer within RING_TIMEOUT_MS
    scheduleRingTimeout(call.id, call.participants || [userId, targetId], () => req.io);

    return res.status(201).json({ success: true, message: 'Call initiated', data: { call, receiverOnline: isOnline } });

  } catch (err) {
    console.error('[POST /calls]', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed to initiate call' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /initiate — ALIAS for / endpoint (frontend compatibility)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/initiate', apiRateLimiter, callInitiationLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const rawType        = req.body.callType || req.body.type || 'audio';
    const callType       = rawType === 'voice' ? 'audio' : rawType;
    const isGroupCall    = req.body.isGroupCall || false;
    const participantIds = req.body.participantIds || req.body.participants;
    const calleeId       = req.body.calleeId || req.body.userId ||
      (Array.isArray(participantIds) && participantIds.length === 1 ? participantIds[0] : null);

    if (!calleeId && !isGroupCall) {
      return res.status(400).json({ success: false, message: 'calleeId or participantIds is required' });
    }

    const callService = require('../services/callService');

    // ── Group call ────────────────────────────────────────────────────────────
    if (isGroupCall && Array.isArray(participantIds) && participantIds.length > 1) {
      const call = await callService.initiateGroupCall(userId, participantIds.map(Number), callType, null);
      for (const id of participantIds) {
        await notifyUser(req.io, id, 'call_incoming', {
          callId:       call.id,
          callerId:     userId,
          callerName:   req.user.username || req.user.displayName || 'Unknown', // Bug4: JWT fallback
          callerAvatar: req.user.avatar   || null,
          isGroupCall:  true,
          callType,
          timestamp:    Date.now(),
        });
      }
      return res.status(201).json({ success: true, message: 'Group call initiated', data: { call } });
    }

    // ── 1-to-1 call ──────────────────────────────────────────────────────────
    const targetId = parseInt(calleeId, 10);
    const isOnline = await safeIsUserOnline(targetId);
    console.log(`[POST /calls/initiate] safeIsUserOnline(${targetId}) = ${isOnline}`);

    const call = await callService.initiateCall(userId, targetId, callType, null);

    const _callerDisplayName = await resolveCallerName(userId, req.user);
    const _initPayload = {
      callId:       call.id,
      callerId:     userId,
      callerName:   _callerDisplayName,
      callerAvatar: (call.callerInfo && call.callerInfo.avatar) || req.user.avatar || null,
      callType,
      timestamp:    Date.now(),
    };

    // Emit BOTH naming conventions — calls-core.js uses call:incoming, legacy uses call_incoming
    await notifyUser(req.io, targetId, 'call_incoming', _initPayload);
    await notifyUser(req.io, targetId, 'call:incoming', _initPayload);

    return res.status(201).json({ success: true, message: 'Call initiated', data: { call, receiverOnline: isOnline } });

  } catch (err) {
    console.error('[POST /calls/initiate]', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed to initiate call' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /history
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { page = 1, limit = 20, callType, direction, participantId, startDate, endDate, status } = req.query;
    const offset       = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const parsedLimit  = parseInt(limit, 10);

    const where = {
      participants: { [Op.contains]: [userId] },
      status:       { [Op.in]: ['completed', 'missed', 'cancelled', 'rejected', 'failed'] },
    };

    if (callType && callType !== 'all') where.type = callType;
    if (status   && status   !== 'all') where.status = status;

    if (direction === 'incoming')      where.callerId = { [Op.ne]: userId };
    else if (direction === 'outgoing') where.callerId = userId;
    else if (direction === 'missed')   where.status   = 'missed';

    if (participantId) {
      where[Op.and] = [
        { participants: { [Op.contains]: [parseInt(participantId, 10)] } },
        { participants: { [Op.contains]: [userId] } },
      ];
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = new Date(startDate);
      if (endDate)   where.createdAt[Op.lte] = new Date(endDate);
    }

    const { count, rows: calls } = await Call.findAndCountAll({ where, order: [['createdAt', 'DESC']], offset, limit: parsedLimit, distinct: true });

    // Enrich with user data
    const allIds     = [...new Set((calls || []).flatMap(c => c.participants || []))];
    const userMap    = {};
    if (allIds.length > 0) {
      const users = await User.findAll({ where: { id: allIds }, attributes: ['id', 'username', 'avatar'] });
      users.forEach(u => { userMap[u.id] = u; });
    }

    const enriched = (calls || []).map(call => {
      const obj            = call.toJSON ? call.toJSON() : { ...(call.dataValues || call) };
      obj.direction        = call.callerId === userId ? 'outgoing' : 'incoming';
      obj.isMissed         = obj.status === 'missed';
      const dur            = (obj.startedAt && obj.endedAt)
        ? Math.max(0, Math.floor((new Date(obj.endedAt) - new Date(obj.startedAt)) / 1000))
        : 0;
      obj.duration         = dur;
      obj.displayDuration  = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;
      obj.participantUsers = (obj.participants || []).map(id => userMap[id] || { id, username: 'Unknown' });
      obj.otherParticipants= obj.participantUsers.filter(p => p.id !== userId);
      obj.caller           = userMap[call.callerId] || { id: call.callerId, username: 'Unknown' };
      return obj;
    });

    // Statistics (last 30 days)
    let stats = { totalCalls: 0, totalDuration: 0, completedCalls: 0, missedCalls: 0 };
    try {
      const allCalls = await Call.findAll({
        where: { participants: { [Op.contains]: [userId] }, createdAt: { [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, endedAt: { [Op.ne]: null } },
        attributes: ['status', 'startedAt', 'endedAt'],
      });
      stats.totalCalls     = allCalls.length;
      stats.completedCalls = allCalls.filter(c => c.status === 'completed').length;
      stats.missedCalls    = allCalls.filter(c => c.status === 'missed').length;
      stats.totalDuration  = allCalls.reduce((sum, c) => {
        if (c.status !== 'completed' || !c.startedAt || !c.endedAt) return sum;
        const d = Math.floor((new Date(c.endedAt) - new Date(c.startedAt)) / 1000);
        return sum + (d > 0 ? d : 0);
      }, 0);
    } catch (_) {}

    const paginationMeta = {
      total: count,
      page:  parseInt(page, 10),
      limit: parsedLimit,
      pages: Math.ceil(count / parsedLimit),
    };

    // Standard pagination headers (used by frontend infinite-scroll and admin panels)
    res.setHeader('X-Total-Count',  count);
    res.setHeader('X-Page',         parseInt(page, 10));
    res.setHeader('X-Per-Page',     parsedLimit);
    res.setHeader('X-Total-Pages',  paginationMeta.pages);

    res.json({ status: 'success', data: { calls: enriched, statistics: stats, pagination: paginationMeta } });
  } catch (err) {
    console.error('[GET /history]', err.message, err.stack);
    res.status(500).json({ status: 'error', message: 'Failed to fetch call history' });
  }
}));

// GET /stats/summary
router.get('/stats/summary', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { period = '30d' } = req.query;
    const periodDays = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period];
    if (!periodDays) return res.status(400).json({ status: 'error', message: 'Invalid period. Use: 7d, 30d, 90d, 365d' });

    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const calls  = await Call.findAll({
      where: { participants: { [Op.contains]: [userId] }, createdAt: { [Op.gte]: since }, endedAt: { [Op.ne]: null } },
      attributes: ['status', 'type', 'startedAt', 'endedAt'],
    });

    const overall  = { totalCalls: calls.length, totalDuration: 0, avgDuration: 0, longestCall: 0, shortestCall: Infinity };
    const typeMap  = new Map();

    for (const c of calls) {
      const dur = (c.startedAt && c.endedAt) ? Math.max(0, Math.floor((new Date(c.endedAt) - new Date(c.startedAt)) / 1000)) : 0;
      if (dur > 0) { overall.totalDuration += dur; overall.longestCall = Math.max(overall.longestCall, dur); overall.shortestCall = Math.min(overall.shortestCall, dur); }
      const t = c.type || 'audio';
      if (!typeMap.has(t)) typeMap.set(t, { count: 0, totalDuration: 0 });
      const ts = typeMap.get(t); ts.count++; if (dur > 0) ts.totalDuration += dur;
    }

    if (overall.totalCalls > 0) overall.avgDuration = Math.floor(overall.totalDuration / overall.totalCalls);
    if (overall.shortestCall === Infinity) overall.shortestCall = 0;

    const typeBreakdown = Array.from(typeMap.entries()).map(([type, s]) => ({
      type, count: s.count, avgDuration: s.count > 0 ? Math.floor(s.totalDuration / s.count) : 0,
    }));

    res.json({ status: 'success', data: { period, overall, typeBreakdown } });
  } catch (err) {
    console.error('[GET /stats/summary]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch call statistics' });
  }
}));

// GET /export
router.get('/export', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { format = 'json', startDate, endDate } = req.query;
    const where = { participants: { [Op.contains]: [userId] } };
    if (startDate) where.createdAt = { ...where.createdAt, [Op.gte]: new Date(startDate) };
    if (endDate)   where.createdAt = { ...where.createdAt, [Op.lte]: new Date(endDate)   };

    const calls   = await Call.findAll({ where, order: [['createdAt', 'DESC']] });
    const allIds  = [...new Set((calls || []).flatMap(c => c.participants || []))];
    const userMap = {};
    if (allIds.length > 0) {
      const users = await User.findAll({ where: { id: allIds }, attributes: ['id', 'username', 'email'] });
      users.forEach(u => { userMap[u.id] = u; });
    }

    const exportData = (calls || []).map(call => {
      const obj          = call.toJSON ? call.toJSON() : { ...(call.dataValues || call) };
      const pUsers       = (obj.participants || []).map(id => ({ id, username: userMap[id] && userMap[id].username || 'Unknown', email: userMap[id] && userMap[id].email || '' }));
      return { callId: obj.id, callType: obj.type, status: obj.status, startedAt: obj.startedAt, endedAt: obj.endedAt, duration: obj.duration, caller: pUsers.find(p => p.id === obj.callerId) || { id: obj.callerId, username: 'Unknown' }, participants: pUsers };
    });

    if (format === 'csv') {
      const csv = [
        'callId,callType,status,startedAt,endedAt,duration,caller,participants',
        ...exportData.map(d => `"${d.callId}","${d.callType}","${d.status}","${d.startedAt || ''}","${d.endedAt || ''}","${d.duration || 0}","${d.caller.username}","${d.participants.map(p => p.username).join('; ')}"`),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=calls_${new Date().toISOString().split('T')[0]}.csv`);
      return res.send(csv);
    }
    res.json({ status: 'success', data: { exportedAt: new Date(), totalCalls: exportData.length, calls: exportData } });
  } catch (err) {
    console.error('[GET /export]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to export call history' });
  }
}));

// POST /:callId/rate — Submit post-call quality rating
router.post('/:callId/rate', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const { rating, feedback } = req.body;

    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'rating must be a number between 1 and 5' });
    }

    const call = await Call.findOne({
      where: {
        id: callId,
        [Op.or]: [
          { callerId: userId },
          { receiverId: userId },
          { participants: { [Op.contains]: [userId] } },
        ],
      },
    });

    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    await call.update({
      postCallRating:   Math.round(rating),
      postCallFeedback: feedback || null,
    });

    res.json({ success: true, message: 'Rating submitted', data: { callId, rating, feedback } });
  } catch (err) {
    console.error('[POST /:callId/rate]', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit rating' });
  }
}));

// DELETE /history
router.delete('/history', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callIds, deleteAll = false, olderThanDays } = req.body;

    if (deleteAll) {
      const n = await Call.destroy({ where: { participants: { [Op.contains]: [userId] } } });
      return res.json({ status: 'success', message: `Deleted ${n} calls`, data: { deletedCount: n } });
    }
    if (olderThanDays) {
      const days = parseInt(olderThanDays, 10);
      if (isNaN(days) || days < 1) return res.status(400).json({ status: 'error', message: 'olderThanDays must be positive' });
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const n = await Call.destroy({ where: { participants: { [Op.contains]: [userId] }, createdAt: { [Op.lt]: cutoff } } });
      return res.json({ status: 'success', message: `Deleted ${n} calls older than ${days} days`, data: { deletedCount: n } });
    }
    if (callIds && Array.isArray(callIds)) {
      const n = await Call.destroy({ where: { id: callIds, participants: { [Op.contains]: [userId] } } });
      return res.json({ status: 'success', message: `Deleted ${n} calls`, data: { deletedCount: n } });
    }
    res.status(400).json({ status: 'error', message: 'Provide callIds, deleteAll=true, or olderThanDays' });
  } catch (err) {
    console.error('[DELETE /history]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to delete call history' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /start  (alternate initiation from chat.html / direct call)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/start', apiRateLimiter, callInitiationLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { participantIds, chatId, callType = 'audio', isGroupCall = false } = req.body;

    if (!Array.isArray(participantIds) && !chatId) {
      return res.status(400).json({ status: 'error', message: 'Either participantIds or chatId is required' });
    }
    if (callType !== 'audio' && callType !== 'video') {
      return res.status(400).json({ status: 'error', message: 'Call type must be audio or video' });
    }

    let participants = [];

    if (chatId) {
      const chat = await Chat.findByPk(chatId);
      if (!chat) return res.status(404).json({ status: 'error', message: 'Chat not found' });
      // Collect participant IDs from ChatParticipants if available
      const ChatParticipant = db.ChatParticipants || db.ChatParticipant;
      if (ChatParticipant) {
        const cpRows = await ChatParticipant.findAll({ where: { chatId }, attributes: ['userId'] });
        participants = cpRows.map(r => r.userId).filter(id => id !== userId);
      }
    } else {
      participants = participantIds.filter(id => parseInt(id, 10) !== parseInt(userId, 10)).map(Number);
    }

    if (participants.length === 0) {
      return res.status(400).json({ status: 'error', message: 'At least one participant is required' });
    }

    const call = await Call.create({
      callerId:    userId,
      receiverId:  participants.length === 1 ? participants[0] : null,
      chatId:      chatId || null,
      type:        callType,
      status:      'ringing',
      isGroupCall: isGroupCall || participants.length > 1,
      participants: [userId, ...participants],
      answeredBy:  [],
      declinedBy:  [],
      readBy:      [],
      startedAt:   null,
      metadata:    { ringStartedAt: new Date().toISOString() },
    });

    const caller = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });

    // FIX-AUDIT-7: Batch parallel delivery — no N+1 sequential awaits
    const _callIncomingPayload = {
      callId:       call.id,
      callerId:     userId,
      callerName:   caller && caller.username || 'Unknown',
      callerAvatar: caller && caller.avatar   || null,
      callType,
      isGroupCall,
      chatId:       chatId || null,
      timestamp:    new Date(),
    };
    await Promise.allSettled(
      participants.map(pid => notifyUser(req.io, pid, 'call_incoming', _callIncomingPayload))
    );

    res.status(201).json({
      status:  'success',
      message: 'Call started',
      data:    { callId: call.id, call: { id: call.id, callerId: call.callerId, receiverId: call.receiverId, type: call.type, status: call.status, participants: [userId, ...participants] } },
    });
  } catch (err) {
    console.error('[POST /start]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to start call' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PARAMETERIZED ROUTES  /:callId/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /:callId
router.get('/:callId', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [userId] } } });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or access denied' });

    const pIds   = call.participants || [];
    const pUsers = pIds.length ? await User.findAll({ where: { id: pIds }, attributes: ['id', 'username', 'avatar'] }) : [];
    const pMap   = {};
    pUsers.forEach(u => { pMap[u.id] = { id: u.id, username: u.username, avatar: u.avatar }; });

    const obj           = call.toJSON ? call.toJSON() : { ...(call.dataValues || call) };
    obj.direction       = call.callerId === userId ? 'outgoing' : 'incoming';
    obj.caller          = pMap[call.callerId] || { id: call.callerId, username: 'Unknown' };
    obj.participantUsers = pIds.map(id => pMap[id] || { id, username: 'Unknown' });
    obj.otherParticipants = obj.participantUsers.filter(p => p.id !== userId);
    obj.isMissed        = obj.status === 'missed';
    const dur           = (call.startedAt && call.endedAt) ? Math.max(0, Math.floor((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)) : 0;
    obj.duration        = dur;
    obj.displayDuration = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;

    res.json({ status: 'success', data: { call: obj } });
  } catch (err) {
    console.error('[GET /:callId]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch call details' });
  }
}));

// POST /:callId/accept
router.post('/:callId/accept', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const { sdpAnswer } = req.body;

    const call = await Call.findOne({
      where: { id: callId, participants: { [Op.contains]: [userId] }, status: { [Op.in]: ['ringing', 'initiated'] } },
    });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or already answered' });

    // Update
    await updateArrayField(call, 'answeredBy', userId, 'add');
    if (call.status !== 'in-progress') {
      call.status    = 'in-progress';
      call.startedAt = new Date();
      if (sdpAnswer) call.sdpAnswer = sdpAnswer;
      await call.save();
    }

    const user = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });

    if (call.isGroupCall || (call.participants || []).length > 2) {
      for (const pid of (call.participants || [])) {
        await notifyUser(req.io, pid, 'call_participant_joined', {
          callId: call.id,
          userId,
          userName: user ? user.username : (req.user.username || req.user.displayName || `User ${userId}`),
          userAvatar: user ? user.avatar : (req.user.avatar || null),
          callType: call.type,
          timestamp: new Date()
        });
      }
    }

    // Notify all participants
    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call_accepted', {
        callId:     call.id,
        answeredBy: user ? { id: user.id, username: user.username, avatar: user.avatar } : { id: userId },
        status:     call.status,
        startedAt:  call.startedAt,
        timestamp:  new Date(),
      });
    }

    res.json({ status: 'success', message: 'Call accepted', data: { call: { id: call.id, status: call.status, callId: call.id } } });
  } catch (err) {
    console.error('[POST /:callId/accept]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to accept call' });
  }
}));

// POST /:callId/answer — alias for /accept (chat.html calls this endpoint)
router.post('/:callId/answer', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const { sdpAnswer } = req.body;

    const call = await Call.findOne({
      where: { id: callId, participants: { [Op.contains]: [userId] }, status: { [Op.in]: ['ringing', 'initiated'] } },
    });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or already answered' });

    await updateArrayField(call, 'answeredBy', userId, 'add');
    if (call.status !== 'in-progress') {
      call.status    = 'in-progress';
      call.startedAt = new Date();
      if (sdpAnswer) call.sdpAnswer = sdpAnswer;
      await call.save();
    }
    // Cancel ring timeout now that call is answered
    cancelRingTimeout(callId);

    const user = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] }).catch(() => null);
    const answererInfo = user
      ? { id: user.id, username: user.username, avatar: user.avatar }
      : { id: userId, username: req.user.username || `User ${userId}` };

    // Notify all participants of acceptance (group or 1-on-1)
    if (call.isGroupCall || (call.participants || []).length > 2) {
      for (const pid of (call.participants || [])) {
        await notifyUser(req.io, pid, 'call:participant_joined', {
          callId: call.id,
          userId,
          userName:   answererInfo.username,
          userAvatar: answererInfo.avatar || null,
          callType:   call.type,
          timestamp:  new Date(),
        });
      }
    }

    const acceptPayload = {
      callId:     call.id,
      answeredBy: answererInfo,
      status:     call.status,
      startedAt:  call.startedAt,
      timestamp:  new Date(),
    };

    for (const pid of (call.participants || [])) {
      // Canonical colon-style (new frontend)
      await notifyUser(req.io, pid, 'call:accepted',  acceptPayload);
      await notifyUser(req.io, pid, 'call:answered',  acceptPayload);
      // Legacy underscore-style (old listeners)
      await notifyUser(req.io, pid, 'call_accepted',  acceptPayload);
    }

    res.json({ status: 'success', message: 'Call answered', data: { call: { id: call.id, status: call.status, callId: call.id } } });
  } catch (err) {
    console.error('[POST /:callId/answer]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to answer call' });
  }
}));

// POST /:callId/reject
router.post('/:callId/reject', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId }          = req.params;
    const { reason = 'declined' } = req.body;

    const call = await Call.findOne({
      where: { id: callId, participants: { [Op.contains]: [userId] }, status: { [Op.in]: ['ringing', 'initiated', 'in-progress'] } },
    });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or already ended' });

    await updateArrayField(call, 'declinedBy', userId, 'add');
    // Cancel ring timeout since call is being declined
    cancelRingTimeout(callId);

    if (call.callerId === userId) {
      call.status  = 'cancelled';
      call.endedAt = new Date();
    } else {
      const remaining = (call.participants || []).filter(p => p !== call.callerId && !(call.answeredBy || []).includes(p) && !(call.declinedBy || []).includes(p));
      if (remaining.length === 0 && (call.answeredBy || []).length === 0) {
        call.status  = 'missed';
        call.endedAt = new Date();
      }
    }
    await call.save();

    const user = await User.findByPk(userId, { attributes: ['id', 'username'] }).catch(() => null);
    const declinePayload = {
      callId:     call.id,
      rejectedBy: user ? { id: user.id, username: user.username } : { id: userId },
      reason,
      status:     call.status,
      timestamp:  new Date(),
    };

    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call:declined',  declinePayload);
      await notifyUser(req.io, pid, 'call_rejected',  declinePayload);
    }

    if (call.status === 'cancelled' || call.status === 'missed') {
      const cancelPayload = { callId: call.id, status: call.status, timestamp: new Date() };
      for (const pid of (call.participants || [])) {
        await notifyUser(req.io, pid, 'call:cancelled', cancelPayload);
        await notifyUser(req.io, pid, 'call_cancelled', cancelPayload);
      }
    }

    res.json({ status: 'success', message: 'Call rejected', data: { status: call.status } });
  } catch (err) {
    console.error('[POST /:callId/reject]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to reject call' });
  }
}));

// POST /:callId/end
router.post('/:callId/end', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId }                        = req.params;
    const { duration, status: callEndStatus } = req.body;

    // FIX: Frontend sends local IDs like "call_1780799144203_x021is" which are NOT UUIDs.
    // Also use OR on callerId/receiverId as fallback when Op.contains is unavailable.
    let call = null;
    try {
      call = await Call.findOne({
        where: {
          [Op.or]: [
            { id: callId },
            // If the caller passes a local ID that maps via __callIdMap, the parent
            // already translates it — but fall back to a recent-call lookup by caller
            { callerId: userId, status: { [Op.in]: ['initiated', 'ringing', 'in-progress'] } },
          ]
        }
      });
    } catch (_) {
      // UUID parse error — try plain id lookup without Op.contains
      try { call = await Call.findOne({ where: { id: callId } }); } catch (__) {}
    }

    // If still not found, try matching the most-recent active call for this user
    if (!call) {
      call = await Call.findOne({
        where: {
          [Op.or]: [
            { callerId: userId },
            { receiverId: userId },
          ],
          status: { [Op.in]: ['initiated', 'ringing', 'in-progress'] },
        },
        order: [['createdAt', 'DESC']],
      }).catch(() => null);
    }

    if (!call) {
      // Nothing to end — respond success so UI clears the calling state
      return res.json({ status: 'success', message: 'Call already ended or not found', data: { callId, duration: 0, status: 'ended' } });
    }

    // Calc duration
    let actualDuration = duration;
    if (!actualDuration && call.startedAt) {
      actualDuration = Math.max(0, Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000));
    }

    // Final status
    let finalStatus = callEndStatus || call.status;
    if (!callEndStatus) {
      if (call.status === 'ringing' && (!call.answeredBy || call.answeredBy.length === 0)) {
        finalStatus = (Date.now() - new Date(call.createdAt).getTime()) > 60000 ? 'missed' : 'cancelled';
      } else if (['ongoing', 'in-progress'].includes(call.status)) {
        finalStatus = actualDuration > 0 ? 'completed' : 'failed';
      }
    }

    call.status  = finalStatus;
    call.endedAt = new Date();
    if (actualDuration > 0) call.duration = actualDuration;
    await call.save();

    const user = await User.findByPk(userId, { attributes: ['id', 'username'] });
    const eventData = {
      callId:    call.id,
      endedBy:   user ? { id: user.id, username: user.username } : { id: userId },
      duration:  actualDuration,
      status:    finalStatus,
      timestamp: new Date(),
    };

    for (const pid of (call.participants || [])) {
      // Canonical event (frontend's primary listener)
      await notifyUser(req.io, pid, 'call:ended',  eventData);
      // Legacy event for backward compat with older listeners
      await notifyUser(req.io, pid, 'call_ended',  eventData);
    }

    res.json({ status: 'success', message: 'Call ended', data: { callId: call.id, duration: actualDuration, status: finalStatus } });
  } catch (err) {
    console.error('[POST /:callId/end]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to end call' });
  }
}));

// POST /:callId/signal  — WebRTC signaling relay
router.post('/:callId/signal', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId }  = req.params;
    const { type, sdp, candidate, targetUserId } = req.body;

    if (!type) return res.status(400).json({ status: 'error', message: 'Signal type is required' });

    const call = await Call.findOne({
      where: { id: callId, participants: { [Op.contains]: [userId] }, status: { [Op.in]: ['ringing', 'in-progress'] } },
    });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or not active' });

    // Persist SDP
    if (type === 'offer'  && sdp) { call.sdpOffer  = sdp; await call.save(); }
    if (type === 'answer' && sdp) { call.sdpAnswer = sdp; await call.save(); }
    if (type === 'ice' && candidate) {
      call.iceCandidates = [...(call.iceCandidates || []), { userId, candidate, timestamp: new Date() }];
      await call.save();
    }

    // Forward to target(s)
    const targets = targetUserId
      ? [parseInt(targetUserId, 10)]
      : (call.participants || []).filter(id => id !== userId);

    const payload = { callId, fromUserId: userId, type, sdp, candidate, timestamp: Date.now() };
    for (const tid of targets) {
      await notifyUser(req.io, tid, 'webrtc_signal', payload);
      await notifyUser(req.io, tid, 'webrtc:signal', payload);
    }

    res.json({ status: 'success', message: 'Signal relayed' });
  } catch (err) {
    console.error('[POST /:callId/signal]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to relay signal' });
  }
}));

// GET /:callId/signal — Retrieve stored SDP offer/answer and ICE candidates for late-join
// Fixes: "SDP stored but never served back" audit issue — peer can now poll this if they
// missed the Socket.IO signal event (e.g. cold-start, brief disconnect).
router.get('/:callId/signal', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const call = await Call.findOne({
      where: {
        id: callId,
        [Op.or]: [
          { callerId: userId },
          { receiverId: userId },
          { participants: { [Op.contains]: [userId] } },
        ],
      },
      attributes: ['id', 'sdpOffer', 'sdpAnswer', 'iceCandidates', 'callerId', 'status'],
    });

    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found' });

    res.json({
      status:   'success',
      data: {
        callId,
        sdpOffer:      call.sdpOffer  || null,
        sdpAnswer:     call.sdpAnswer || null,
        iceCandidates: call.iceCandidates || [],
        callerId:      call.callerId,
        callStatus:    call.status,
      },
    });
  } catch (err) {
    console.error('[GET /:callId/signal]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to retrieve signal data' });
  }
}));

// POST /:callId/stats — Store real-time network quality metrics
router.post('/:callId/stats', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const { rtt, packetLoss, jitter, bitrate, qualityLevel, timestamp } = req.body;

    const call = await Call.findOne({
      where: {
        id: callId,
        [Op.or]: [
          { callerId: userId },
          { receiverId: userId },
          { participants: { [Op.contains]: [userId] } },
        ],
      },
    });

    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    // Merge stats snapshot into networkStats JSONB
    const existingStats = call.networkStats || {};
    const snapshots = existingStats.snapshots || [];
    snapshots.push({ userId, rtt, packetLoss, jitter, bitrate, qualityLevel, ts: timestamp || Date.now() });
    // Keep only last 20 snapshots to cap JSONB size
    if (snapshots.length > 20) snapshots.splice(0, snapshots.length - 20);

    // Compute running quality score (0-5) from packetLoss + rtt
    let score = 5;
    if (packetLoss > 0.05) score -= 1;
    if (packetLoss > 0.10) score -= 1;
    if (rtt > 150) score -= 0.5;
    if (rtt > 300) score -= 1;
    score = Math.max(1, Math.min(5, score));

    await call.update({
      networkStats: { ...existingStats, snapshots, lastUpdated: Date.now() },
      qualityScore: score,
    });

    res.json({ success: true, message: 'Stats recorded', data: { qualityScore: score } });
  } catch (err) {
    console.error('[POST /:callId/stats]', err.message);
    res.status(500).json({ success: false, message: 'Failed to store stats' });
  }
}));

// POST /:callId/ice  — ICE candidate
router.post('/:callId/ice', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId }     = req.params;
    const { candidate }  = req.body;
    if (!candidate) return res.status(400).json({ status: 'error', message: 'candidate is required' });

    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [userId] } } });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found' });

    call.iceCandidates = [...(call.iceCandidates || []), { userId, candidate, timestamp: new Date() }];
    await call.save();

    const targets = (call.participants || []).filter(id => id !== userId);
    for (const tid of targets) {
      await notifyUser(req.io, tid, 'webrtc_signal', { callId, fromUserId: userId, type: 'ice', candidate, timestamp: Date.now() });
    }

    res.json({ status: 'success', message: 'ICE candidate stored' });
  } catch (err) {
    console.error('[POST /:callId/ice]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to store ICE candidate' });
  }
}));

// POST /:callId/cancel
router.post('/:callId/cancel', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const call = await Call.findOne({
      where: { id: callId, callerId: userId, status: { [Op.in]: ['ringing', 'initiated'] } },
    });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or cannot be cancelled' });

    call.status  = 'cancelled';
    call.endedAt = new Date();
    await call.save();

    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call_cancelled', { callId: call.id, status: 'cancelled', timestamp: new Date() });
    }

    res.json({ status: 'success', message: 'Call cancelled' });
  } catch (err) {
    console.error('[POST /:callId/cancel]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to cancel call' });
  }
}));

// POST /:callId/join
router.post('/:callId/join', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const call = await Call.findOne({ where: { id: callId, status: 'in-progress' } });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found or not in progress' });

    if (!call.participants.includes(userId)) call.participants = [...call.participants, userId];
    await updateArrayField(call, 'answeredBy', userId, 'add');

    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call_participant_joined', {
        callId: call.id,
        userId,
        userName: req.user.username || req.user.displayName || `User ${userId}`,
        callType: call.type,
        timestamp: new Date()
      });
    }

    res.json({ status: 'success', message: 'Joined call', data: { callId: call.id } });
  } catch (err) {
    console.error('[POST /:callId/join]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to join call' });
  }
}));

// POST /:callId/participants
router.post('/:callId/participants', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const {
      targetUserId,
      targetUserName = null,
      callType = 'audio'
    } = req.body || {};

    const normalizedTargetUserId = parseInt(targetUserId, 10);
    if (!normalizedTargetUserId) {
      return res.status(400).json({ status: 'error', message: 'targetUserId is required' });
    }
    if (normalizedTargetUserId === userId) {
      return res.status(400).json({ status: 'error', message: 'Cannot invite yourself to the call' });
    }

    const call = await Call.findOne({
      where: {
        id: callId,
        participants: { [Op.contains]: [userId] },
        status: { [Op.in]: ['ringing', 'initiated', 'in-progress'] }
      }
    });
    if (!call) {
      return res.status(404).json({ status: 'error', message: 'Call not found or not active' });
    }

    const targetUser = await User.findByPk(normalizedTargetUserId, { attributes: ['id', 'username', 'avatar'] });
    if (!targetUser) {
      return res.status(404).json({ status: 'error', message: 'Target user not found' });
    }

    const caller = await User.findByPk(call.callerId, { attributes: ['id', 'username', 'avatar'] });
    const alreadyParticipant = (call.participants || []).includes(normalizedTargetUserId);

    if (!alreadyParticipant) {
      call.participants = [...new Set([...(call.participants || []), normalizedTargetUserId])];
      call.isGroupCall = true;
      call.metadata = {
        ...(call.metadata || {}),
        lastInviteAt: new Date().toISOString(),
        lastInvitedUserId: normalizedTargetUserId
      };
      await call.save();
    }

    const invitePayload = {
      callId: call.id,
      callerId: call.callerId,
      callerName: (caller && caller.username) || req.user.username || req.user.displayName || 'Unknown',
      callerAvatar: (caller && caller.avatar) || req.user.avatar || null,
      callType: call.type || callType,
      type: call.type || callType,
      isGroupCall: true,
      participantIds: call.participants || [],
      invitedBy: userId,
      targetUserId: normalizedTargetUserId,
      targetUserName: targetUserName || targetUser.username || 'User',
      timestamp: new Date()
    };

    await notifyUser(req.io, normalizedTargetUserId, 'call_incoming', invitePayload);
    await notifyUser(req.io, normalizedTargetUserId, 'call:ringing', invitePayload);

    for (const pid of (call.participants || []).filter(pid => pid !== normalizedTargetUserId)) {
      await notifyUser(req.io, pid, 'call_participant_joined', {
        callId: call.id,
        userId: normalizedTargetUserId,
        userName: targetUser.username || 'User',
        userAvatar: targetUser.avatar || null,
        callType: call.type || callType,
        pending: true,
        invited: true,
        timestamp: new Date()
      });
    }

    res.status(alreadyParticipant ? 200 : 201).json({
      status: 'success',
      message: alreadyParticipant ? 'Participant already in call' : 'Participant invited',
      data: {
        callId: call.id,
        targetUser: { id: targetUser.id, username: targetUser.username, avatar: targetUser.avatar },
        participants: call.participants || []
      }
    });
  } catch (err) {
    console.error('[POST /:callId/participants]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to invite participant' });
  }
}));

// POST /:callId/leave
router.post('/:callId/leave', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { callId } = req.params;
    const call = await Call.findOne({ where: { id: callId, status: 'in-progress' } });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found' });

    call.answeredBy = (call.answeredBy || []).filter(id => id !== userId);
    if (call.answeredBy.length === 0) {
      call.status  = 'completed';
      call.endedAt = new Date();
      if (call.startedAt) call.duration = Math.max(0, Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000));
      for (const pid of (call.participants || [])) {
        const _endedPayload = { callId: call.id, status: 'completed', timestamp: new Date() };
        await notifyUser(req.io, pid, 'call:ended', _endedPayload);
        await notifyUser(req.io, pid, 'call_ended', _endedPayload);
      }
    } else {
      for (const pid of (call.participants || [])) {
        await notifyUser(req.io, pid, 'call_participant_left', {
          callId: call.id,
          userId,
          userName: req.user.username || req.user.displayName || `User ${userId}`,
          callType: call.type,
          timestamp: new Date()
        });
      }
    }
    await call.save();
    res.json({ status: 'success', message: 'Left call' });
  } catch (err) {
    console.error('[POST /:callId/leave]', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to leave call' });
  }
}));

// ── GET /api/calls/ice-config — Return STUN/TURN server credentials ──────────
// Called by calls-core.js after initiating/accepting a call (event: turn:config).
// If TURN_SECRET is not set, returns free STUN servers only.
// GET /scheduled — List upcoming scheduled calls for the current user
router.get('/scheduled', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const now = new Date();
    const calls = await Call.findAll({
      where: {
        scheduledAt: { [Op.gte]: now },
        status: 'initiated',
        [Op.or]: [
          { callerId: userId },
          { participants: { [Op.contains]: [userId] } },
        ],
      },
      order: [['scheduledAt', 'ASC']],
      limit: 50,
    });

    // Enrich with caller info
    const enriched = await Promise.all(calls.map(async (c) => {
      let callerInfo = null;
      try {
        const u = await User.findByPk(c.callerId, { attributes: ['id', 'username', 'avatar'] });
        callerInfo = u ? u.toJSON() : null;
      } catch (_) {}
      return { ...c.toJSON(), callerInfo };
    }));

    res.json({ success: true, data: { calls: enriched, total: enriched.length } });
  } catch (err) {
    console.error('[GET /scheduled]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch scheduled calls' });
  }
}));

// POST /schedule — Create a scheduled call
router.post('/schedule', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;

    const { participantIds, callType = 'audio', scheduledAt, title } = req.body;
    if (!scheduledAt) {
      return res.status(400).json({ success: false, message: 'scheduledAt is required' });
    }
    const scheduledTime = new Date(scheduledAt);
    if (isNaN(scheduledTime.getTime()) || scheduledTime <= new Date()) {
      return res.status(400).json({ success: false, message: 'scheduledAt must be a future date' });
    }
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ success: false, message: 'participantIds is required' });
    }

    const allParticipants = [userId, ...participantIds.map(Number).filter(id => id !== userId)];
    const isGroup = allParticipants.length > 2;

    const call = await Call.create({
      callerId:      userId,
      receiverId:    !isGroup ? allParticipants.find(id => id !== userId) : null,
      type:          callType === 'voice' ? 'audio' : callType,
      status:        'initiated',
      isGroupCall:   isGroup,
      participants:  allParticipants,
      answeredBy:    [],
      declinedBy:    [],
      readBy:        [],
      scheduledAt:   scheduledTime,
      scheduledTitle: title || null,
      metadata:      { scheduledBy: userId, scheduledAt: scheduledTime.toISOString() },
    });

    // Notify participants of scheduled call
    const callerName = await resolveCallerName(userId, req.user);
    const payload = {
      callId:        call.id,
      callerId:      userId,
      callerName,
      callType,
      isGroupCall:   isGroup,
      scheduledAt:   scheduledTime.toISOString(),
      title:         title || null,
      timestamp:     Date.now(),
    };
    await Promise.allSettled(
      allParticipants
        .filter(id => id !== userId)
        .map(pid => notifyUser(req.io, pid, 'call:scheduled', payload))
    );

    res.status(201).json({ success: true, message: 'Call scheduled', data: { call: call.toJSON() } });
  } catch (err) {
    console.error('[POST /schedule]', err.message);
    res.status(500).json({ success: false, message: 'Failed to schedule call' });
  }
}));

router.get('/ice-config', asyncHandler(async (req, res) => {
  const userId  = req.user?.id || req.user?.userId;
  const TURN_URL    = process.env.TURN_URL    || '';
  const TURN_SECRET = process.env.TURN_SECRET || '';

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  // Add authenticated TURN credentials if configured
  if (TURN_URL && TURN_SECRET) {
    try {
      const crypto = require('crypto');
      const ttl  = 86400; // 24-hour credential TTL
      const time = Math.floor(Date.now() / 1000) + ttl;
      const username = `${time}:user_${userId || 'anon'}`;
      const credential = crypto
        .createHmac('sha1', TURN_SECRET)
        .update(username)
        .digest('base64');
      iceServers.push({ urls: `turn:${TURN_URL}`, username, credential });
      iceServers.push({ urls: `turns:${TURN_URL}?transport=tcp`, username, credential });
    } catch (_e) { /* TURN credential generation failed — fall back to STUN only */ }
  }

  return res.json({ success: true, iceServers, ttl: 86400 });
}));

// ─────────────────────────────────────────────────────────────────────────────
// RECORDING ENDPOINTS
// POST /:callId/recording/start  — Initiate recording with consent
// POST /:callId/recording/stop   — Stop recording
// GET  /:callId/recording/status — Check recording state
// ─────────────────────────────────────────────────────────────────────────────

// POST /:callId/recording/start
router.post('/:callId/recording/start', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;

    const call = await Call.findOne({
      where: { id: callId, [Op.or]: [{ callerId: userId }, { participants: { [Op.contains]: [userId] } }] },
    });
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    if (call.callerId !== userId) return res.status(403).json({ success: false, message: 'Only the call initiator can start recording' });
    if (call.recordingStatus === 'recording') return res.status(409).json({ success: false, message: 'Recording already active' });

    await call.update({ recordingStatus: 'recording', metadata: { ...(call.metadata || {}), recordingStartedAt: Date.now(), recordingStartedBy: userId } });

    // Notify ALL participants of recording start (GDPR/consent requirement)
    const consentPayload = {
      callId,
      recordingStartedBy: userId,
      message: 'This call is now being recorded.',
      timestamp: Date.now(),
    };
    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call:recording_started', consentPayload);
      await notifyUser(req.io, pid, 'call_recording_started', consentPayload);
    }

    res.json({ success: true, message: 'Recording started. All participants have been notified.', data: { callId, recordingStatus: 'recording' } });
  } catch (err) {
    console.error('[POST recording/start]', err.message);
    res.status(500).json({ success: false, message: 'Failed to start recording' });
  }
}));

// POST /:callId/recording/stop
router.post('/:callId/recording/stop', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { recordingUrl } = req.body;

    const call = await Call.findOne({
      where: { id: callId, [Op.or]: [{ callerId: userId }, { participants: { [Op.contains]: [userId] } }] },
    });
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });

    const updateData = { recordingStatus: 'stopped' };
    if (recordingUrl) updateData.recordingUrl = recordingUrl;
    updateData.metadata = { ...(call.metadata || {}), recordingStoppedAt: Date.now(), recordingStoppedBy: userId };
    await call.update(updateData);

    const stopPayload = { callId, message: 'Recording has stopped.', recordingUrl: recordingUrl || null, timestamp: Date.now() };
    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call:recording_stopped', stopPayload);
      await notifyUser(req.io, pid, 'call_recording_stopped', stopPayload);
    }

    res.json({ success: true, message: 'Recording stopped', data: { callId, recordingStatus: 'stopped', recordingUrl: recordingUrl || null } });
  } catch (err) {
    console.error('[POST recording/stop]', err.message);
    res.status(500).json({ success: false, message: 'Failed to stop recording' });
  }
}));

// GET /:callId/recording/status
router.get('/:callId/recording/status', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { userId } = auth;

    const call = await Call.findOne({
      where: { id: callId, [Op.or]: [{ callerId: userId }, { receiverId: userId }, { participants: { [Op.contains]: [userId] } }] },
      attributes: ['id', 'recordingStatus', 'recordingUrl', 'metadata'],
    });
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });

    res.json({ success: true, data: { callId, recordingStatus: call.recordingStatus, recordingUrl: call.recordingUrl || null } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get recording status' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// WAITING ROOM ENDPOINTS
// POST /:callId/waiting-room/admit   — Host admits a participant
// POST /:callId/waiting-room/reject  — Host rejects a waiting participant
// GET  /:callId/waiting-room         — List participants waiting
// ─────────────────────────────────────────────────────────────────────────────

// GET /:callId/waiting-room
router.get('/:callId/waiting-room', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { userId } = auth;

    const call = await Call.findOne({ where: { id: callId, callerId: userId } });
    if (!call) return res.status(403).json({ success: false, message: 'Only the host can view the waiting room' });

    const waiting = (call.metadata && call.metadata.waitingRoom) || [];
    res.json({ success: true, data: { callId, waitingRoom: waiting, count: waiting.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get waiting room' });
  }
}));

// POST /:callId/waiting-room/join  — Participant requests to join
router.post('/:callId/waiting-room/join', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;

    const call = await Call.findByPk(callId);
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });

    const user = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });
    const entry = { userId, username: user?.username || `User ${userId}`, avatar: user?.avatar || null, requestedAt: Date.now() };

    const meta = call.metadata || {};
    const wr = meta.waitingRoom || [];
    if (!wr.find(w => w.userId === userId)) wr.push(entry);
    await call.update({ metadata: { ...meta, waitingRoom: wr } });

    // Notify host
    await notifyUser(req.io, call.callerId, 'call:waiting_room_join', { callId, participant: entry });

    res.json({ success: true, message: 'Waiting for host to admit you', data: { callId, status: 'waiting' } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to join waiting room' });
  }
}));

// POST /:callId/waiting-room/admit
router.post('/:callId/waiting-room/admit', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { participantId } = req.body;
    if (!participantId) return res.status(400).json({ success: false, message: 'participantId required' });

    const call = await Call.findOne({ where: { id: callId, callerId: userId } });
    if (!call) return res.status(403).json({ success: false, message: 'Only the host can admit participants' });

    const meta = call.metadata || {};
    const wr = (meta.waitingRoom || []).filter(w => w.userId !== participantId);
    const participants = call.participants || [];
    if (!participants.includes(participantId)) participants.push(participantId);
    await call.update({ metadata: { ...meta, waitingRoom: wr }, participants });

    await notifyUser(req.io, participantId, 'call:admitted', { callId, admittedBy: userId, timestamp: Date.now() });
    res.json({ success: true, message: 'Participant admitted', data: { callId, participantId } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to admit participant' });
  }
}));

// POST /:callId/waiting-room/reject
router.post('/:callId/waiting-room/reject', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { participantId } = req.body;
    if (!participantId) return res.status(400).json({ success: false, message: 'participantId required' });

    const call = await Call.findOne({ where: { id: callId, callerId: userId } });
    if (!call) return res.status(403).json({ success: false, message: 'Only the host can reject participants' });

    const meta = call.metadata || {};
    const wr = (meta.waitingRoom || []).filter(w => w.userId !== participantId);
    await call.update({ metadata: { ...meta, waitingRoom: wr } });

    await notifyUser(req.io, participantId, 'call:rejected_from_waiting_room', { callId, rejectedBy: userId, timestamp: Date.now() });
    res.json({ success: true, message: 'Participant rejected from waiting room' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to reject participant' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// BREAKOUT ROOMS
// POST /:callId/breakout/create  — Host creates breakout rooms
// POST /:callId/breakout/assign  — Assign participants to rooms
// POST /:callId/breakout/end     — End all breakout rooms
// GET  /:callId/breakout         — List breakout rooms
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:callId/breakout/create', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { rooms } = req.body; // [{ name, participants[] }]
    if (!Array.isArray(rooms) || !rooms.length) return res.status(400).json({ success: false, message: 'rooms array required' });

    const call = await Call.findOne({ where: { id: callId, callerId: userId } });
    if (!call) return res.status(403).json({ success: false, message: 'Only the host can create breakout rooms' });

    const breakoutRooms = rooms.map((r, i) => ({
      id: `breakout_${callId}_${i}_${Date.now()}`,
      name: r.name || `Breakout Room ${i + 1}`,
      participants: r.participants || [],
      createdAt: Date.now(),
      active: true,
    }));

    const meta = call.metadata || {};
    await call.update({ metadata: { ...meta, breakoutRooms } });

    // Notify each participant which room they're in
    for (const room of breakoutRooms) {
      for (const pid of room.participants) {
        await notifyUser(req.io, pid, 'call:breakout_assigned', {
          callId, roomId: room.id, roomName: room.name,
          participants: room.participants, timestamp: Date.now(),
        });
      }
    }

    // Broadcast to all that breakout rooms started
    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call:breakout_started', { callId, rooms: breakoutRooms, timestamp: Date.now() });
    }

    res.status(201).json({ success: true, message: 'Breakout rooms created', data: { callId, breakoutRooms } });
  } catch (err) {
    console.error('[POST breakout/create]', err.message);
    res.status(500).json({ success: false, message: 'Failed to create breakout rooms' });
  }
}));

router.get('/:callId/breakout', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    if (!checkModels(res)) return;
    const { callId } = req.params;
    const { userId } = auth;

    const call = await Call.findOne({
      where: { id: callId, [Op.or]: [{ callerId: userId }, { participants: { [Op.contains]: [userId] } }] },
      attributes: ['id', 'metadata'],
    });
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });

    const rooms = (call.metadata && call.metadata.breakoutRooms) || [];
    res.json({ success: true, data: { callId, breakoutRooms: rooms } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get breakout rooms' });
  }
}));

router.post('/:callId/breakout/end', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    const { userId } = auth;
    if (!checkModels(res)) return;
    const { callId } = req.params;

    const call = await Call.findOne({ where: { id: callId, callerId: userId } });
    if (!call) return res.status(403).json({ success: false, message: 'Only the host can end breakout rooms' });

    const meta = call.metadata || {};
    const rooms = (meta.breakoutRooms || []).map(r => ({ ...r, active: false }));
    await call.update({ metadata: { ...meta, breakoutRooms: rooms } });

    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call:breakout_ended', { callId, timestamp: Date.now() });
    }

    res.json({ success: true, message: 'All breakout rooms ended' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to end breakout rooms' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN / ANALYTICS ENDPOINTS
// GET /admin/stats   — Aggregate call quality + volume analytics
// GET /admin/active  — All currently active calls
// ─────────────────────────────────────────────────────────────────────────────

router.get('/admin/stats', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    if (!checkModels(res)) return;
    // Admin-only endpoint
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { from, to } = req.query;
    const where = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to)   where.createdAt[Op.lte] = new Date(to);
    }

    const [total, completed, missed, failed, avgDuration, avgQuality] = await Promise.all([
      Call.count({ where }),
      Call.count({ where: { ...where, status: 'completed' } }),
      Call.count({ where: { ...where, status: 'missed' } }),
      Call.count({ where: { ...where, status: 'failed' } }),
      Call.findOne({ where: { ...where, status: 'completed', duration: { [Op.gt]: 0 } }, attributes: [[fn('AVG', col('duration')), 'avg']], raw: true }).then(r => r && r.avg ? Math.round(parseFloat(r.avg)) : 0).catch(() => 0),
      Call.findOne({ where: { ...where, qualityScore: { [Op.not]: null } }, attributes: [[fn('AVG', col('qualityScore')), 'avg']], raw: true }).then(r => r && r.avg ? parseFloat(parseFloat(r.avg).toFixed(2)) : null).catch(() => null),
    ]);

    res.json({
      success: true,
      data: {
        period: { from: from || null, to: to || null },
        totals: { total, completed, missed, failed, other: total - completed - missed - failed },
        completionRate: total ? Math.round((completed / total) * 100) : 0,
        avgDurationSeconds: avgDuration,
        avgQualityScore: avgQuality,
      },
    });
  } catch (err) {
    console.error('[GET /admin/stats]', err.message);
    res.status(500).json({ success: false, message: 'Failed to get analytics' });
  }
}));

router.get('/admin/active', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    if (!checkModels(res)) return;
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const activeCalls = await Call.findAll({
      where: { status: { [Op.in]: ['ringing', 'in-progress'] } },
      attributes: ['id', 'callerId', 'receiverId', 'type', 'status', 'startedAt', 'participants', 'isGroupCall', 'qualityScore'],
      order: [['startedAt', 'DESC']],
      limit: 100,
    });

    res.json({ success: true, data: { activeCalls, count: activeCalls.length, timestamp: Date.now() } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get active calls' });
  }
}));

// GET /admin/participant-stats/:userId — Per-participant call analytics
router.get('/admin/participant-stats/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const auth = checkAuth(req, res); if (!auth) return;
    if (!checkModels(res)) return;
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    const { userId: targetId } = req.params;

    const [totalCalls, completedCalls, missedCalls, avgQuality, avgDuration] = await Promise.all([
      Call.count({ where: { [Op.or]: [{ callerId: targetId }, { receiverId: targetId }, { participants: { [Op.contains]: [parseInt(targetId)] } }] } }),
      Call.count({ where: { status: 'completed', [Op.or]: [{ callerId: targetId }, { receiverId: targetId }, { participants: { [Op.contains]: [parseInt(targetId)] } }] } }),
      Call.count({ where: { status: 'missed',    [Op.or]: [{ callerId: targetId }, { receiverId: targetId }, { participants: { [Op.contains]: [parseInt(targetId)] } }] } }),
      Call.findOne({ where: { qualityScore: { [Op.not]: null }, [Op.or]: [{ callerId: targetId }, { receiverId: targetId }] }, attributes: [[fn('AVG', col('qualityScore')), 'avg']], raw: true }).then(r => r && r.avg ? parseFloat(parseFloat(r.avg).toFixed(2)) : null).catch(() => null),
      Call.findOne({ where: { status: 'completed', duration: { [Op.gt]: 0 }, [Op.or]: [{ callerId: targetId }, { receiverId: targetId }] }, attributes: [[fn('AVG', col('duration')), 'avg']], raw: true }).then(r => r && r.avg ? Math.round(parseFloat(r.avg)) : 0).catch(() => 0),
    ]);

    const recentCalls = await Call.findAll({
      where: { [Op.or]: [{ callerId: targetId }, { receiverId: targetId }, { participants: { [Op.contains]: [parseInt(targetId)] } }] },
      order: [['createdAt', 'DESC']],
      limit: 10,
      attributes: ['id', 'type', 'status', 'duration', 'qualityScore', 'postCallRating', 'createdAt'],
    });

    res.json({
      success: true,
      data: {
        userId: targetId,
        stats: {
          totalCalls,
          completedCalls,
          missedCalls,
          completionRate: totalCalls ? Math.round((completedCalls / totalCalls) * 100) : 0,
          avgQualityScore: avgQuality,
          avgDurationSeconds: avgDuration,
        },
        recentCalls,
      },
    });
  } catch (err) {
    console.error('[GET /admin/participant-stats]', err.message);
    res.status(500).json({ success: false, message: 'Failed to get participant stats' });
  }
}));

// Live caption relay via WebSocket — backend relays caption events to participants
// (registered in webSocketService, surfaced here for docs)

module.exports = router;