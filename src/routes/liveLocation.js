'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { apiRateLimiter, chatLimiter } = require('../middleware/rateLimiter');

function safeInt(val) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeFloat(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

async function isParticipant(sequelize, chatId, userId) {
  const rows = await sequelize.query(
    `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
    { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
  );
  return rows && rows.length > 0;
}

function isValidLatLng(lat, lng) {
  return lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function broadcastLocationUpdate(chatId, event, payload) {
  try {
    const wsService = require('../services/webSocketService');
    wsService.broadcastToChat(chatId, event, payload, []);
  } catch (_) {}
}

const MAX_DURATION_SECONDS = 8 * 60 * 60;
const MIN_DURATION_SECONDS = 60;
const DEFAULT_DURATION_SECONDS = 15 * 60;

// POST /api/live-location/start
router.post('/start', apiRateLimiter, chatLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const { chatId: rawChatId, latitude, longitude, accuracy, heading, speed, durationSeconds } = req.body;

  const chatId = safeInt(rawChatId);
  if (!chatId) return res.status(400).json({ success: false, message: 'Valid chatId is required' });

  const lat = safeFloat(latitude);
  const lng = safeFloat(longitude);
  if (!isValidLatLng(lat, lng)) {
    return res.status(400).json({ success: false, message: 'Valid latitude and longitude are required' });
  }

  if (!(await isParticipant(sequelize, chatId, userId))) {
    return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
  }

  // Stop any existing active session for this user in this chat
  const existing = await sequelize.query(
    `SELECT id FROM "LiveLocationSessions"
     WHERE "chatId" = :chatId AND "userId" = :userId AND "isActive" = true LIMIT 1`,
    { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (existing && existing.length > 0) {
    await sequelize.query(
      `UPDATE "LiveLocationSessions" SET "isActive" = false, "stoppedAt" = NOW(),
       "stoppedReason" = 'manual', "updatedAt" = NOW() WHERE id = :id`,
      { replacements: { id: existing[0].id } }
    );
  }

  let safeDuration = safeInt(durationSeconds) || DEFAULT_DURATION_SECONDS;
  safeDuration = Math.min(Math.max(safeDuration, MIN_DURATION_SECONDS), MAX_DURATION_SECONDS);
  const expiresAt = new Date(Date.now() + safeDuration * 1000);

  const t = await sequelize.transaction();
  try {
    const [msgResult] = await sequelize.query(
      `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,metadata,"sentAt","deliveredAt","createdAt","updatedAt")
       VALUES (:chatId,:senderId,'Live location','location','{}',
               :metadata,NOW(),NOW(),NOW(),NOW())
       RETURNING id,"chatId","senderId",content,type,"createdAt"`,
      {
        replacements: {
          chatId, senderId: userId,
          metadata: JSON.stringify({ isLive: true, location: { lat, lng, accuracy: safeFloat(accuracy) } }),
        },
        type: sequelize.QueryTypes.INSERT, transaction: t,
      }
    );
    const messageId = msgResult[0].id;

    const [sessionResult] = await sequelize.query(
      `INSERT INTO "LiveLocationSessions"
         ("messageId","chatId","userId",latitude,longitude,accuracy,heading,speed,
          "startedAt","expiresAt","lastUpdatedAt","isActive","createdAt","updatedAt")
       VALUES (:messageId,:chatId,:userId,:lat,:lng,:accuracy,:heading,:speed,
               NOW(),:expiresAt,NOW(),true,NOW(),NOW())
       RETURNING id`,
      {
        replacements: {
          messageId, chatId, userId, lat, lng,
          accuracy: safeFloat(accuracy), heading: safeFloat(heading),
          speed: safeFloat(speed), expiresAt,
        },
        type: sequelize.QueryTypes.INSERT, transaction: t,
      }
    );
    const sessionId = sessionResult[0].id;

    await sequelize.query(
      `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
      { replacements: { messageId, chatId }, transaction: t }
    );

    await t.commit();

    const payload = {
      sessionId, messageId, chatId, userId,
      latitude: lat, longitude: lng, accuracy: safeFloat(accuracy),
      heading: safeFloat(heading), speed: safeFloat(speed),
      startedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(),
      isActive: true,
    };

    try {
      const wsService = require('../services/webSocketService');
      const participants = await sequelize.query(
        `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
        { replacements: { chatId, senderId: userId }, type: sequelize.QueryTypes.SELECT }
      );
      const populatedMessage = {
        id: messageId, chatId, senderId: userId, content: 'Live location',
        type: 'location', reactions: {},
        metadata: { isLive: true, location: { lat, lng } },
        liveLocation: payload,
        sentAt: new Date().toISOString(), deliveredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      // FIX-ROOT-CAUSE-DUPLICATE: matches the fix applied in src/routes/messages.js
      // (see "FIX-ROOT-CAUSE-DUPLICATE: Removed broadcastToChat(chatId, 'message:new')"
      // there). sendToUser() already reaches every participant's socket via their
      // user:<id>/user_<id> rooms; broadcastToChat() additionally targets the
      // chat:<chatId>/chat_<chatId> rooms those same sockets are also members of,
      // so calling both delivers this 'message:new' twice to the same socket.
      await Promise.allSettled(
        participants.map(p => wsService.sendToUser(p.userId, 'message:new', populatedMessage))
      );
    } catch (_) {}

    res.status(201).json({ success: true, message: 'Live location sharing started', data: { session: payload } });
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[liveLocation.js] start error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start live location sharing' });
  }
}));

// POST /api/live-location/:sessionId/update
router.post('/:sessionId/update', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const sessionId = safeInt(req.params.sessionId);
  if (!sessionId) return res.status(400).json({ success: false, message: 'Invalid sessionId' });

  const lat = safeFloat(req.body.latitude);
  const lng = safeFloat(req.body.longitude);
  if (!isValidLatLng(lat, lng)) {
    return res.status(400).json({ success: false, message: 'Valid latitude and longitude are required' });
  }

  const [session] = await sequelize.query(
    `SELECT id, "chatId", "userId", "isActive", "expiresAt" FROM "LiveLocationSessions"
     WHERE id = :sessionId LIMIT 1`,
    { replacements: { sessionId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
  if (session.userId !== userId) return res.status(403).json({ success: false, message: 'Access denied' });

  const isExpired = new Date(session.expiresAt).getTime() < Date.now();
  if (!session.isActive || isExpired) {
    if (isExpired && session.isActive) {
      await sequelize.query(
        `UPDATE "LiveLocationSessions" SET "isActive" = false, "stoppedAt" = NOW(),
         "stoppedReason" = 'expired', "updatedAt" = NOW() WHERE id = :sessionId`,
        { replacements: { sessionId } }
      );
      broadcastLocationUpdate(session.chatId, 'live-location:stopped', {
        sessionId, chatId: session.chatId, userId, reason: 'expired',
      });
    }
    return res.status(410).json({ success: false, message: 'This live location session has ended' });
  }

  await sequelize.query(
    `UPDATE "LiveLocationSessions"
     SET latitude = :lat, longitude = :lng, accuracy = :accuracy, heading = :heading,
         speed = :speed, "lastUpdatedAt" = NOW(), "updatedAt" = NOW()
     WHERE id = :sessionId`,
    {
      replacements: {
        sessionId, lat, lng,
        accuracy: safeFloat(req.body.accuracy),
        heading: safeFloat(req.body.heading),
        speed: safeFloat(req.body.speed),
      },
    }
  );

  const payload = {
    sessionId, chatId: session.chatId, userId,
    latitude: lat, longitude: lng,
    accuracy: safeFloat(req.body.accuracy),
    heading: safeFloat(req.body.heading),
    speed: safeFloat(req.body.speed),
    lastUpdatedAt: new Date().toISOString(),
  };

  broadcastLocationUpdate(session.chatId, 'live-location:update', payload);
  res.json({ success: true, data: { session: payload } });
}));

// POST /api/live-location/:sessionId/stop
router.post('/:sessionId/stop', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const sessionId = safeInt(req.params.sessionId);
  if (!sessionId) return res.status(400).json({ success: false, message: 'Invalid sessionId' });

  const [session] = await sequelize.query(
    `SELECT id, "chatId", "userId", "isActive" FROM "LiveLocationSessions" WHERE id = :sessionId LIMIT 1`,
    { replacements: { sessionId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
  if (session.userId !== userId) return res.status(403).json({ success: false, message: 'Access denied' });
  if (!session.isActive) return res.json({ success: true, message: 'Session already stopped' });

  await sequelize.query(
    `UPDATE "LiveLocationSessions" SET "isActive" = false, "stoppedAt" = NOW(),
     "stoppedReason" = 'manual', "updatedAt" = NOW() WHERE id = :sessionId`,
    { replacements: { sessionId } }
  );

  broadcastLocationUpdate(session.chatId, 'live-location:stopped', {
    sessionId, chatId: session.chatId, userId,
    stoppedAt: new Date().toISOString(), reason: 'manual',
  });

  res.json({ success: true, message: 'Live location sharing stopped' });
}));

// GET /api/live-location/chat/:chatId — active sessions in a chat
router.get('/chat/:chatId', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const chatId = safeInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

  if (!(await isParticipant(sequelize, chatId, userId))) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const sessions = await sequelize.query(
    `SELECT s.id AS "sessionId", s."messageId", s."chatId", s."userId",
            s.latitude, s.longitude, s.accuracy, s.heading, s.speed,
            s."startedAt", s."expiresAt", s."lastUpdatedAt",
            jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) AS sharer
     FROM "LiveLocationSessions" s
     LEFT JOIN "Users" u ON u.id = s."userId"
     WHERE s."chatId" = :chatId AND s."isActive" = true AND s."expiresAt" > NOW()
     ORDER BY s."startedAt" ASC`,
    { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
  );

  res.json({ success: true, data: { sessions } });
}));

module.exports = router;