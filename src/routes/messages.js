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
const { apiRateLimiter } = require('../middleware/rateLimiter');

router.use(apiRateLimiter);

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

// ── GET /starred — list this user's starred messages ────────────────────────
router.get('/starred', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT sm."messageId", sm."chatId", sm."starredAt",
            m.content, m.type, m."senderId", m."sentAt", m.metadata,
            u.username AS "senderUsername", u.avatar AS "senderAvatar"
     FROM starred_messages sm
     JOIN "Messages" m ON m.id = sm."messageId"
     LEFT JOIN "Users" u ON u.id = m."senderId"
     WHERE sm."userId" = :userId AND m."isDeleted" = false
     ORDER BY sm."starredAt" DESC
     LIMIT 200`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  return res.json({ success: true, data: rows });
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


function stripHtmlTags(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/\bon\w+\s*=/gi, 'data-blocked=');
}

// ── DELETE /:messageId — delete a message ────────────────────────────────────
// Body/query: deleteForEveryone (bool). Matches the app's existing convention
// (see the previous routes/messages.js): "delete for me" stores the caller's
// id in metadata.deletedFor (message still exists for everyone else);
// "delete for everyone" sets isDeleted (sender-only — no group-admin concept
// exists for direct chats). Broadcasts via broadcastToChatFull, the existing
// generic helper that already covers both the chat room and each
// participant's user room — not reimplemented here.
router.delete('/:messageId', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const rawForEveryone = req.body?.deleteForEveryone ?? req.query.deleteForEveryone ?? false;
  const deleteForEveryone = rawForEveryone === true || rawForEveryone === 'true';

  const sequelize = getSequelize();
  const [msg] = await sequelize.query(
    `SELECT id, "chatId", "senderId", metadata FROM "Messages" WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });

  const [participant] = await sequelize.query(
    `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
    { replacements: { chatId: msg.chatId, userId }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  if (!participant) return res.status(403).json({ success: false, message: 'Not a participant of this chat' });

  if (deleteForEveryone) {
    if (msg.senderId !== userId) {
      return res.status(403).json({ success: false, message: 'Only the sender can delete a message for everyone' });
    }
    await sequelize.query(
      `UPDATE "Messages" SET "isDeleted" = true, "deletedAt" = NOW(), "deletedBy" = :userId, "updatedAt" = NOW() WHERE id = :messageId`,
      { replacements: { userId, messageId } }
    );
  } else {
    let metadata = {};
    try { metadata = (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) || {}; } catch (_) {}
    const deletedFor = Array.isArray(metadata.deletedFor) ? metadata.deletedFor : [];
    if (!deletedFor.includes(userId)) deletedFor.push(userId);
    metadata.deletedFor = deletedFor;
    await sequelize.query(
      `UPDATE "Messages" SET metadata = :metadata, "updatedAt" = NOW() WHERE id = :messageId`,
      { replacements: { metadata: JSON.stringify(metadata), messageId } }
    );
  }

  try {
    const wsService = require('../services/webSocketService');
    await wsService.broadcastToChatFull(msg.chatId, 'message:deleted', {
      messageId, chatId: msg.chatId, deletedBy: userId, deleteForEveryone,
      deletedFor: deleteForEveryone ? null : [userId],
    });
  } catch (err) { console.warn('[Messages] Failed to broadcast message:deleted:', err.message); }

  return res.json({ success: true });
}));

// ── PATCH /:messageId — edit a message (sender-only, 15-minute window) ──────
const _editMessageHandler = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Message content is required' });
  const safeContent = stripHtmlTags(content).trim();

  const sequelize = getSequelize();
  const [msg] = await sequelize.query(
    `SELECT id, "chatId", "senderId", "createdAt" FROM "Messages" WHERE id = :messageId AND "senderId" = :userId AND "isDeleted" = false LIMIT 1`,
    { replacements: { messageId, userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found or not authorized to edit' });

  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  if (Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS) {
    return res.status(400).json({ success: false, message: 'Message can only be edited within 15 minutes' });
  }

  await sequelize.query(
    `UPDATE "Messages" SET content = :content, "isEdited" = true, "editedAt" = NOW(), "updatedAt" = NOW() WHERE id = :messageId`,
    { replacements: { content: safeContent, messageId } }
  );

  try {
    const wsService = require('../services/webSocketService');
    await wsService.broadcastToChatFull(msg.chatId, 'message:edited', {
      messageId, chatId: msg.chatId, content: safeContent, editedAt: new Date().toISOString(), editedBy: userId,
    });
  } catch (err) { console.warn('[Messages] Failed to broadcast message:edited:', err.message); }

  return res.json({ success: true, data: { messageId, content: safeContent, editedAt: new Date().toISOString() } });
});
// PUT alias — window.api.request (the frontend's REST wrapper) has no
// .patch() method, only .get/.post/.put/.delete. Same convention the
// previous routes/messages.js already used for this exact reason.
router.patch('/:messageId', _editMessageHandler);
router.put('/:messageId', _editMessageHandler);

// ── POST /:messageId/star — star a message ──────────────────────────────────
router.post('/:messageId/star', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const sequelize = getSequelize();
  const [msg] = await sequelize.query(
    `SELECT m.id, m."chatId" FROM "Messages" m
     JOIN chat_participants cp ON cp."chatId" = m."chatId" AND cp."userId" = :userId
     WHERE m.id = :messageId AND m."isDeleted" = false LIMIT 1`,
    { replacements: { userId, messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found or access denied' });

  await sequelize.query(
    `INSERT INTO starred_messages ("userId","messageId","chatId","starredAt")
     VALUES (:userId,:messageId,:chatId,NOW())
     ON CONFLICT ("userId","messageId") DO NOTHING`,
    { replacements: { userId, messageId, chatId: msg.chatId } }
  );
  return res.json({ success: true });
}));

// ── DELETE /:messageId/star — unstar a message ───────────────────────────────
router.delete('/:messageId/star', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  await getSequelize().query(
    `DELETE FROM starred_messages WHERE "userId" = :userId AND "messageId" = :messageId`,
    { replacements: { userId, messageId } }
  );
  return res.json({ success: true });
}));

// ── PUT /:chatId/mute — mute a conversation (with optional duration) ────────
// Body: { muted: bool, duration?: '8h'|'1d'|'1w' }
router.put('/:chatId/mute', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const chatId = safeInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

  const { muted = true, duration } = req.body || {};
  let mutedUntil = null;
  if (muted && duration) {
    const d = { '8h': 8 * 3600, '1d': 86400, '1w': 604800 }[duration];
    if (d) mutedUntil = new Date(Date.now() + d * 1000);
  }

  await getSequelize().query(
    `UPDATE chat_participants SET "isMuted" = :muted, "mutedUntil" = :mutedUntil, "updatedAt" = NOW()
     WHERE "chatId" = :chatId AND "userId" = :userId`,
    { replacements: { chatId, userId, muted: Boolean(muted), mutedUntil } }
  );
  return res.json({ success: true, muted: Boolean(muted), mutedUntil });
}));

// DELETE alias for unmute — matches the app's existing toggleMute() convention
// (sends DELETE to unmute, PUT to mute), same fix the old code already made.
router.delete('/:chatId/mute', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const chatId = safeInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

  await getSequelize().query(
    `UPDATE chat_participants SET "isMuted" = false, "mutedUntil" = NULL, "updatedAt" = NOW()
     WHERE "chatId" = :chatId AND "userId" = :userId`,
    { replacements: { chatId, userId } }
  );
  return res.json({ success: true, muted: false });
}));

// ── POST /:messageId/react — add/replace this user's reaction ───────────────
// Body: { emoji: string }. One reaction per user per message (replaces prior).
router.post('/:messageId/react', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const { emoji } = req.body || {};
  if (!emoji || typeof emoji !== 'string' || emoji.length > 8) {
    return res.status(400).json({ success: false, message: 'A valid emoji is required' });
  }

  const sequelize = getSequelize();
  const [msg] = await sequelize.query(
    `SELECT m.id, m."chatId", m.metadata FROM "Messages" m
     JOIN chat_participants cp ON cp."chatId" = m."chatId" AND cp."userId" = :userId
     WHERE m.id = :messageId AND m."isDeleted" = false LIMIT 1`,
    { replacements: { userId, messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found or access denied' });

  let metadata = {};
  try { metadata = (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) || {}; } catch (_) {}
  const reactions = metadata.reactions || {};
  reactions[userId] = emoji;
  metadata.reactions = reactions;

  await sequelize.query(
    `UPDATE "Messages" SET metadata = :metadata, "updatedAt" = NOW() WHERE id = :messageId`,
    { replacements: { metadata: JSON.stringify(metadata), messageId } }
  );

  try {
    const wsService = require('../services/webSocketService');
    await wsService.broadcastToChatFull(msg.chatId, 'message:reaction', { messageId, chatId: msg.chatId, userId, emoji, reactions });
  } catch (err) { console.warn('[Messages] Failed to broadcast message:reaction:', err.message); }

  return res.json({ success: true, data: { reactions } });
}));

// ── DELETE /:messageId/react — remove this user's reaction ──────────────────
router.delete('/:messageId/react', asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  const messageId = safeInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const sequelize = getSequelize();
  const [msg] = await sequelize.query(
    `SELECT id, "chatId", metadata FROM "Messages" WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });

  let metadata = {};
  try { metadata = (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) || {}; } catch (_) {}
  const reactions = metadata.reactions || {};
  delete reactions[userId];
  metadata.reactions = reactions;

  await sequelize.query(
    `UPDATE "Messages" SET metadata = :metadata, "updatedAt" = NOW() WHERE id = :messageId`,
    { replacements: { metadata: JSON.stringify(metadata), messageId } }
  );

  try {
    const wsService = require('../services/webSocketService');
    await wsService.broadcastToChatFull(msg.chatId, 'message:reaction', { messageId, chatId: msg.chatId, userId, emoji: null, reactions });
  } catch (err) { console.warn('[Messages] Failed to broadcast message:reaction removal:', err.message); }

  return res.json({ success: true, data: { reactions } });
}));

module.exports = router;
