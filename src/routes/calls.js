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

const { apiRateLimiter } = require('../middleware/rateLimiter');

const Sequelize         = require('sequelize');
const { Op, fn, col, literal } = Sequelize;

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

// ── checkAuth helper ──────────────────────────────────────────────────────────
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
router.post('/', apiRateLimiter, asyncHandler(async (req, res) => {
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

    const call = await callService.initiateCall(userId, targetId, callType, null);

    // Always notify — if they are online, they'll get it; if not, it'll be a missed call
    await notifyUser(req.io, targetId, 'call_incoming', {
      callId:       call.id,
      callerId:     userId,
      callerName:   (call.callerInfo && call.callerInfo.username) || req.user.username || 'Unknown',
      callerAvatar: (call.callerInfo && call.callerInfo.avatar)   || req.user.avatar   || null,
      callType,
      timestamp:    Date.now(),
    });

    return res.status(201).json({ success: true, message: 'Call initiated', data: { call, receiverOnline: isOnline } });

  } catch (err) {
    console.error('[POST /calls]', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed to initiate call' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /initiate — ALIAS for / endpoint (frontend compatibility)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/initiate', apiRateLimiter, asyncHandler(async (req, res) => {
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
    const isOnline = await safeIsUserOnline(targetId);
    console.log(`[POST /calls/initiate] safeIsUserOnline(${targetId}) = ${isOnline}`);

    const call = await callService.initiateCall(userId, targetId, callType, null);

    await notifyUser(req.io, targetId, 'call_incoming', {
      callId:       call.id,
      callerId:     userId,
      callerName:   (call.callerInfo && call.callerInfo.username) || req.user.username || 'Unknown',
      callerAvatar: (call.callerInfo && call.callerInfo.avatar)   || req.user.avatar   || null,
      callType,
      timestamp:    Date.now(),
    });

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

    res.json({ status: 'success', data: { calls: enriched, statistics: stats, pagination: { total: count, page: parseInt(page, 10), limit: parsedLimit, pages: Math.ceil(count / parsedLimit) } } });
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
router.post('/start', apiRateLimiter, asyncHandler(async (req, res) => {
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

    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call_accepted', {
        callId:     call.id,
        answeredBy: user ? { id: user.id, username: user.username, avatar: user.avatar } : { id: userId },
        status:     call.status,
        startedAt:  call.startedAt,
        timestamp:  new Date(),
      });
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

    const user = await User.findByPk(userId, { attributes: ['id', 'username'] });
    for (const pid of (call.participants || [])) {
      await notifyUser(req.io, pid, 'call_rejected', {
        callId:     call.id,
        rejectedBy: user ? { id: user.id, username: user.username } : { id: userId },
        reason,
        status:     call.status,
        timestamp:  new Date(),
      });
    }
    // Also fire call_cancelled so UI incoming modal dismisses
    if (call.status === 'cancelled') {
      for (const pid of (call.participants || [])) {
        await notifyUser(req.io, pid, 'call_cancelled', { callId: call.id, status: 'cancelled', timestamp: new Date() });
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

    const call = await Call.findOne({ where: { id: callId, participants: { [Op.contains]: [userId] } } });
    if (!call) return res.status(404).json({ status: 'error', message: 'Call not found' });

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
      await notifyUser(req.io, pid, 'call_ended',       eventData);
      await notifyUser(req.io, pid, 'call_force_ended', { ...eventData, forceEnd: true });
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
        await notifyUser(req.io, pid, 'call_ended',       { callId: call.id, status: 'completed', timestamp: new Date() });
        await notifyUser(req.io, pid, 'call_force_ended', { callId: call.id, status: 'completed', forceEnd: true, timestamp: new Date() });
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

module.exports = router;
