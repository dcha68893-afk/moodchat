// =============================================================================
// routes/messages.js — Message Module REST API
// -----------------------------------------------------------------------------
// This is a thin transport layer. All domain logic (conversation resolution,
// idempotency, block enforcement, persistence, notification) lives in
// src/services/messageDeliveryService.js and directChatResolver.js — both of
// which already existed and were kept unchanged. Realtime delivery is the one
// shared step in messageBroadcast.js, also called by the socket 'message:send'
// handler in webSocketService.js. Neither pipeline is duplicated here.
//
// Auth: the global auth middleware (src/middleware/auth.js) already rejects
// unauthenticated requests to every non-public path before they reach here,
// and attaches the caller as req.user. No per-route authenticateToken call
// is needed (matches the convention already used in routes/chats.js).
// =============================================================================

'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');

const messageDeliveryService = require('../services/messageDeliveryService');
const { broadcastNewMessage } = require('../services/messageBroadcast');

function getUserId(req) {
  return req.user && (req.user.userId || req.user.id);
}

function getSequelize() {
  return require('../models').sequelize;
}

function safeInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── GET /unread-counts — aggregate unread count per chat for this user ──────
router.get('/unread-counts', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT m."chatId" AS "chatId", COUNT(*)::int AS "count"
     FROM "Messages" m
     JOIN chat_participants cp ON cp."chatId" = m."chatId" AND cp."userId" = :userId
     LEFT JOIN "ReadReceipts" rr ON rr."messageId" = m.id AND rr."userId" = :userId
     WHERE m."senderId" != :userId AND m."isDeleted" = false AND rr.id IS NULL
     GROUP BY m."chatId"`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  return res.json({ success: true, data: rows });
}));

// ── GET /resolve/:userId — find-or-create the direct chat with a user ───────
// Used when opening a chat from another module (Friends, Status, Calls, a
// notification, etc.) that only knows the target userId, not a chatId yet.
// Calls the exact same resolveOrCreateDirectChat() that sendMessage() uses
// internally (spec §6/§8 — one canonical conversation, one resolution path,
// not a second copy of this logic for the "open" case vs the "send" case).
router.get('/resolve/:userId', asyncHandler(async (req, res) => {
  const currentUserId = getUserId(req);
  if (!currentUserId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const targetUserId = safeInt(req.params.userId);
  if (!targetUserId) return res.status(400).json({ success: false, message: 'Invalid userId' });
  if (targetUserId === currentUserId) return res.status(400).json({ success: false, message: 'Cannot open a chat with yourself' });

  try {
    const chatId = await messageDeliveryService.resolveOrCreateDirectChat(currentUserId, targetUserId);
    return res.json({ success: true, data: { chatId } });
  } catch (err) {
    const status = err.status || (err.name === 'ForbiddenError' ? 403 : 500);
    return res.status(status).json({ success: false, message: err.message });
  }
}));

// ── POST / — send a message ──────────────────────────────────────────────────
// Body: { chatId?, receiverId?, content, type?, clientMessageId, replyToId? }
// One of chatId/receiverId is required (receiverId for a brand-new/pending
// conversation — messageDeliveryService resolves-or-creates the direct chat).
router.post('/', asyncHandler(async (req, res) => {
  const senderId = getUserId(req);
  if (!senderId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const { chatId, receiverId, content, type, clientMessageId, replyToId, metadata, expiresAt } = req.body || {};

  try {
    const { message, alreadyExisted } = await messageDeliveryService.sendMessage({
      chatId, receiverId, senderId, content, type, clientMessageId, replyToId, metadata, expiresAt,
    });

    if (!alreadyExisted) {
      // Fire-and-forget from the response's point of view — the sender
      // already has their message; delivery to others must not block the
      // sender's own ack.
      broadcastNewMessage(message, senderId).catch(err =>
        console.error('[Messages] broadcastNewMessage failed:', err.message)
      );
    }

    return res.status(alreadyExisted ? 200 : 201).json({ success: true, data: message, alreadyExisted });
  } catch (err) {
    const status = err.status || (err.name === 'ValidationError' ? 400 : err.name === 'ForbiddenError' ? 403 : 500);
    return res.status(status).json({ success: false, message: err.message, code: err.code });
  }
}));

// ── GET /:chatId — load conversation history (cursor-paginated) ─────────────
// Query: ?before=<messageId>&limit=50 — returns messages older than `before`,
// oldest-first, so the client can prepend without re-fetching what it has.
router.get('/:chatId', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const chatId = safeInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

  const sequelize = getSequelize();
  const [participant] = await sequelize.query(
    `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
    { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  if (!participant) return res.status(403).json({ success: false, message: 'Not a participant of this chat' });

  const before = safeInt(req.query.before);
  const limit = Math.min(safeInt(req.query.limit) || 50, 100);

  const conditions = [`m."chatId" = :chatId`, `m."isDeleted" = false`];
  const replacements = { chatId, limit };
  if (before) {
    conditions.push(`m.id < :before`);
    replacements.before = before;
  }

  const rows = await sequelize.query(
    `SELECT m.*, u.username AS "senderUsername", u.avatar AS "senderAvatar"
     FROM "Messages" m
     LEFT JOIN "Users" u ON u.id = m."senderId"
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.id DESC
     LIMIT :limit`,
    { replacements, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  return res.json({ success: true, data: rows.reverse(), hasMore: rows.length === limit });
}));

// ── GET /:chatId/sync — reconnect catch-up ───────────────────────────────────
// Query: ?sinceId=<id> or ?sinceTimestamp=<iso>. Server-authoritative
// alternative to relying on the live socket alone (spec §16, §34).
router.get('/:chatId/sync', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const chatId = safeInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

  try {
    const messages = await messageDeliveryService.getMissedMessages(userId, chatId, {
      sinceId: safeInt(req.query.sinceId),
      sinceTimestamp: req.query.sinceTimestamp || null,
      limit: safeInt(req.query.limit) || 100,
    });
    return res.json({ success: true, data: messages });
  } catch (err) {
    const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
    return res.status(status).json({ success: false, message: err.message });
  }
}));

// ── POST /:messageId/delivered ───────────────────────────────────────────────
router.post('/:messageId/delivered', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  await messageDeliveryService.markDelivered(messageId, userId);
  return res.json({ success: true });
}));

// ── POST /read — batch mark-as-read ──────────────────────────────────────────
// Body: { messageIds: number[] }
// Writes ReadReceipts — the table getUnreadCountForChat/GET /unread-counts
// actually reads from (Messages.isRead is legacy/unread by anything; see
// messageDeliveryService.js's own UNREAD-COUNT-DUAL-SYSTEM comment). This is
// the same write the socket's existing 'mark_as_read' handler does, so REST
// and socket agree on one canonical read-state table.
router.post('/read', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const { messageIds } = req.body || {};
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ success: false, message: 'messageIds array is required' });
  }
  const ids = messageIds.map(Number).filter(Boolean);
  if (ids.length === 0) return res.status(400).json({ success: false, message: 'messageIds must be numeric' });

  const sequelize = getSequelize();
  await sequelize.query(
    `INSERT INTO "ReadReceipts" ("messageId","userId","readAt","createdAt","updatedAt")
     SELECT unnest(ARRAY[:ids]::int[]), :userId, NOW(), NOW(), NOW()
     ON CONFLICT ("messageId","userId") DO NOTHING`,
    { replacements: { ids, userId }, type: sequelize.QueryTypes.INSERT }
  ).catch(() => {});

  // Tell the sender(s) their message(s) were read, over the live socket if
  // connected — same generic transport every other realtime event here uses.
  try {
    const wsService = require('../services/webSocketService');
    const senderRows = await sequelize.query(
      `SELECT DISTINCT "senderId", "chatId" FROM "Messages" WHERE id = ANY(:ids::int[]) AND "senderId" != :userId`,
      { replacements: { ids, userId }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => []);
    await Promise.allSettled(
      senderRows.map(s => wsService.sendToUser(s.senderId, 'message:read', { chatId: s.chatId, messageIds: ids, readBy: userId }))
    );
  } catch (_) { /* non-fatal — read state is already persisted */ }

  return res.json({ success: true });
}));


module.exports = router;
