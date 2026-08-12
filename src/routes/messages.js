const path = require('path');
const asyncHandler = require('express-async-handler');

// FIX: getSequelize() was called in several routes below but never defined
// anywhere in this file — every one of those routes threw
// "ReferenceError: getSequelize is not defined" (surfaced to clients as a
// generic 500). config/database.js exports getSequelizeInstance, not
// getSequelize, and models/index.js is a safe fallback.
function getSequelize() {
  try { return require('../config/database').getSequelizeInstance(); }
  catch (_) { return require('../models/index').sequelize; }
}
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { apiRateLimiter, chatLimiter } = require('../middleware/rateLimiter');
const cloudinaryService = require('../services/cloudinaryService');

// FIX-AUDIT: Forensic logging was unconditionally on in production. Gate
// behind an explicit env flag — defaults OFF unless DEBUG_MESSAGES=1 is set.
// FIX (SILENT-CONSOLE): was opt-in (only logged if DEBUG_MESSAGES env var was
// explicitly set), so these forensic SEND_START/TRANSPORT_SELECTED/BROADCASTED
// logs never appeared in Render's log stream by default — a stuck/failed send
// and a working one were indistinguishable on the server side. Now opt-out.
const _DEBUG_MESSAGES = process.env.DEBUG_MESSAGES !== '0' && process.env.DEBUG_MESSAGES !== 'false';
const _flog = (...args) => { if (_DEBUG_MESSAGES) console.log(...args); };

// FIX-AUDIT: Server-side defense-in-depth against stored XSS. The frontend
// already escapes HTML before rendering, but relying solely on the client is
// unsafe — any other consumer of this API (mobile app, third-party
// integration, admin panel) that renders message content without escaping
// would be vulnerable to stored XSS. This strips HTML tags at write time.
function stripHtmlTags(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/\bon\w+\s*=/gi, 'data-blocked=');
}

// ── CRITICAL: Inject global.__socketIO into req.io so all handlers can emit ──
router.use((req, _, next) => { if (!req.io) req.io = global.__socketIO || null; next(); });

// All routes are protected by parent auth middleware in index.js


const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024; // raised to 100MB
const ALLOWED_FILE_TYPES = (
  process.env.ALLOWED_FILE_TYPES ||
  'image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/ogg,audio/webm,video/mp4,video/webm,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
).split(',');
const UPLOAD_PATH = process.env.UPLOAD_PATH || 'uploads/messages';

// ── Storage: S3 (preferred) → local disk (fallback) ─────────────────────────
// Set AWS_S3_BUCKET + AWS credentials in env to enable persistent S3 storage.
// Cloudinary: set CLOUDINARY_URL and CLOUDINARY_UPLOAD_PRESET for Cloudinary.
// Without either, files land on local disk (fine for dev; Render erases on deploy).
let _storageBackend = 'disk';
let storage;
let _s3Client = null; // hoisted so routes beyond the upload handler (e.g. view-once delete) can reuse it

try {
  if (process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID) {
    const multerS3 = require('multer-s3');
    const { S3Client } = require('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    _s3Client = s3Client;
    storage = multerS3({
      s3: s3Client,
      bucket: process.env.AWS_S3_BUCKET,
      // FIX-AUDIT: Removed acl:'public-read'. Public ACL exposed every uploaded
      // media file to anyone with the URL, with zero authentication. Files are
      // now private by default; serve via pre-signed URLs (short TTL) instead.
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `messages/${uniqueSuffix}${path.extname(file.originalname)}`);
      },
    });
    _storageBackend = 's3';
    _flog('✅ Media storage: AWS S3 (persistent CDN)');
  } else {
    throw new Error('S3 not configured');
  }
} catch (_) {
  // Fall back to Cloudinary (persistent CDN) before resorting to ephemeral disk
  if (cloudinaryService.isConfigured()) {
    storage = multer.memoryStorage();
    _storageBackend = 'cloudinary';
    _flog('✅ Media storage: Cloudinary (persistent CDN)');
  } else {
  const ensureUploadDirSync = () => {
    try { fsSync.mkdirSync(UPLOAD_PATH, { recursive: true }); } catch (_e) { /* already exists */ }
  };
  ensureUploadDirSync();
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_PATH),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  });
  if (_storageBackend !== 's3') {
    console.warn('⚠️  Media storage: local disk (ephemeral on Render). Set AWS_S3_BUCKET or CLOUDINARY_URL for persistent storage.');
  }
  }
}

// ── SECURITY FIX: Magic byte validation ─────────────────────────────────────
// Client-supplied Content-Type can be spoofed. Validate the first 12 bytes
// of the actual file against known magic numbers before accepting upload.
const MAGIC_SIGNATURES = {
  'image/jpeg' : [[0xFF,0xD8,0xFF]],
  'image/png'  : [[0x89,0x50,0x4E,0x47]],
  'image/gif'  : [[0x47,0x49,0x46,0x38]],
  'image/webp' : [null], // RIFF....WEBP — checked by extension
  'audio/mpeg' : [[0xFF,0xFB],[0xFF,0xF3],[0xFF,0xF2],[0x49,0x44,0x33]],
  'audio/ogg'  : [[0x4F,0x67,0x67,0x53]],
  'audio/webm' : [[0x1A,0x45,0xDF,0xA3]],
  'video/mp4'  : [null], // ftyp box at offset 4 — skip deep check
  'video/webm' : [[0x1A,0x45,0xDF,0xA3]],
  'application/pdf': [[0x25,0x50,0x44,0x46]],
  'text/plain' : [null], // no magic bytes for plain text
};

function _validateMagicBytes(fileOrPath, declaredMime) {
  try {
    const sigs = MAGIC_SIGNATURES[declaredMime];
    if (!sigs) return false; // mime not in our allow-list at all
    if (sigs[0] === null) return true; // skip deep check for this type
    let buf;
    if (Buffer.isBuffer(fileOrPath)) {
      buf = fileOrPath;
    } else {
      const fd  = fsSync.openSync(fileOrPath, 'r');
      buf = Buffer.alloc(12);
      fsSync.readSync(fd, buf, 0, 12, 0);
      fsSync.closeSync(fd);
    }
    return sigs.some(sig => sig.every((byte, i) => buf[i] === byte));
  } catch(_) { return false; }
}

const fileFilter = (req, file, cb) => {
  if (ALLOWED_FILE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`File type ${file.mimetype} is not allowed`), false);
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

// ============================================================================
// SECURITY HELPERS
// ============================================================================

// Safe integer parse - prevents SQL injection via numeric params
const safeInt = (val) => {
  const n = parseInt(val, 10);
  return (!isNaN(n) && n > 0) ? n : null;
};

const ALLOWED_MSG_TYPES = ['text', 'image', 'file', 'audio', 'video', 'document', 'poll', 'view_once', 'location', 'contact', 'sticker'];

_flog('✅ Messages routes initialized');

// ============================================================================
// GET /api/messages/unread-counts - Get unread counts for all user's chats
// ============================================================================
// =============================================================================
// MESSAGE LIFECYCLE REBUILD (messages-only scope, added 2026-07-26)
// -----------------------------------------------------------------------------
// Purely additive REST fallback for the new msg:* socket pipeline
// (src/sockets/messageLifecycleSocket.js). A client uses these when it has
// no live socket connection (cold start, socket still reconnecting) — the
// same idempotency (clientMessageId) and the same missed-message query used
// by the socket path, so retrying via REST after a failed socket attempt
// can never create a duplicate message.
// =============================================================================
const messageDeliveryService = require('../services/messageDeliveryService');

router.post('/lifecycle/send', apiRateLimiter, chatLimiter, asyncHandler(async (req, res) => {
  const senderId = req.user.id;
  // FIX-RECEIVERID-GAP: accept receiverId too — this REST route is the
  // socket-fallback for MessageLifecycleClient.js, which must be able to
  // start a brand-new conversation the same way the socket path can.
  const { chatId, receiverId, content, type, clientMessageId, replyToId } = req.body || {};

  const { message, alreadyExisted } = await messageDeliveryService.sendMessage({
    chatId, receiverId, senderId, content, type, clientMessageId, replyToId,
  });

  // Best-effort real-time push to recipients — if this REST call is itself
  // the retry after a socket failure, the recipients may already have it,
  // but msg:new pushes are idempotent client-side (dedup by serverId).
  if (!alreadyExisted) {
    try {
      const wsService = require('../services/webSocketService');
      const sequelize = getSequelize();
      // FIX: must use the RESOLVED chatId (message.chatId) here, not the
      // original request's chatId — when only receiverId was sent, the
      // request-body chatId is undefined and parseInt(undefined) is NaN,
      // which matched zero rows and silently skipped delivery entirely.
      const participants = await sequelize.query(
        `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
        { replacements: { chatId: parseInt(message.chatId, 10), senderId: parseInt(senderId, 10) }, type: sequelize.QueryTypes.SELECT }
      ).catch(() => []);
      for (const { userId: recipientId } of participants) {
        wsService.sendToUser(recipientId, 'msg:new', {
          serverId: message.id, chatId: message.chatId, senderId: message.senderId,
          content: message.content, type: message.type, sender: message.sender || null,
          replyToId: message.replyToId || null, createdAt: message.createdAt,
          sentAt: message.sentAt, status: 'sent',
        }).catch(() => {});
      }
    } catch (_) { /* non-fatal, message is durably saved regardless */ }
  }

  res.json({
    success: true,
    clientMessageId,
    serverId: message.id,
    chatId: message.chatId,
    status: message.status || 'sent',
    sentAt: message.sentAt || message.createdAt,
    alreadyExisted: !!alreadyExisted,
  });
}));

router.get('/lifecycle/sync/:chatId', apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { chatId } = req.params;
  const { sinceId, sinceTimestamp } = req.query;

  const messages = await messageDeliveryService.getMissedMessages(userId, chatId, {
    sinceId: sinceId || null,
    sinceTimestamp: sinceTimestamp || null,
  });

  res.json({ success: true, chatId, messages });
}));

router.get('/unread-counts', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;
    const sequelize = req.app.locals.db;

    // Real unread counts using ReadReceipts table
    const unreadCounts = await sequelize.query(
      `SELECT 
        m."chatId",
        COUNT(*) as unread_count
      FROM "Messages" m
      LEFT JOIN "ReadReceipts" rr 
        ON rr."messageId" = m.id 
        AND rr."userId" = :userId
      WHERE m."chatId" IN (
        SELECT cp."chatId" 
        FROM chat_participants cp 
        WHERE cp."userId" = :userId
      )
      AND m."isDeleted" = false
      AND m."senderId" != :userId
      AND rr.id IS NULL
      GROUP BY m."chatId"`,
      { 
        replacements: { userId }, 
        type: sequelize.QueryTypes.SELECT 
      }
    );

    const formatted = {};
    unreadCounts.forEach(item => {
      formatted[item.chatId] = parseInt(item.unread_count);
    });

    res.status(200).json({ 
      success: true, 
      data: formatted 
    });
  } catch (error) {
    console.error('Error fetching unread counts:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));

// ============================================================================
// GET /api/messages/chats - Get all conversations for current user
// ============================================================================
router.get('/chats', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;
    const sequelize = req.app.locals.db;

    const conversations = await sequelize.query(
      `SELECT
        c.id as "chatId",
        c.type as "chatType",
        c.name as "chatName",
        c."createdBy",
        c."updatedAt",
        c."createdAt",
        (
          SELECT jsonb_build_object(
            'id', m.id, 
            'content', m.content, 
            'senderId', m."senderId", 
            'createdAt', m."createdAt",
            'sender', jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar)
          )
          FROM "Messages" m
          LEFT JOIN "Users" u ON u.id = m."senderId"
          WHERE m."chatId" = c.id AND m."isDeleted" = false
          ORDER BY m."createdAt" DESC LIMIT 1
        ) as "lastMessage",
        (
          SELECT jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'avatar', p.avatar))
          FROM chat_participants cp
          JOIN "Users" p ON p.id = cp."userId"
          WHERE cp."chatId" = c.id AND cp."userId" != :userId
        ) as participants,
        (
          SELECT COUNT(*)
          FROM "Messages" m
          LEFT JOIN "ReadReceipts" rr 
            ON rr."messageId" = m.id 
            AND rr."userId" = :userId
          WHERE m."chatId" = c.id 
            AND m."isDeleted" = false
            AND m."senderId" != :userId
            AND rr.id IS NULL
        ) as "unreadCount"
      FROM chats c
      WHERE EXISTS (
        SELECT 1 FROM chat_participants cp 
        WHERE cp."chatId" = c.id AND cp."userId" = :userId
      )
      ORDER BY c."updatedAt" DESC`,
      { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
    );

    const formatted = conversations.map(conv => {
      // participants subquery already excludes current user (WHERE cp."userId" != :userId)
      const otherP = (conv.participants && conv.participants[0]) || null;
      const resolvedName = conv.chatName
        || otherP?.displayName
        || otherP?.username
        || 'Chat';
      return {
        id: conv.chatId,
        chatId: conv.chatId,
        name: resolvedName,
        chatName: resolvedName,
        type: conv.chatType || 'direct',
        chatType: conv.chatType || 'direct',
        participants: conv.participants || [],
        lastMessage: conv.lastMessage,
        lastMessageContent: conv.lastMessage?.content || null,
        unreadCount: parseInt(conv.unreadCount || 0, 10),
        updatedAt: conv.updatedAt,
        createdAt: conv.createdAt,
        // FIX: Top-level friendId/friendName/friendAvatar so messages-core
        // can find existing conversations without scanning participants array
        friendId:     otherP?.id     || null,
        friendName:   resolvedName,
        friendAvatar: otherP?.avatar || null,
        otherParticipant: otherP ? {
          id:          otherP.id,
          username:    otherP.username,
          avatar:      otherP.avatar,
          displayName: otherP.displayName || otherP.username,
        } : null,
      };
    });

    res.status(200).json({ success: true, data: formatted });
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));

// ============================================================================
// POST /api/messages/mark-read/batch - Mark messages as read
// MUST be registered before /:messageId to avoid route collision
// ============================================================================
router.post('/mark-read/batch', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const { messageIds, chatId } = req.body;
    const safeChatId = safeInt(chatId);
    const userId = req.user.id;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ success: false, message: 'messageIds array is required' });
    }
    if (!safeChatId) {
      return res.status(400).json({ success: false, message: 'chatId is required' });
    }

    const sequelize = req.app.locals.db;

    // Verify user is a chat participant
    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId: safeChatId, userId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
    }

    const safeIds = messageIds.map(safeInt).filter(Boolean);
    
    if (safeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid message IDs provided' });
    }

    // FIX-AUDIT: Replaced raw value interpolation with parameterized per-row inserts
    // to eliminate SQL injection risk, and added the missing updatedAt column.
    for (const msgId of safeIds) {
      await sequelize.query(
        `INSERT INTO "ReadReceipts" ("messageId", "userId", "readAt", "createdAt", "updatedAt")
         VALUES (:msgId, :userId, NOW(), NOW(), NOW())
         ON CONFLICT ("messageId", "userId") DO NOTHING`,
        { replacements: { msgId, userId }, type: sequelize.QueryTypes.INSERT }
      ).catch(() => {});
    }

    try {
      const wsService = require('../services/webSocketService');
      const senders = await sequelize.query(
        `SELECT DISTINCT "senderId" FROM "Messages"
         WHERE id IN (:messageIds)
           AND "chatId" = :chatId
           AND "senderId" != :userId`,
        {
          replacements: { messageIds: safeIds, chatId: safeChatId, userId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      await Promise.allSettled(
        (senders || []).flatMap((row) => ([
          // FIX-010: Single canonical 'message:read' event
          wsService.sendToUser(row.senderId, 'message:read', {
            chatId: safeChatId,
            messageIds: safeIds,
            readBy: userId,
            readAt: new Date().toISOString()
          }),
        ]))
      );
    } catch (notifyError) {
      console.warn('Failed to emit message:read websocket event:', notifyError.message);
    }

    res.status(200).json({
      status: 'success',
      message: `${safeIds.length} message(s) marked as read`,
      data: { markedCount: safeIds.length },
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ status: 'error', message: 'Failed to mark messages as read' });
  }
}));

// ============================================================================
// POST /api/messages/mark-delivered/batch - Mark messages as delivered
// Called by messages-core.js ackMessageDelivered() when a message is received
// ============================================================================
router.post('/mark-delivered/batch', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { chatId, messageIds } = req.body;
    if (!chatId || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ success: false, message: 'chatId and messageIds[] required' });
    }

    const safeIds = messageIds.filter(id => id && (typeof id === 'number' || typeof id === 'string'));
    if (safeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid messageIds provided' });
    }

    const sequelize = require('../models').sequelize;
    await sequelize.query(
      `UPDATE "Messages"
         SET "deliveredAt" = NOW(), "updatedAt" = NOW()
       WHERE id IN (:ids)
         AND "chatId" = :chatId
         AND "deliveredAt" IS NULL`,
      { replacements: { ids: safeIds, chatId: parseInt(chatId, 10) }, type: sequelize.QueryTypes.UPDATE }
    );

    // Broadcast delivery receipt to sender via WebSocket
    try {
      const wsService = require('../services/webSocketService');
      const io = wsService.getIO ? wsService.getIO() : (global.__socketIO || global.io);
      if (io) {
        const msgRows = await sequelize.query(
          `SELECT "senderId", id FROM "Messages" WHERE id IN (:ids)`,
          { replacements: { ids: safeIds }, type: sequelize.QueryTypes.SELECT }
        );
        const senderIds = [...new Set(msgRows.map(r => r.senderId))];
        for (const senderId of senderIds) {
          wsService.sendToUser
            ? wsService.sendToUser(senderId, 'message:delivered', { messageIds: safeIds, chatId, deliveredBy: userId, deliveredAt: new Date().toISOString() })
            : io.to(`user:${senderId}`).emit('message:delivered', { messageIds: safeIds, chatId, deliveredBy: userId });
        }

        // FIX-MSG-DELIVERY-FALSE-TIMEOUT: this REST batch endpoint is the ack path the
        // frontend actually uses (see ackMessageDelivered in messages-core.ui-bridge.js),
        // but scheduleMessageDeliveryTimeout()'s 10s timer was only ever cleared by the
        // separate socket-level 'message:delivery_ack' event, which nothing reliably emits
        // anymore. That meant the timeout fired for essentially every real 1:1 message,
        // even ones that were delivered instantly, producing a false 'undelivered after 10s'
        // warning and a spurious 'message:delivery_failed' push to the sender. Clear it here too.
        if (typeof wsService.clearMessageDeliveryTimeout === 'function') {
          for (const id of msgRows.map(r => r.id)) {
            wsService.clearMessageDeliveryTimeout(id);
          }
        }
      }
    } catch (_e) { /* non-fatal */ }

    return res.status(200).json({ success: true, message: 'Delivery receipts recorded', count: safeIds.length });
  } catch (error) {
    console.error('[messages] mark-delivered/batch error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to mark messages as delivered' });
  }
}));

// ============================================================================
// GET /api/messages - Fetch messages by ?chatId= query parameter
// THIS IS THE PRIMARY ROUTE the frontend uses:
//   GET /api/messages?chatId=2&limit=50
// MUST be before GET /:chatId
// ============================================================================
router.get('/', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const chatId = safeInt(req.query.chatId);
    if (!chatId) {
      return res.status(400).json({ success: false, message: 'chatId query parameter is required' });
    }

    const page = safeInt(req.query.page) || 1;
    const limit = Math.min(safeInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const sequelize = req.app.locals.db;

    // Verify user is a chat participant
    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied to this chat' });
    }

    // Build safe time filters
    const replacements = { chatId };
    let beforeClause = '';
    let afterClause = '';

    if (req.query.before) {
      const d = new Date(req.query.before);
      if (!isNaN(d.getTime())) { 
        beforeClause = 'AND m."createdAt" < :before'; 
        replacements.before = d.toISOString(); 
      }
    }
    if (req.query.after) {
      const d = new Date(req.query.after);
      if (!isNaN(d.getTime())) { 
        afterClause = 'AND m."createdAt" > :after'; 
        replacements.after = d.toISOString(); 
      }
    }

    const messages = await sequelize.query(
      `SELECT m.id, m."chatId", m."senderId", m.content,
              m.type as "messageType", m.reactions, m."isEdited",
              m."editedAt", m."isDeleted", m."createdAt", m."updatedAt",
              m."replyToId", m.metadata, m."viewOnceViewedAt", m."viewOnceViewedBy",
              jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) as sender,
              CASE WHEN m."replyToId" IS NOT NULL THEN
                jsonb_build_object(
                  'id',         rm.id,
                  'content',    rm.content,
                  'type',       rm.type,
                  'senderId',   rm."senderId",
                  'senderName', ru.username,
                  'messageId',  rm.id
                )
              ELSE NULL END as "replyTo"
       FROM "Messages" m
       LEFT JOIN "Users" u  ON u.id  = m."senderId"
       LEFT JOIN "Messages" rm ON rm.id = m."replyToId" AND rm."isDeleted" = false
       LEFT JOIN "Users" ru ON ru.id = rm."senderId"
       WHERE m."chatId" = :chatId AND m."isDeleted" = false ${beforeClause} ${afterClause}
         AND NOT COALESCE((m.metadata->'deletedFor') @> to_jsonb(:userId::int), false)
       ORDER BY m."createdAt" DESC LIMIT :_limit OFFSET :_offset`,
      { replacements: { ...replacements, userId: req.user.id, _limit: limit, _offset: offset }, type: sequelize.QueryTypes.SELECT }
    );

    const countResult = await sequelize.query(
      `SELECT COUNT(*) as total FROM "Messages" m
       WHERE m."chatId" = :chatId AND m."isDeleted" = false ${beforeClause} ${afterClause}
         AND NOT COALESCE((m.metadata->'deletedFor') @> to_jsonb(:userId::int), false)`,
      { replacements: { ...replacements, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    const total = parseInt(countResult[0]?.total || 0);

    res.status(200).json({
      success: true,
      data: {
        messages: messages.reverse().map(m => {
          const rawMediaUrl = m.metadata?.mediaUrl || m.mediaUrl || null;
          // NEW FEATURE: View Once gating. Once viewed (viewOnceViewedAt set),
          // strip the media URL from EVERYONE's response including the
          // viewer — once is once, re-fetching the chat history must not
          // resurrect access. The sender gets a "viewed" indicator instead
          // of the URL too, matching WhatsApp (sender can see IF it was
          // viewed and by whom, but cannot re-open the media either).
          const isViewOnce = (m.messageType || m.type) === 'view_once';
          const alreadyViewed = !!m.viewOnceViewedAt;
          const viewOnceGatedMediaUrl = isViewOnce && alreadyViewed ? null : rawMediaUrl;
          return {
            ...m,
            // FIX: expose both "type" and "messageType" so any client field lookup works
            type: m.messageType || m.type || 'text',
            messageType: m.messageType || m.type || 'text',
            // FIX: expose mediaUrl from metadata so media messages render correctly
            mediaUrl: viewOnceGatedMediaUrl,
            fileUrl:  viewOnceGatedMediaUrl,
            ...(isViewOnce ? {
              viewOnceViewed: alreadyViewed,
              viewOnceViewedAt: m.viewOnceViewedAt || null,
              viewOnceViewedBy: m.viewOnceViewedBy || null,
            } : {}),
          };
        }),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch messages' });
  }
}));

// ============================================================================
// POST /api/messages - Send a message (finds or creates chat automatically)
// Fully parameterized - no raw string interpolation of user input
// ============================================================================
router.post('/', apiRateLimiter, chatLimiter, asyncHandler(async (req, res) => {
  try {
    const { receiverId, content, type = 'text', chatId: existingChatId, replyToId, replyToLocalId, localId: clientLocalId, linkPreview, metadata: clientMetadata, traceId: clientTraceId } = req.body;
    const senderId = req.user.id;

    // PHASE24 FORENSIC: use the client-generated traceId when present so this
    // one message can be grepped end-to-end across sender client, server, and
    // receiver client logs. Generate a server-side one as a fallback only —
    // this should be rare and indicates the client is running a stale build
    // without the traceId patch.
    const _traceId = clientTraceId || ('msgtrace_srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));

    // ── FORENSIC LOG: SEND_START ──────────────────────────────────────────────
    _flog(`[FORENSIC][${_traceId}] SEND_START | senderId=${senderId} | chatId=${existingChatId||'?'} | receiverId=${receiverId||'?'} | localId=${clientLocalId||'?'} | contentLen=${(content||'').length} | ts=${Date.now()}`);

    // Validate content
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Message content is required' });
    }
    if (content.length > 5000) {
      return res.status(400).json({ success: false, message: 'Message too long (max 5000 characters)' });
    }

    const messageType = ALLOWED_MSG_TYPES.includes(type) ? type : 'text';
    const sequelize = req.app.locals.db;
    let chatId = existingChatId ? safeInt(existingChatId) : null;
    const safeReplyToId = replyToId ? safeInt(replyToId) : null;

    // If replyToId is provided, verify the replied message exists and is in the same chat
    if (safeReplyToId && chatId) {
      const repliedMessage = await sequelize.query(
        `SELECT id, "chatId" FROM "Messages" WHERE id = :replyToId AND "isDeleted" = false LIMIT 1`,
        { replacements: { replyToId: safeReplyToId }, type: sequelize.QueryTypes.SELECT }
      );
      
      if (!repliedMessage || repliedMessage.length === 0) {
        return res.status(404).json({ success: false, message: 'Replied message not found' });
      }
      
      if (repliedMessage[0].chatId !== chatId) {
        return res.status(400).json({ success: false, message: 'Replied message must be in the same chat' });
      }
    }

    // Find or create direct chat when no chatId given.
    // CONSOLIDATION: this used to be a second, independent copy of the same
    // find-or-create-direct-chat transaction that messageDeliveryService.js
    // already implements correctly (resolveOrCreateDirectChat, originally
    // written for the /lifecycle/send path). Two live implementations of
    // conversation resolution meant "message a friend from Search" (this
    // route) and "message a friend from a retried socket send"
    // (/lifecycle/send) could theoretically diverge. Both routes now call
    // the exact same function, so there is exactly one Conversation Engine,
    // not two — see README/audit notes for the equivalent frontend rule.
    if (!chatId && receiverId) {
      const safeReceiverId = safeInt(receiverId);
      try {
        chatId = await messageDeliveryService.resolveOrCreateDirectChat(senderId, safeReceiverId);
      } catch (resolveErr) {
        const status = /not found/i.test(resolveErr.message) ? 404 : 400;
        return res.status(status).json({ success: false, message: resolveErr.message || 'Could not resolve conversation' });
      }
    } else if (chatId && receiverId) {
      // FIX-STALE-CHAT-ID (same class of bug already fixed in
      // messageDeliveryService.sendMessage() for the socket path — this
      // REST route had an identical gap): a chatId supplied alongside a
      // receiverId used to be trusted unconditionally, with receiverId
      // only ever consulted when chatId was completely absent. A client
      // holding a stale/incorrect chatId (a cached pending-conversation id
      // that got reused, or the id of a different, previously-opened
      // conversation) next to a correct receiverId would silently have the
      // message written into the wrong conversation. Not currently
      // reachable from this app's own frontend (which never sends both
      // fields in the same request today), but this route is a public API
      // surface — any other caller doing so would hit it. Verify the given
      // chatId actually is the direct chat between (senderId, receiverId);
      // if not, resolve the canonical one instead of trusting it blindly.
      const safeReceiverId = safeInt(receiverId);
      const [match] = await sequelize.query(
        `SELECT c.id FROM chats c
         WHERE c.id = :chatId AND c.type = 'direct'
           AND EXISTS (SELECT 1 FROM chat_participants WHERE "chatId" = c.id AND "userId" = :senderId)
           AND EXISTS (SELECT 1 FROM chat_participants WHERE "chatId" = c.id AND "userId" = :receiverId)
         LIMIT 1`,
        { replacements: { chatId, senderId, receiverId: safeReceiverId }, type: sequelize.QueryTypes.SELECT }
      ).catch(() => [null]);
      if (!match) {
        try {
          chatId = await messageDeliveryService.resolveOrCreateDirectChat(senderId, safeReceiverId);
        } catch (resolveErr) {
          const status = /not found/i.test(resolveErr.message) ? 404 : 400;
          return res.status(status).json({ success: false, message: resolveErr.message || 'Could not resolve conversation' });
        }
      }
    }


    if (!chatId) {
      return res.status(400).json({ success: false, message: 'chatId or receiverId is required' });
    }

    // Confirm sender is participant
    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :senderId LIMIT 1`,
      { replacements: { chatId, senderId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied to this chat' });
    }

    // ── FORENSIC LOG: BACKEND_RECEIVED ───────────────────────────────────────
    _flog(`[FORENSIC][${_traceId}] BACKEND_RECEIVED | senderId=${senderId} | chatId=${chatId} | localId=${clientLocalId||'?'} | ts=${Date.now()}`);

    // ── REPLY-TO RECONCILIATION (temp/local ID → real ID) ──────────────────
    // FIX (reply-first-time-fails): when a user replies to a message that
    // hasn't been confirmed by the server yet — e.g. replying to their own
    // just-sent message within the same second, or the very first exchange
    // in a brand-new chat — the client only has a locally-generated ID
    // (format 'msg_<timestamp>_...', non-numeric) for that message.
    // safeInt() on that string always returns null (parseInt can't parse
    // it), so the reply link was silently dropped — the message itself
    // still sent, but arrived on both sides with no reply-to context at
    // all, which is what looked like "reply doesn't go through". Resolve
    // replyToLocalId against the same metadata->>'localId' index the
    // idempotency check below already uses, now that chatId is finalized
    // (it wasn't yet at the point of the original safeReplyToId numeric
    // check above, for a brand-new conversation created via receiverId).
    let finalReplyToId = safeReplyToId;
    if (!finalReplyToId && replyToLocalId) {
      try {
        const resolved = await sequelize.query(
          `SELECT id FROM "Messages"
           WHERE "chatId" = :chatId AND metadata->>'localId' = :replyToLocalId
             AND "isDeleted" = false
           ORDER BY "createdAt" DESC LIMIT 1`,
          { replacements: { chatId, replyToLocalId: String(replyToLocalId) }, type: sequelize.QueryTypes.SELECT }
        );
        if (resolved && resolved.length > 0) {
          finalReplyToId = resolved[0].id;
          _flog(`[FORENSIC][${_traceId}] REPLY_RECONCILED | replyToLocalId=${replyToLocalId} -> replyToId=${finalReplyToId} | ts=${Date.now()}`);
        } else {
          // Genuine race — the parent message's own INSERT hasn't committed
          // yet (reply composed within the same instant). Don't fail this
          // send over it: it still goes through as a normal message, just
          // without a durable reply-to link in the DB. The sender's own
          // bubble still shows the reply preview locally either way (see
          // sendMessageToBackend in messages-core.operations.js, which
          // keeps the full replyTo snapshot client-side regardless of
          // server-side resolution).
          _flog(`[FORENSIC][${_traceId}] REPLY_UNRESOLVED | replyToLocalId=${replyToLocalId} | parent not in DB yet, sending without link | ts=${Date.now()}`);
        }
      } catch (_reconcileErr) { /* non-fatal — send proceeds without the reply link */ }
    }

    // ── IDEMPOTENCY: If a localId was provided, check if this message was already saved.
    // FIX-AUDIT: Old check used content-match which incorrectly dedupes two DIFFERENT
    // messages that happen to share identical text within the window. Correct fix:
    // store localId in metadata JSONB at insert time (below) and query by it here.
    //
    // FIX-DUAL-IDEMPOTENCY-SYSTEMS: this route's idempotency key has always
    // lived in metadata->>'localId' (a plain SELECT check, no DB constraint
    // behind it), while messageDeliveryService.sendMessage() (used by
    // msg:send and the legacy message:send socket path) dedupes via a
    // dedicated `clientMessageId` column that has an actual unique index
    // (see migration 2026999990013). Two non-interoperating idempotency
    // systems meant a retry that happened to go out over the other
    // transport wouldn't be recognized as a duplicate of one sent via this
    // route, and this route's own check was a plain SELECT-then-INSERT with
    // no atomic guarantee — two near-simultaneous identical requests could
    // both pass the check before either INSERT committed. Both gaps are
    // closed below: this route now also writes clientLocalId into the
    // `clientMessageId` column (so a socket-side retry with the same id is
    // recognized), and the INSERT is wrapped to catch that column's unique
    // constraint as an atomic backstop if this pre-check race still occurs.
    if (clientLocalId) {
      try {
        const existing = await sequelize.query(
          `SELECT id, "chatId", "senderId", content, type, "createdAt" FROM "Messages"
           WHERE "senderId" = :senderId AND "chatId" = :chatId
             AND (metadata->>'localId' = :localId OR "clientMessageId" = :localId)
             AND "createdAt" > NOW() - INTERVAL '10 minutes'
           ORDER BY "createdAt" DESC LIMIT 1`,
          { replacements: { senderId, chatId, localId: String(clientLocalId) }, type: sequelize.QueryTypes.SELECT }
        );
        if (existing && existing.length > 0) {
          const dup = existing[0];
          _flog(`[messages.js] Idempotency hit - returning existing message id=${dup.id} for localId=${clientLocalId}`);
          return res.status(201).json({
            success: true, message: 'Message sent successfully (idempotent)',
            data: { message: { ...dup, localId: clientLocalId } }
          });
        }
      } catch (_idempErr) { /* Non-fatal: proceed with insert */ }
    }

    // FIX-068: Wrap message INSERT + chat UPDATE in a transaction for atomicity
    // Without this, a crash between the two queries leaves the chat with an orphan message
    let messageId, senderRows;
    const t = await sequelize.transaction();

    // FIX-AUDIT: server-side HTML strip (defense in depth — frontend already
    // escapes before render, but other API consumers might not).
    const safeContent = stripHtmlTags(content).trim();

    // Build initial metadata including linkPreview + disappearing timer from chat settings
    // FIX BUG-2: merge client metadata (gifUrl, poll options, sticker emoji, viewOnce flag)
    const msgMetadata = (clientMetadata && typeof clientMetadata === 'object') ? { ...clientMetadata } : {};
    // FIX-AUDIT: persist clientLocalId so the idempotency check above can find it on retry
    if (clientLocalId) msgMetadata.localId = String(clientLocalId);
    if (linkPreview && typeof linkPreview === 'object' && linkPreview.title) {
      msgMetadata.linkPreview = {
        title:       linkPreview.title,
        description: linkPreview.description || null,
        imageUrl:    linkPreview.imageUrl     || null,
        siteName:    linkPreview.siteName     || null,
        url:         linkPreview.url          || null,
      };
    }
    
    // FIX-AUDIT: compute expiresAt from the chat's disappearing-message timer
    // BEFORE building the query (this must be a statement, not embedded inside
    // an object literal — the previous version had a let/try block pasted
    // directly inside the `replacements` object passed to sequelize.query(),
    // which is invalid JavaScript and would throw a SyntaxError on require(),
    // meaning this route could never have actually run in production).
    let _msgExpiresAt = null;
    try {
      const [_chat] = await sequelize.query(
        `SELECT "disappearingTimer" FROM "Chats" WHERE id=:cid LIMIT 1`,
        { replacements: { cid: chatId }, type: sequelize.QueryTypes.SELECT }
      );
      if (_chat && _chat.disappearingTimer > 0) {
        _msgExpiresAt = new Date(Date.now() + _chat.disappearingTimer * 1000);
      }
    } catch (_) { /* non-fatal — message sends without an expiry if this lookup fails */ }

    try {
      let msgResult;
      try {
        msgResult = await sequelize.query(
          // BUG-012 FIX: Explicitly include isRead, isDeleted, isEdited boolean fields.
          // Without these, raw INSERT leaves NULLs at DB level (model defaultValues only
          // apply to ORM inserts, not raw SQL). GET /chats counts WHERE isRead = false —
          // NULL != false — so unread counts were always 0 for all new messages.
          // FIX-FALSE-DELIVERY (forensic clue 3): "deliveredAt" used to be stamped
          // NOW() right here, at INSERT time — before the message had even been
          // handed to Socket.IO, let alone actually reached the receiver. That made
          // every message look "delivered" the instant it was sent, regardless of
          // whether the receiver was online, in the right room, or ever got it.
          // socket.emit() succeeding only proves the emit call didn't throw — it is
          // not proof of delivery. "deliveredAt" is now left NULL at insert time and
          // is only ever set later, from the real two-phase ack in
          // webSocketService.js's 'message:delivery_ack' handler (fired only after
          // the receiver's client has actually received and stored the message).
          //
          // FIX-DUAL-IDEMPOTENCY-SYSTEMS: clientLocalId is now also written into
          // the dedicated `clientMessageId` column (which has a real unique index
          // on (senderId, clientMessageId) — see migration 2026999990013), not
          // just into metadata. This makes the same id recognizable regardless of
          // whether a retry goes out over this REST route or the msg:* socket
          // path, and gives this INSERT an atomic uniqueness guarantee the
          // metadata-only check above can't provide on its own.
          `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"replyToId",metadata,"clientMessageId","expiresAt","isRead","isDeleted","isEdited","status","sentAt","deliveredAt","createdAt","updatedAt")
           VALUES (:chatId,:senderId,:content,:type,'{}',:replyToId,:metadata,:clientMessageId,:expiresAt,false,false,false,'sent',NOW(),NULL,NOW(),NOW())
           RETURNING id,"chatId","senderId",content,type,"replyToId","createdAt"`,
          {
            replacements: { chatId, senderId, content: safeContent, type: messageType, replyToId: finalReplyToId, metadata: JSON.stringify(msgMetadata), clientMessageId: clientLocalId ? String(clientLocalId) : null, expiresAt: _msgExpiresAt },
            type: sequelize.QueryTypes.INSERT,
            transaction: t,
          }
        );
      } catch (insertErr) {
        // FIX-DUAL-IDEMPOTENCY-SYSTEMS: the pre-check above is a plain SELECT
        // with no atomic guarantee — two near-simultaneous identical retries
        // could both pass it before either INSERT commits. If that happens,
        // the second INSERT now hits the real unique index on
        // (senderId, clientMessageId) instead of creating a duplicate row.
        // Treat that specific failure as "already sent" and look the real
        // row up, instead of surfacing a 500 for what is actually a
        // successful, already-delivered send.
        const isUniqueViolation = insertErr && (insertErr.name === 'SequelizeUniqueConstraintError' || /duplicate key value/i.test(insertErr.message || ''));
        if (isUniqueViolation && clientLocalId) {
          await t.rollback();
          const [dup] = await sequelize.query(
            `SELECT id, "chatId", "senderId", content, type, "createdAt" FROM "Messages"
             WHERE "senderId" = :senderId AND "clientMessageId" = :localId LIMIT 1`,
            { replacements: { senderId, localId: String(clientLocalId) }, type: sequelize.QueryTypes.SELECT }
          ).catch(() => [null]);
          if (dup) {
            _flog(`[messages.js] Idempotency race caught by unique index - returning existing message id=${dup.id} for localId=${clientLocalId}`);
            return res.status(201).json({
              success: true, message: 'Message sent successfully (idempotent)',
              data: { message: { ...dup, localId: clientLocalId } }
            });
          }
        }
        throw insertErr;
      }
      messageId = msgResult[0][0].id;

      await sequelize.query(
        `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
        { replacements: { messageId, chatId }, transaction: t }
      );

      await t.commit();

      // ── FORENSIC LOG: DB_SAVED ──────────────────────────────────────────────
      _flog(`[FORENSIC][${_traceId}] DB_SAVED | messageId=${messageId} | chatId=${chatId} | senderId=${senderId} | ts=${Date.now()}`);

      // ── PHASE24 STAGE 7: DATABASE VERIFICATION ───────────────────────────
      // Never trust that a committed INSERT is actually readable — re-SELECT
      // the row by its own returned id, outside the transaction, the same way
      // any other request (a refresh, a different device) would read it. If
      // this ever comes back empty/mismatched despite t.commit() having
      // resolved, that is proof of a replication-lag / read-replica /
      // connection-pool routing issue, not an application bug.
      try {
        const _verifyRows = await sequelize.query(
          `SELECT id, "chatId", "senderId", content, type, "createdAt" FROM "Messages" WHERE id = :messageId LIMIT 1`,
          { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
        );
        const _v = _verifyRows && _verifyRows[0];
        if (!_v) {
          console.error(`[FORENSIC][${_traceId}] STAGE7_DB_VERIFY_FAILED | messageId=${messageId} | reason=row_not_found_after_commit | ts=${Date.now()}`);
        } else if (String(_v.chatId) !== String(chatId) || String(_v.senderId) !== String(senderId)) {
          console.error(`[FORENSIC][${_traceId}] STAGE7_DB_VERIFY_MISMATCH | messageId=${messageId} | expectedChatId=${chatId} actualChatId=${_v.chatId} | expectedSenderId=${senderId} actualSenderId=${_v.senderId} | ts=${Date.now()}`);
        } else {
          _flog(`[FORENSIC][${_traceId}] STAGE7_DB_VERIFIED | messageId=${messageId} | chatId=${_v.chatId} | senderId=${_v.senderId} | createdAt=${_v.createdAt} | ts=${Date.now()}`);
        }
      } catch (_verifyErr) {
        console.error(`[FORENSIC][${_traceId}] STAGE7_DB_VERIFY_ERROR | messageId=${messageId} | error=${_verifyErr.message} | ts=${Date.now()}`);
      }

      senderRows = await sequelize.query(
        `SELECT id, username, avatar FROM "Users" WHERE id = :senderId`,
        { replacements: { senderId }, type: sequelize.QueryTypes.SELECT }
      );
    } catch (txErr) {
      // FIX-DOUBLE-ROLLBACK: the unique-violation branch above may already
      // have called t.rollback() itself (to free the transaction before
      // doing an independent duplicate-lookup query) before re-throwing.
      // Calling rollback a second time on an already-finished Sequelize
      // transaction throws its own error, which would mask the real one.
      try { await t.rollback(); } catch (_alreadyFinished) { /* already rolled back above — fine */ }
      throw txErr;
    }

    // ✅ FIX: Fetch replyTo content so receiver gets preview immediately
    let replyToData = null;
    if (finalReplyToId) {
      try {
        const replyRows = await sequelize.query(
          `SELECT m.id, m.content, m.type, m."senderId", u.username as "senderName"
           FROM "Messages" m
           LEFT JOIN "Users" u ON u.id = m."senderId"
           WHERE m.id = :replyToId AND m."isDeleted" = false LIMIT 1`,
          { replacements: { replyToId: finalReplyToId }, type: sequelize.QueryTypes.SELECT }
        );
        if (replyRows && replyRows.length > 0) replyToData = replyRows[0];
      } catch(_) {}
    }

    const populatedMessage = {
      id:          messageId,
      localId:     clientLocalId || null,
      traceId:     _traceId,
      chatId,
      senderId,
      content:     safeContent,
      type:        messageType,
      reactions:   {},
      replyToId:   finalReplyToId || null,
      replyTo:     replyToData || null,
      metadata:    msgMetadata || {},
      status:      'sent',
      isEdited:    false,
      isDeleted:   false,
      isRead:      false,
      sentAt:      new Date().toISOString(),
      // FIX-FALSE-DELIVERY (forensic clue 3): don't hand the client a
      // deliveredAt timestamp before delivery has actually happened — see the
      // matching comment on the INSERT above. Real value is filled in later by
      // the message:delivered event once the receiver's client ACKs.
      deliveredAt: null,
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
      sender:      senderRows[0] || null,
    };

    // ── REALTIME DELIVERY ─────────────────────────────────────────────────────
    // FIX: Replaced silent catch with loud error logging so delivery failures
    // are visible in server logs. Also added explicit io-null guard with warning
    // so engineers can diagnose "wsService.setIO() not called before first request".
    try {
      const wsService = require('../services/webSocketService');

      // Verify io is actually available before attempting delivery
      const io = wsService.getIO ? wsService.getIO() : null;
      if (!io) {
        console.error(
          '[messages.js] ❌ WebSocket io is NULL — message saved but NOT delivered in real-time.' +
          ' Ensure wsService.setIO(io) is called at server startup BEFORE accepting requests.' +
          ` chatId=${chatId} messageId=${messageId}`
        );
        // Do NOT return — still send HTTP 201; the message is in the DB.
        // Fall through so the response is sent below.
      } else {
        const participants = await sequelize.query(
          `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
          { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
        );

        const allParticipantIds = (participants || [])
          .map((row) => parseInt(row.userId, 10))
          .filter(Boolean);
        const recipientIds = allParticipantIds.filter(id => id !== senderId);

        // ── FORENSIC LOG: TRANSPORT_SELECTED ─────────────────────────────────
        const _htrAvail = !!global.__HybridTransportRuntime;
        _flog(`[FORENSIC][${_traceId}] TRANSPORT_SELECTED | messageId=${messageId} | transport=${_htrAvail?'HTR+SocketIO':'SocketIO'} | recipients=${recipientIds.join(',')} | ts=${Date.now()}`);

        // CONSOLIDATE-MESSAGE-PROTOCOL (point 1): 'message:new' and 'msg:new'
        // used to be built from two SEPARATELY CONSTRUCTED payload objects
        // (populatedMessage vs. a hand-picked field subset) — the exact kind
        // of drift that lets the two protocols silently diverge (a field
        // present on one, missing/renamed on the other) and was flagged here
        // as a live, unresolved risk ("DUAL_EMIT_WARNING"). There is now ONE
        // canonical payload, built once, reused for both emits. 'msg:new' is
        // canonical (this is what MessageLifecycleClient.js's race-free
        // listener consumes); 'message:new' is kept ONLY as a thin adapter
        // for the frontend's still-active legacy listeners (app.realtime.
        // socket.js, mesh-messages-bridge.js, etc. — see MESSAGE_LIFECYCLE_
        // REBUILD.md) and carries the identical data, not a re-derived copy.
        const canonicalPayload = {
          serverId:   populatedMessage.id,
          id:         populatedMessage.id,
          traceId:    populatedMessage.traceId,
          chatId:     populatedMessage.chatId,
          conversationId: populatedMessage.chatId,
          senderId:   populatedMessage.senderId,
          content:    populatedMessage.content,
          type:       populatedMessage.type,
          sender:     populatedMessage.sender,
          replyToId:  populatedMessage.replyToId,
          replyTo:    populatedMessage.replyTo,
          metadata:   populatedMessage.metadata,
          status:     'sent',
          createdAt:  populatedMessage.createdAt,
          sentAt:     populatedMessage.sentAt,
          deliveredAt: null,
        };

        // sendToUser() already emits to all room-name variants for the uid.
        const deliveryResults = await Promise.allSettled(
          recipientIds.map(uid => wsService.sendToUser(uid, 'msg:new', canonicalPayload))
        );
        recipientIds.forEach(uid => {
          wsService.sendToUser(uid, 'message:new', canonicalPayload).catch(() => {});
        });

        if (recipientIds.length > 0) {
          _flog(`[FORENSIC][${_traceId}] BROADCAST_PAYLOAD_UNIFIED | messageId=${messageId} | events=msg:new(canonical),message:new(adapter) | recipients=${recipientIds.join(',')} | ts=${Date.now()}`);
        }

        // ── FORENSIC LOG: BROADCASTED ─────────────────────────────────────────
        const _delivered = deliveryResults.filter(r => r.status === 'fulfilled' && r.value === true).length;
        const _failed    = deliveryResults.length - _delivered;
        _flog(`[FORENSIC][${_traceId}] BROADCASTED | messageId=${messageId} | chatId=${chatId} | recipients=${recipientIds.join(',')} | delivered=${_delivered}/${deliveryResults.length} | failed=${_failed} | ts=${Date.now()}`);

        // ── PUSH NOTIFICATIONS: send to offline recipients ──────────────────
        const _offlineRecipients = deliveryResults
          .map((r, i) => ({ uid: recipientIds[i], delivered: r.status === 'fulfilled' && r.value === true }))
          .filter(r => !r.delivered).map(r => r.uid);

        // FIX-ZOMBIE-SOCKET-PUSH-FALLBACK: extracted so the SAME push logic can
        // also run later, off the real message:delivery_ack timeout below, for
        // recipients the room-membership check wrongly called "delivered" (see
        // matching comment on scheduleMessageDeliveryTimeout in webSocketService.js).
        const _pushFallback = async (uids) => {
          if (!uids.length) return;
          try {
            const pushSvc = require('../services/pushNotificationService');
            const sRows   = await sequelize.query(
              `SELECT username, avatar FROM "Users" WHERE id=:id LIMIT 1`,
              { replacements: { id: senderId }, type: sequelize.QueryTypes.SELECT }
            );
            const notifContent = messageType === 'text' ? (content || '').slice(0, 100) : `Sent a ${messageType}`;
            await Promise.allSettled(uids.map(uid =>
              pushSvc.notifyNewMessage(uid, {
                senderName: sRows?.[0]?.username || 'Someone',
                senderAvatar: sRows?.[0]?.avatar || null,
                content: notifContent, chatId, messageId,
              }, sequelize)
            ));
          } catch (_pe) { console.warn('[messages.js] Push error (non-fatal):', _pe.message); }
        };

        if (_offlineRecipients.length > 0) {
          setImmediate(() => _pushFallback(_offlineRecipients));
        }

        // ── DELIVERY LOGS ───────────────────────────────────────────────────
        // FIX-FALSE-DELIVERY (forensic clue 3): this used to write a 'delivered'
        // audit row for every recipientId unconditionally — even ones where
        // deliveryResults above showed the socket room was empty (recipient
        // offline/not-yet-joined). socket.emit() not throwing only proves the
        // emit call completed, not that anything reached the receiver. Log what
        // actually happened here ('sent' for a successful emit into a non-empty
        // room, 'send_failed' otherwise); the one true 'delivered' event is now
        // written from webSocketService.js's 'message:delivery_ack' handler,
        // which only fires after the receiver's client has actually received
        // and stored the message and echoed the ack back.
        setImmediate(async () => {
          try {
            await Promise.allSettled(recipientIds.map((uid, i) => {
              const _wasEmitted = deliveryResults[i] && deliveryResults[i].status === 'fulfilled' && deliveryResults[i].value === true;
              return sequelize.query(
                `INSERT INTO message_delivery_logs ("messageId","userId","chatId","event","createdAt")
                 VALUES (:messageId,:uid,:chatId,:event,NOW())
                 ON CONFLICT ("messageId","userId","event") DO NOTHING`,
                { replacements: { messageId, uid, chatId, event: _wasEmitted ? 'sent' : 'send_failed' } }
              );
            }));
          } catch (_) {}
        });

        // ── MENTIONS: store + push notify ───────────────────────────────────
        setImmediate(async () => {
          try {
            const mentionMatches = (content || '').match(/@(\w+)/g);
            if (mentionMatches && mentionMatches.length > 0) {
              const usernames = mentionMatches.map(m => m.slice(1));
              const mUsers = await sequelize.query(
                `SELECT id FROM "Users" WHERE username = ANY(:usernames)`,
                { replacements: { usernames }, type: sequelize.QueryTypes.SELECT }
              );
              const pushSvc = require('../services/pushNotificationService');
              const sRows   = await sequelize.query(
                `SELECT username FROM "Users" WHERE id=:id LIMIT 1`,
                { replacements: { id: senderId }, type: sequelize.QueryTypes.SELECT }
              );
              await Promise.allSettled(mUsers.map(async u => {
                await sequelize.query(
                  `INSERT INTO message_mentions ("messageId","chatId","mentionedUserId","mentionedBy","createdAt")
                   VALUES (:messageId,:chatId,:uid,:senderId,NOW()) ON CONFLICT DO NOTHING`,
                  { replacements: { messageId, chatId, uid: u.id, senderId } }
                ).catch(() => {});
                await pushSvc.notifyMention(u.id, {
                  senderName: sRows?.[0]?.username || 'Someone',
                  content: (content || '').slice(0, 100), chatId, messageId,
                }, sequelize);
              }));
            }
          } catch (_) {}
        });

        // FIX Bug #1 & #4: Fetch chat type so group broadcasts work correctly.
        // Previously `chat` and `safeChatId` were never defined in this POST scope,
        // causing a ReferenceError that crashed the entire realtime delivery block.
        let _chatType = null;
        try {
          const _chatRows = await sequelize.query(
            `SELECT type FROM chats WHERE id = :chatId LIMIT 1`,
            { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
          );
          _chatType = _chatRows?.[0]?.type || null;
        } catch (_) {}

        // FIX-AUDIT-2 (revised): The previous version emitted this same message
        // 3 separate ways: 'group:message' to BOTH `group:<id>` and `group_<id>`
        // rooms (every member's socket is joined to both — see
        // webSocketService.js's dual room-join — so this alone double-delivered
        // to every recipient), PLUS a 3rd distinct event 'new_group_message' to
        // `chat:<id>`, which a separate orchestration layer on the frontend
        // (CentralOrchestrationRuntime.js) maps to its own render-triggering
        // event, causing a third independent delivery. Emit the single
        // canonical event once, matching the one true delivery path used by
        // the dedicated group-send route in group.js.
        if (_chatType === 'group') {
          try {
            const groupPayload = { ...populatedMessage, groupId: chatId, chatId };
            const _io = wsService.getIO?.() || wsService.io;
            if (_io) {
              _io.to(`group:${chatId}`).emit('group:message', groupPayload);
            }
          } catch(_) {}
        }

        // Count successes for diagnostics (already logged in FORENSIC:BROADCASTED above)
        if (_failed > 0) {
          console.warn(`[messages.js] ⚠️ sendToUser: ${_delivered}/${deliveryResults.length} delivered, ${_failed} failed for chatId=${chatId}`);
        }

        // FIX-ROOT-CAUSE-DUPLICATE: Removed broadcastToChat(chatId, 'message:new').
        // Reason: broadcastToChat emits to chat:<chatId> and chat_<chatId> rooms.
        // The sender's socket joins ALL their chat rooms on authentication (see
        // webSocketService.js _joinUserChatRooms). This means the sender receives
        // message:new from the room broadcast even though sendToUser() above only
        // targeted recipientIds (excluding sender). Since the socket payload may
        // have localId=null, addMessage() can't match it to the existing optimistic
        // copy — it appends a second bubble, creating the visible duplicate.
        //
        // Recipients are fully covered by sendToUser() above. The broadcastToChat
        // was a safety net for sockets that joined via chat room but missed the
        // user room — but those are the same sockets, and we emit to both user:X
        // and user_X variants in sendToUser, so all reachable sockets are covered.
        //
        // If (in future) you need chat-room delivery for non-participant sockets
        // (e.g. observers), exclude the sender explicitly:
        //   io.to(`chat:${chatId}`).except(senderSocketId).emit('message:new', ...)
        // But that requires passing senderSocketId through the delivery path.

        // FIX-010: Single canonical 'message:sent' event — sendToUser() covers all room variants
        await wsService.sendToUser(senderId, 'message:sent', {
          localId:   populatedMessage.localId || null,
          messageId,
          serverId:  messageId,
          chatId,
          status:    'sent',
          createdAt: populatedMessage.createdAt
        });

        // FIX-MSG-DELIVERY Phase 1: tell sender server received it (immediate)
        await wsService.sendToUser(senderId, 'message:received_by_server', {
          messageId, chatId, timestamp: Date.now()
        }).catch(() => {});

        // FIX-MSG-DELIVERY-FALSE-TIMEOUT-ROOT-CAUSE (superseded — see
        // FIX-ZOMBIE-SOCKET-PUSH-FALLBACK above and in webSocketService.js):
        // this used to only arm scheduleMessageDeliveryTimeout for recipients
        // deliveryResults already called "unconfirmed", on the reasoning that a
        // confirmed room-emit was itself sufficient proof of delivery and a
        // second, independent, ack-based proof was redundant. It isn't: Socket.IO
        // can report a room as having a member for up to pingTimeout+pingInterval
        // (90s+25s here) after the underlying connection actually died — so
        // "delivered: true" from the room snapshot can be a false positive, and
        // that's exactly the gap that let messages vanish silently for a receiver
        // whose socket had gone stale. The real message:delivery_ack round trip
        // is the only trustworthy signal; arm it for every recipient, always, and
        // let a genuine 10s silence trigger the same push-notification fallback
        // used for recipients that were reported offline outright.
        for (const rid of recipientIds) {
          if (typeof wsService.scheduleMessageDeliveryTimeout === 'function') {
            wsService.scheduleMessageDeliveryTimeout(messageId, chatId, senderId, {
              recipientUserId: rid,
              onTimeout: () => _pushFallback([rid]),
            });
          }
        }

        // Tell sender when at least one recipient was targeted
        // NOTE: message:delivered is now sent by the TWO-PHASE ACK system:
        //   receiver emits 'message:delivery_ack' → server emits 'message:delivered' to sender.
        // The old eager emit here is removed to prevent false "delivered" status.
        if (recipientIds.length > 0) {
          _flog(`[messages.js] 📨 Delivery tracking started for messageId=${messageId} recipients=${recipientIds.join(',')}`);
        }

        _flog(
          `[messages.js] ✅ Realtime delivery: chatId=${chatId} messageId=${messageId}` +
          ` participants=${allParticipantIds.length} recipients=${recipientIds.length}`
        );
      }
    } catch (notifyError) {
      // Non-fatal: message is already in the DB. Log clearly so it's never silently lost.
      console.error('[messages.js] ❌ Realtime delivery threw an error (message is saved):', notifyError.message, notifyError.stack);
    }

    // FIX: Wrap in data.message so messageQueue._sendToServer() and
    // messageSync.engine._fetchServerMessages() can both extract correctly:
    // data?.data?.message || data?.message || data?.data
    // Also expose chatId at top level for pending conversation replacement
    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      chatId,                          // top-level for createConversation pending replacement
      data: { message: populatedMessage, chatId },
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));

// ============================================================================
// GET /api/messages/:chatId - Fetch messages by URL param (backward compat)
// ============================================================================
router.get('/:chatId', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const chatId = safeInt(req.params.chatId);
    if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

    const page = safeInt(req.query.page) || 1;
    const limit = Math.min(safeInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const sequelize = req.app.locals.db;

    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
    }

    const chat = await sequelize.query(
      `SELECT id, type as "chatType", name as "chatName", "isActive" FROM chats WHERE id = :chatId`,
      { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!chat || chat.length === 0) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    const replacements = { chatId };
    let beforeClause = '';
    let afterClause = '';

    if (req.query.before) {
      const d = new Date(req.query.before);
      if (!isNaN(d.getTime())) { 
        beforeClause = 'AND m."createdAt" < :before'; 
        replacements.before = d.toISOString(); 
      }
    }
    if (req.query.after) {
      const d = new Date(req.query.after);
      if (!isNaN(d.getTime())) { 
        afterClause = 'AND m."createdAt" > :after'; 
        replacements.after = d.toISOString(); 
      }
    }

    const messages = await sequelize.query(
      `SELECT m.id, m."chatId", m."senderId", m.content,
              m.type as "messageType", m.reactions, m."isEdited",
              m."editedAt", m."isDeleted", m."createdAt", m."updatedAt",
              m."replyToId", m.metadata, m."viewOnceViewedAt", m."viewOnceViewedBy",
              jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) as sender,
              CASE WHEN m."replyToId" IS NOT NULL THEN
                jsonb_build_object(
                  'id',         rm.id,
                  'content',    rm.content,
                  'type',       rm.type,
                  'senderId',   rm."senderId",
                  'senderName', ru.username,
                  'messageId',  rm.id
                )
              ELSE NULL END as "replyTo"
       FROM "Messages" m
       LEFT JOIN "Users" u  ON u.id  = m."senderId"
       LEFT JOIN "Messages" rm ON rm.id = m."replyToId" AND rm."isDeleted" = false
       LEFT JOIN "Users" ru ON ru.id = rm."senderId"
       WHERE m."chatId" = :chatId AND m."isDeleted" = false ${beforeClause} ${afterClause}
       ORDER BY m."createdAt" DESC LIMIT :_limit OFFSET :_offset`,
      { replacements: { ...replacements, _limit: limit, _offset: offset }, type: sequelize.QueryTypes.SELECT }
    );

    const countResult = await sequelize.query(
      `SELECT COUNT(*) as total FROM "Messages" m
       WHERE m."chatId" = :chatId AND m."isDeleted" = false ${beforeClause} ${afterClause}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );

    const total = parseInt(countResult[0]?.total || 0);

    res.status(200).json({
      status: 'success',
      data: {
        messages: messages.reverse().map(m => {
          const rawMediaUrl = m.metadata?.mediaUrl || null;
          // NEW FEATURE: View Once gating — see matching comment in GET / above.
          const isViewOnce = (m.messageType || m.type) === 'view_once';
          const alreadyViewed = !!m.viewOnceViewedAt;
          const viewOnceGatedMediaUrl = isViewOnce && alreadyViewed ? null : rawMediaUrl;
          return {
            ...m,
            type: m.messageType || m.type || 'text',
            mediaUrl: viewOnceGatedMediaUrl,
            fileUrl: viewOnceGatedMediaUrl,
            ...(isViewOnce ? {
              viewOnceViewed: alreadyViewed,
              viewOnceViewedAt: m.viewOnceViewedAt || null,
              viewOnceViewedBy: m.viewOnceViewedBy || null,
            } : {}),
          };
        }),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
        chatInfo: { id: chat[0].id, chatType: chat[0].chatType, chatName: chat[0].chatName },
      },
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch messages' });
  }
}));

// ============================================================================
// POST /api/messages/:chatId/upload - Upload file to chat
// ============================================================================
router.post('/:chatId/upload', apiRateLimiter, upload.single('file'), asyncHandler(async (req, res) => {
  try {
    const chatId = safeInt(req.params.chatId);
    if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

    const sequelize = req.app.locals.db;

    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    // SECURITY FIX: validate actual file magic bytes against declared MIME type
    if (!_validateMagicBytes(req.file.buffer || req.file.path, req.file.mimetype)) {
      if (req.file.path) await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ success: false, message: 'File content does not match declared type' });
    }

    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      if (req.file.path) await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
    }

    const caption = req.body.caption ? stripHtmlTags(req.body.caption.substring(0, 500)) : '';
    let msgType = getMessageTypeFromMime(req.file.mimetype);

    // NEW FEATURE: View Once media. Only image/video make sense as view-once
    // (matching WhatsApp/Signal); audio/file/document uploads ignore the flag.
    const isViewOnceRequested = req.body.viewOnce === 'true' || req.body.viewOnce === true;
    const isViewOnceEligible = msgType === 'image' || msgType === 'video';
    if (isViewOnceRequested && isViewOnceEligible) {
      msgType = 'view_once';
    }

    // FIX-AUDIT (MSG-BE-004): Wrap INSERT + both UPDATEs in a transaction.
    // Previously these were 3 separate unguarded queries — a crash between
    // them left an orphan Message row with no mediaUrl or a chat whose
    // lastMessageId pointer was never updated.
    const t = await sequelize.transaction();
    let messageId;
    try {
      const msgResult = await sequelize.query(
        `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"isRead","isDeleted","isEdited","sentAt","deliveredAt","createdAt","updatedAt")
         VALUES (:chatId,:senderId,:content,:type,'{}',false,false,false,NOW(),NOW(),NOW(),NOW())
         RETURNING id,"chatId","senderId",content,type,"createdAt"`,
        {
          replacements: { chatId, senderId: req.user.id, content: caption, type: msgType },
          type: sequelize.QueryTypes.INSERT,
          transaction: t,
        }
      );

      messageId = msgResult[0][0].id;

      // Build absolute URL — S3 returns req.file.location; Cloudinary needs an
      // explicit upload of the in-memory buffer; disk uses relative path
      let absUrl;
      if (_storageBackend === 'cloudinary') {
        const folder = `nexopa/messages/${msgType === 'image' ? 'images' : msgType === 'video' ? 'video' : msgType === 'view_once' ? 'view-once' : msgType === 'audio' ? 'audio' : 'files'}`;
        const cldResult = await cloudinaryService.uploadToCloudinary(req.file.buffer, { folder });
        if (!cldResult) throw new Error('Cloudinary upload failed');
        absUrl = cldResult.url;
      } else if (_storageBackend === 's3' && req.file && req.file.location) {
        absUrl = req.file.location;
      } else {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
        const subDir  = msgType === 'image' ? 'images' : msgType === 'audio' ? 'audio' : msgType === 'video' ? 'video' : msgType === 'view_once' ? 'view-once' : 'files';
        absUrl = `${baseUrl.replace(/\/+$/, '')}/uploads/${subDir}/${req.file.filename}`;
      }

      // Store mediaUrl in message metadata so GET messages can return it.
      // For view-once, also tag the original media type (image/video) since
      // the GET route gates raw mediaUrl visibility based on viewOnceViewedAt.
      // FIX-AUDIT: removed bogus "lastMessageId" = id reference — Messages has
      // no such column (it belongs to chats); the old UPDATE silently failed
      // every single time and was masked by .catch(() => {}).
      const metadataPatch = msgType === 'view_once'
        ? { mediaUrl: absUrl, viewOnceMediaType: getMessageTypeFromMime(req.file.mimetype) }
        : { mediaUrl: absUrl };
      await sequelize.query(
        `UPDATE "Messages" SET metadata = COALESCE(metadata,'{}'::jsonb) || :patch::jsonb
         WHERE id = :messageId`,
        { replacements: { messageId, patch: JSON.stringify(metadataPatch) }, transaction: t }
      );

      await sequelize.query(
        `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
        { replacements: { messageId, chatId }, transaction: t }
      );

      await t.commit();

      res.status(201).json({
        status: 'success',
        message: 'File uploaded successfully',
        data: {
          message: { id: messageId, chatId, senderId: req.user.id, content: caption, type: msgType, mediaUrl: absUrl, viewOnce: msgType === 'view_once' },
          fileUrl: absUrl,
          url: absUrl,
          mediaUrl: absUrl,
        },
      });
    } catch (txErr) {
      await t.rollback().catch(() => {});
      throw txErr;
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    if (req.file && req.file.path) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ status: 'error', message: 'Failed to upload file' });
  }
}));

// ============================================================================
// GET /api/messages/:chatId/search - Search messages in a chat
// ============================================================================
router.get('/:chatId/search', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const chatId = safeInt(req.params.chatId);
    if (!chatId) return res.status(400).json({ success: false, message: 'Invalid chatId' });

    const { query: searchQuery, page = 1, limit = 20 } = req.query;
    if (!searchQuery || searchQuery.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
    }

    const pageNum = safeInt(page) || 1;
    const limitNum = Math.min(safeInt(limit) || 20, 50);
    const offset = (pageNum - 1) * limitNum;
    const sequelize = req.app.locals.db;

    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
    }

    const messages = await sequelize.query(
      `SELECT m.id, m."chatId", m."senderId", m.content, m.type as "messageType", m."createdAt",
              jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) as sender
       FROM "Messages" m
       LEFT JOIN "Users" u ON u.id = m."senderId"
       WHERE m."chatId" = :chatId AND m."isDeleted" = false AND m.content ILIKE :pattern
       ORDER BY m."createdAt" DESC LIMIT :_limit OFFSET :_offset`,
      { replacements: { chatId, pattern: `%${searchQuery.trim()}%`, _limit: limitNum, _offset: offset }, type: sequelize.QueryTypes.SELECT }
    );

    const countResult = await sequelize.query(
      `SELECT COUNT(*) as total FROM "Messages" m
       WHERE m."chatId" = :chatId AND m."isDeleted" = false AND m.content ILIKE :pattern`,
      { replacements: { chatId, pattern: `%${searchQuery.trim()}%` }, type: sequelize.QueryTypes.SELECT }
    );

    const total = parseInt(countResult[0]?.total || 0);

    res.status(200).json({
      status: 'success',
      data: {
        messages: messages.reverse(),
        pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
      },
    });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ status: 'error', message: 'Failed to search messages' });
  }
}));

// ============================================================================
// POST /api/messages/bulk — Send one message to multiple conversations (Multi-Send)
// ============================================================================
router.post('/bulk', apiRateLimiter, chatLimiter, asyncHandler(async (req, res) => {
  try {
    const { conversationIds, content, type = 'text', replyVisibility = 'public' } = req.body;
    const senderId = req.user.id;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Message content is required' });
    }
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return res.status(400).json({ success: false, message: 'conversationIds array is required' });
    }
    if (conversationIds.length > 50) {
      return res.status(400).json({ success: false, message: 'Cannot send to more than 50 conversations at once' });
    }

    const safeChatIds = conversationIds.map(safeInt).filter(Boolean);
    if (safeChatIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid conversationIds provided' });
    }

    const sequelize = req.app.locals.db;
    const batchId = require('crypto').randomUUID();
    const messageType = ALLOWED_MSG_TYPES.includes(type) ? type : 'text';
    // FIX-AUDIT: server-side HTML strip, same as single-send route
    const safeContent = stripHtmlTags(content).trim();
    const results = [];

    for (const chatId of safeChatIds) {
      try {
        // Verify sender is participant
        const isParticipant = await sequelize.query(
          `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :senderId LIMIT 1`,
          { replacements: { chatId, senderId }, type: sequelize.QueryTypes.SELECT }
        );
        if (!isParticipant || isParticipant.length === 0) continue;

        const msgResult = await sequelize.query(
          `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"isRead","isDeleted","isEdited","sentAt","deliveredAt","createdAt","updatedAt",metadata)
           VALUES (:chatId,:senderId,:content,:type,'{}',false,false,false,NOW(),NOW(),NOW(),NOW(),:metadata)
           RETURNING id,"chatId","senderId",content,type,"createdAt"`,
          {
            replacements: {
              chatId, senderId, content: safeContent, type: messageType,
              metadata: JSON.stringify({ batchId, replyVisibility })
            },
            type: sequelize.QueryTypes.INSERT,
          }
        );

        const messageId = msgResult[0][0].id;
        await sequelize.query(
          `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
          { replacements: { messageId, chatId } }
        );

        const senderRows = await sequelize.query(
          `SELECT id, username, avatar FROM "Users" WHERE id = :senderId`,
          { replacements: { senderId }, type: sequelize.QueryTypes.SELECT }
        );

        const populatedMessage = {
          id: messageId, chatId, senderId, content: safeContent, type: messageType,
          reactions: {}, batchId, replyVisibility,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(), deliveredAt: new Date().toISOString(),
          sender: senderRows[0] || null,
        };

        results.push({ chatId, messageId, success: true });

        // Real-time delivery
        try {
          const wsService = require('../services/webSocketService');
          const participants = await sequelize.query(
            `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
            { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
          );
          const allParticipantIds = (participants || []).map(r => parseInt(r.userId, 10)).filter(Boolean);
          const recipientIds = allParticipantIds.filter(id => id !== senderId);

          // FIX-010: Single canonical 'message:new' event — sendToUser() covers all room variants
          // FIX: Only deliver to recipients, not sender (sender has optimistic message already)
          await Promise.allSettled(
            recipientIds.map(uid => wsService.sendToUser(uid, 'message:new', populatedMessage))
          );
          if (typeof wsService.broadcastToChat === 'function') {
            wsService.broadcastToChat(chatId, 'message:new', populatedMessage, []);
          }
          // FIX-LIFECYCLE-DEADCODE: see matching comment on the single-message send
          // path above — same reasoning, same shim, so bulk/share sends also engage
          // MessageLifecycleClient's race-free listener instead of relying solely on
          // the old relay/claim system.
          recipientIds.forEach(uid => {
            wsService.sendToUser(uid, 'msg:new', {
              serverId: populatedMessage.id,
              chatId: populatedMessage.chatId,
              senderId: populatedMessage.senderId,
              content: populatedMessage.content,
              type: populatedMessage.type,
              sender: populatedMessage.sender,
              replyToId: null,
              createdAt: populatedMessage.createdAt,
              sentAt: populatedMessage.sentAt,
            }).catch(() => {});
          });
        } catch (notifyErr) {
          console.warn('[bulk] Realtime delivery failed for chatId=' + chatId + ':', notifyErr.message);
        }
      } catch (err) {
        results.push({ chatId, success: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    res.status(201).json({
      success: true,
      message: `Sent to ${successCount}/${safeChatIds.length} conversation(s)`,
      data: { batchId, results, successCount, totalTargeted: safeChatIds.length }
    });
  } catch (error) {
    console.error('Error in bulk send:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));

// ============================================================================
// GET /api/messages/bulk/history — Get multi-send history for current user
// ============================================================================
router.get('/bulk/history', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;
    const sequelize = req.app.locals.db;

    // Fetch distinct batchIds from messages sent by this user
    const rows = await sequelize.query(
      `SELECT DISTINCT
         metadata->>'batchId' AS "batchId",
         content,
         metadata->>'replyVisibility' AS "replyVisibility",
         MIN("createdAt") AS "createdAt",
         COUNT(*) AS "deliveryCount",
         COUNT(CASE WHEN "isRead" = true THEN 1 END) AS "seenCount"
       FROM "Messages"
       WHERE "senderId" = :userId
         AND metadata->>'batchId' IS NOT NULL
         AND "isDeleted" = false
       GROUP BY metadata->>'batchId', content, metadata->>'replyVisibility'
       ORDER BY MIN("createdAt") DESC
       LIMIT 50`,
      { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
    );

    // For each batch, get recipient list
    const history = await Promise.all((rows || []).map(async (row) => {
      try {
        const recipients = await sequelize.query(
          `SELECT m."chatId", m."createdAt", m."deliveredAt", m."isRead", m."readAt",
                  u.id AS "userId", u.username, u.avatar
           FROM "Messages" m
           JOIN chat_participants cp ON cp."chatId" = m."chatId"
           JOIN "Users" u ON u.id = cp."userId"
           WHERE m."senderId" = :userId
             AND m.metadata->>'batchId' = :batchId
             AND cp."userId" != :userId
             AND m."isDeleted" = false`,
          { replacements: { userId, batchId: row.batchId }, type: sequelize.QueryTypes.SELECT }
        );
        return {
          ...row,
          recipients: recipients || [],
          recipientIds: (recipients || []).map(r => r.userId),
        };
      } catch (_) {
        return { ...row, recipients: [], recipientIds: [] };
      }
    }));

    res.json({ success: true, data: history });
  } catch (error) {
    console.error('Error fetching bulk history:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));

// ============================================================================
// GET /api/messages/bulk/history/:batchId — Get detail for one multi-send batch
// ============================================================================
router.get('/bulk/history/:batchId', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;
    const { batchId } = req.params;
    if (!batchId) return res.status(400).json({ success: false, message: 'batchId required' });

    const sequelize = req.app.locals.db;

    const rows = await sequelize.query(
      `SELECT m.id, m."chatId", m.content, m."createdAt", m."deliveredAt", m."isRead", m."readAt",
              metadata->>'replyVisibility' AS "replyVisibility",
              cp."userId", u.username, u.avatar
       FROM "Messages" m
       JOIN chat_participants cp ON cp."chatId" = m."chatId"
       JOIN "Users" u ON u.id = cp."userId"
       WHERE m."senderId" = :userId
         AND m.metadata->>'batchId' = :batchId
         AND cp."userId" != :userId
         AND m."isDeleted" = false
       ORDER BY m."createdAt" ASC`,
      { replacements: { userId, batchId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    const detail = {
      batchId,
      content: rows[0].content,
      replyVisibility: rows[0].replyVisibility || 'public',
      createdAt: rows[0].createdAt,
      recipients: rows.map(r => ({
        userId: r.userId,
        username: r.username,
        displayName: r.username,
        avatar: r.avatar,
        chatId: r.chatId,
        deliveredAt: r.deliveredAt,
        readAt: r.readAt,
      })),
      deliveryCount: rows.length,
      seenCount: rows.filter(r => r.isRead).length,
    };

    res.json({ success: true, data: detail });
  } catch (error) {
    console.error('Error fetching bulk history detail:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));


// ============================================================================
// PATCH /api/messages/:messageId - Edit a message
// PUT alias: frontend (messages-core.js editMessage) calls PUT, not PATCH
// ============================================================================
const _editMessageHandler = asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    const { content } = req.body;
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Message content is required' });
    }
    // FIX-AUDIT: server-side HTML strip on edit, same as create paths
    const safeContent = stripHtmlTags(content).trim();

    const sequelize = req.app.locals.db;

    const msgRows = await sequelize.query(
      `SELECT id, "chatId", "senderId", "createdAt" FROM "Messages"
       WHERE id = :messageId AND "senderId" = :userId AND "isDeleted" = false LIMIT 1`,
      { replacements: { messageId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found or not authorized to edit' });
    }

    const editWindow = 15 * 60 * 1000;
    if (Date.now() - new Date(msgRows[0].createdAt).getTime() > editWindow) {
      return res.status(400).json({ success: false, message: 'Message can only be edited within 15 minutes' });
    }

    await sequelize.query(
      `UPDATE "Messages" SET content = :content, "isEdited" = true, "editedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = :messageId`,
      { replacements: { content: safeContent, messageId } }
    );

    // Broadcast edit to all chat participants
    try {
      const wsService = require('../services/webSocketService');
      wsService.broadcastToChat(msgRows[0].chatId, 'message:edited', {
        messageId,
        chatId: msgRows[0].chatId,
        content: safeContent,
        editedAt: new Date().toISOString(),
        editedBy: req.user.id
      });
    } catch (notifyError) {
      console.warn('Failed to emit message:edited websocket event:', notifyError.message);
    }

    res.status(200).json({
      status: 'success',
      message: 'Message updated successfully',
      data: { messageId, content: safeContent, editedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error('Error editing message:', error);
    res.status(500).json({ status: 'error', message: 'Failed to edit message' });
  }
});
router.patch('/:messageId', apiRateLimiter, _editMessageHandler);
router.put('/:messageId',   apiRateLimiter, _editMessageHandler); // PUT alias for frontend

// ============================================================================
// DELETE /api/messages/:messageId - Delete a message
// ============================================================================
router.delete('/:messageId', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    // Support both body and query string params
    const rawForEveryone = req.body?.deleteForEveryone ?? req.body?.forEveryone
      ?? req.query.deleteForEveryone ?? req.query.forEveryone ?? false;
    const deleteForEveryone = rawForEveryone === true || rawForEveryone === 'true';
    const userId = req.user.id;
    const sequelize = req.app.locals.db;

    const msgRows = await sequelize.query(
      `SELECT id, "chatId", "senderId", metadata FROM "Messages"
       WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
      { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    const msg = msgRows[0];

    // Verify the requesting user is a participant in this chat
    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId: msg.chatId, userId }, type: sequelize.QueryTypes.SELECT }
    );
    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (deleteForEveryone) {
      // Only message owner or chat admin can delete for everyone
      const chatRows = await sequelize.query(
        `SELECT "createdBy" FROM chats WHERE id = :chatId LIMIT 1`,
        { replacements: { chatId: msg.chatId }, type: sequelize.QueryTypes.SELECT }
      );
      const isAdmin = chatRows[0]?.createdBy === userId;
      const isOwner = msg.senderId === userId;
      if (!isAdmin && !isOwner) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete for everyone' });
      }

      // Hard delete for everyone — mark isDeleted on the message
      await sequelize.query(
        `UPDATE "Messages" SET "isDeleted" = true, "deletedAt" = NOW(), "deletedBy" = :userId, "updatedAt" = NOW()
         WHERE id = :messageId`,
        { replacements: { userId, messageId } }
      );
    } else {
      // DELETE FOR ME ONLY — store userId in metadata.deletedFor array
      // This prevents the message appearing for this user without removing it for others
      let metadata = {};
      try { metadata = (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) || {}; } catch (_) {}
      const deletedFor = Array.isArray(metadata.deletedFor) ? metadata.deletedFor : [];
      if (!deletedFor.includes(userId)) deletedFor.push(userId);
      metadata.deletedFor = deletedFor;

      await sequelize.query(
        `UPDATE "Messages" SET metadata = :metadata, "updatedAt" = NOW()
         WHERE id = :messageId`,
        { replacements: { metadata: JSON.stringify(metadata), messageId } }
      );
    }

    // Broadcast deletion event so all connected clients update instantly
    try {
      const wsService = require('../services/webSocketService');
      const deletePayload = {
        messageId,
        chatId: msg.chatId,
        deletedBy: userId,
        deleteForEveryone,
        deletedFor: deleteForEveryone ? null : [userId],
        timestamp: new Date().toISOString()
      };

      // FIX-ROOT-CAUSE-DELETE-DUPLICATE: this used to broadcast the same
      // deletion 3 separate ways — 'message:deleted' to the chat room,
      // 'message_deleted' to the same chat room again (messages-core.js on
      // the frontend already treats these two names as synonyms, so this was
      // a pure duplicate), and then an unconditional sendToUser() to every
      // participant regardless of whether they were already covered by the
      // chat-room broadcast. Emit the single canonical event to the chat
      // room, then only fall back to sendToUser for participants whose
      // sockets weren't actually in that room.
      const io = wsService.getIO?.() || wsService.io;
      const alreadyCoveredSocketIds = new Set([
        ...(io?.sockets?.adapter?.rooms?.get(`chat:${msg.chatId}`) || []),
        ...(io?.sockets?.adapter?.rooms?.get(`chat_${msg.chatId}`) || [])
      ]);
      wsService.broadcastToChat(msg.chatId, 'message:deleted', deletePayload);

      const participants = await sequelize.query(
        `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
        { replacements: { chatId: msg.chatId }, type: sequelize.QueryTypes.SELECT }
      );
      const _missedParticipants = (participants || []).filter(p => {
        const userRoom = io?.sockets?.adapter?.rooms?.get(`user:${p.userId}`);
        if (!userRoom) return true; // no known socket at all — try sendToUser anyway
        return ![...userRoom].some(sid => alreadyCoveredSocketIds.has(sid));
      });
      await Promise.allSettled(
        _missedParticipants.map(p =>
          wsService.sendToUser(p.userId, 'message:deleted', deletePayload)
        )
      );
    } catch (notifyError) {
      console.warn('Failed to emit message:deleted websocket event:', notifyError.message);
    }

    res.status(200).json({ success: true, message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ success: false, message: 'Failed to delete message' });
  }
}));

// ============================================================================
// POST /api/messages/:messageId/react - Add or remove a reaction
// ============================================================================
// ============================================================================
// NEW FEATURE: View Once media
// POST /api/messages/:messageId/view-once/view — mark a view-once message as
// viewed (consuming it) and delete the underlying media file from storage.
// ============================================================================
router.post('/:messageId/view-once/view', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    const sequelize = req.app.locals.db;
    const userId = req.user.id;

    const msgRows = await sequelize.query(
      `SELECT id, "chatId", "senderId", type, metadata, "viewOnceViewedAt", "viewOnceViewedBy"
       FROM "Messages" WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
      { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
    );
    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    const msg = msgRows[0];

    if (msg.type !== 'view_once') {
      return res.status(400).json({ success: false, message: 'This message is not a view-once message' });
    }

    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId: msg.chatId, userId }, type: sequelize.QueryTypes.SELECT }
    );
    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Senders never "view" their own view-once message through this endpoint —
    // they already have it; this prevents the sender accidentally consuming
    // their own send by previewing their own chat history.
    if (msg.senderId === userId) {
      return res.status(400).json({ success: false, message: 'Senders cannot consume their own view-once message' });
    }

    // Already viewed by someone (first-viewer-wins, matches WhatsApp group
    // behavior where the first person to open it uses up the single view).
    if (msg.viewOnceViewedAt) {
      return res.status(410).json({
        success: false,
        message: 'This media has already been viewed and is no longer available',
        data: { viewedAt: msg.viewOnceViewedAt, viewedBy: msg.viewOnceViewedBy },
      });
    }

    const mediaUrl = msg.metadata?.mediaUrl || null;
    const mediaType = msg.metadata?.viewOnceMediaType || 'image';

    // Mark as viewed FIRST (atomically, with a WHERE guard on viewOnceViewedAt
    // IS NULL) so two simultaneous view requests from a race can't both
    // "win" — only one UPDATE will actually affect a row.
    const [, updateMeta] = await sequelize.query(
      `UPDATE "Messages" SET "viewOnceViewedAt" = NOW(), "viewOnceViewedBy" = :userId, "updatedAt" = NOW()
       WHERE id = :messageId AND "viewOnceViewedAt" IS NULL`,
      { replacements: { messageId, userId }, type: sequelize.QueryTypes.UPDATE }
    );
    const rowsAffected = updateMeta?.rowCount ?? updateMeta;
    if (!rowsAffected) {
      // Someone else won the race between our SELECT and this UPDATE.
      return res.status(410).json({ success: false, message: 'This media has already been viewed and is no longer available' });
    }

    // Delete the underlying media file from storage — once viewed, the file
    // itself must not remain retrievable even via a direct/cached URL.
    if (mediaUrl) {
      try {
        if (_storageBackend === 's3') {
          const s3Key = mediaUrl.split('.amazonaws.com/')[1] || mediaUrl.split('/').slice(-2).join('/');
          if (s3Key && _s3Client) {
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            await _s3Client.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: s3Key }));
          }
        } else {
          const localPath = path.join(__dirname, '..', '..', 'uploads', mediaUrl.split('/uploads/')[1] || '');
          if (mediaUrl.includes('/uploads/')) await fsSync.promises.unlink(localPath).catch(() => {});
        }
      } catch (deleteErr) {
        console.warn('[messages.js] view-once media delete failed (non-fatal):', deleteErr.message);
      }
    }

    // Strip mediaUrl from metadata now that the file is gone, so even a
    // direct re-read of this row never exposes a dead/stale URL.
    await sequelize.query(
      `UPDATE "Messages" SET metadata = metadata - 'mediaUrl' WHERE id = :messageId`,
      { replacements: { messageId } }
    ).catch(() => {});

    const viewedAt = new Date().toISOString();

    // Broadcast live so the sender's open chat window shows "viewed" status
    // immediately, and any other open client stops offering the media.
    try {
      const wsService = require('../services/webSocketService');
      wsService.broadcastToChat(msg.chatId, 'message:view-once-viewed', {
        messageId, chatId: msg.chatId, viewedBy: userId, viewedAt,
      }, []);
    } catch (_) { /* non-fatal */ }

    res.json({
      success: true,
      message: 'Media unlocked',
      data: { messageId, mediaUrl, mediaType, viewedAt, viewedBy: userId },
    });
  } catch (error) {
    console.error('[messages.js] view-once view error:', error);
    res.status(500).json({ success: false, message: 'Failed to view media' });
  }
}));

router.post('/:messageId/react', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    const { emoji } = req.body;
    if (!emoji || emoji.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Emoji is required' });
    }

    const sequelize = req.app.locals.db;

    const msgRows = await sequelize.query(
      `SELECT id, "chatId", reactions FROM "Messages" WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
      { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    const msg = msgRows[0];

    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId: msg.chatId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const reactions = msg.reactions || {};
    const emojiKey = emoji.trim().substring(0, 10);

    if (!reactions[emojiKey]) reactions[emojiKey] = [];

    const userIdx = reactions[emojiKey].indexOf(req.user.id);
    let action;
    if (userIdx > -1) {
      reactions[emojiKey].splice(userIdx, 1);
      if (reactions[emojiKey].length === 0) delete reactions[emojiKey];
      action = 'removed';
    } else {
      reactions[emojiKey].push(req.user.id);
      action = 'added';
    }

    await sequelize.query(
      `UPDATE "Messages" SET reactions = :reactions::jsonb, "updatedAt" = NOW() WHERE id = :messageId`,
      { replacements: { reactions: JSON.stringify(reactions), messageId } }
    );

    // Broadcast reaction update to all chat participants
    try {
      const wsService = require('../services/webSocketService');
      wsService.broadcastToChat(msg.chatId, 'message:reaction', {
        messageId,
        chatId: msg.chatId,
        reactions,
        action,
        emoji: emojiKey,
        userId: req.user.id,
        timestamp: new Date().toISOString()
      });
    } catch (notifyError) {
      console.warn('Failed to emit message:reaction websocket event:', notifyError.message);
    }

    res.status(200).json({
      status: 'success',
      message: action === 'removed' ? 'Reaction removed' : 'Reaction added',
      data: { reactions, action },
    });
  } catch (error) {
    console.error('Error reacting to message:', error);
    res.status(500).json({ status: 'error', message: 'Failed to react to message' });
  }
}));

// ============================================================================
// GET /api/messages/:messageId/status - Message delivery status
// ============================================================================
router.get('/:messageId/status', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    const sequelize = req.app.locals.db;

    const msgRows = await sequelize.query(
      `SELECT id, "chatId", "senderId", "sentAt", "deliveredAt", "createdAt" FROM "Messages"
       WHERE id = :messageId AND "senderId" = :userId LIMIT 1`,
      { replacements: { messageId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found or not authorized' });
    }

    res.status(200).json({
      status: 'success',
      data: { status: { sentAt: msgRows[0].sentAt, deliveredAt: msgRows[0].deliveredAt } },
    });
  } catch (error) {
    console.error('Error getting message status:', error);
    res.status(500).json({ status: 'error', message: 'Failed to get message status' });
  }
}));

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
const getMessageTypeFromMime = (mimeType) => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'document';
  return 'file';
};

// ============================================================================
// POST /api/messages/:messageId/forward - Forward a message to other chats
// ADDED: Was missing from original routes
// ============================================================================
router.post('/:messageId/forward', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    const { targetChatIds } = req.body;
    if (!Array.isArray(targetChatIds) || targetChatIds.length === 0) {
      return res.status(400).json({ success: false, message: 'targetChatIds array is required' });
    }

    const sequelize = req.app.locals.db;
    const senderId = req.user.id;

    // Fetch original message
    const msgRows = await sequelize.query(
      `SELECT id, "chatId", "senderId", content, type FROM "Messages"
       WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
      { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
    );
    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    const original = msgRows[0];

    const safeTargetIds = targetChatIds.map(safeInt).filter(Boolean);
    const forwarded = [];

    for (const targetChatId of safeTargetIds) {
      // Verify sender is participant in target chat
      const isParticipant = await sequelize.query(
        `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :senderId LIMIT 1`,
        { replacements: { chatId: targetChatId, senderId }, type: sequelize.QueryTypes.SELECT }
      );
      if (!isParticipant || isParticipant.length === 0) continue;

      const result = await sequelize.query(
        `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"isRead","isDeleted","isEdited","sentAt","deliveredAt","createdAt","updatedAt")
         VALUES (:chatId,:senderId,:content,:type,'{}',false,false,false,NOW(),NOW(),NOW(),NOW())
         RETURNING id,"chatId","senderId",content,type,"createdAt"`,
        {
          replacements: { chatId: targetChatId, senderId, content: original.content, type: original.type },
          type: sequelize.QueryTypes.INSERT
        }
      );
      const newMsg = result[0][0];
      await sequelize.query(
        `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
        { replacements: { messageId: newMsg.id, chatId: targetChatId } }
      );

      forwarded.push(newMsg);

      // Notify recipients via WebSocket
      try {
        const wsService = require('../services/webSocketService');
        const participants = await sequelize.query(
          `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
          { replacements: { chatId: targetChatId, senderId }, type: sequelize.QueryTypes.SELECT }
        );
        await Promise.allSettled(
          (participants || []).map(row => wsService.sendToUser(row.userId, 'message:new', { ...newMsg, forwarded: true }))
        );
      } catch (notifyError) {
        console.warn('Failed to emit forwarded message event:', notifyError.message);
      }
    }

    res.status(201).json({
      status: 'success',
      message: `Message forwarded to ${forwarded.length} chat(s)`,
      data: { forwarded, count: forwarded.length }
    });
  } catch (error) {
    console.error('Error forwarding message:', error);
    res.status(500).json({ status: 'error', message: 'Failed to forward message' });
  }
}));


// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2: Bulk delete  — DELETE /api/messages/bulk-delete
// MUST be before /:id param routes to avoid route collision
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/bulk-delete', apiRateLimiter, asyncHandler(async (req, res) => {
  const userId     = req.user.id;
  const messageIds = (req.body.messageIds || []).map(Number).filter(Boolean);
  if (!messageIds.length) return res.status(400).json({ success: false, message: 'messageIds required' });
  if (messageIds.length > 100) return res.status(400).json({ success: false, message: 'Max 100 per request' });
  const sequelize = getSequelize();
  await sequelize.query(
    `DELETE FROM "Messages" WHERE id = ANY(:ids) AND "senderId" = :userId`,
    { replacements: { ids: messageIds, userId }, type: sequelize.QueryTypes.DELETE }
  );
  res.json({ success: true, deleted: messageIds.length });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2: Message report  — POST /api/messages/:id/report
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/report', apiRateLimiter, asyncHandler(async (req, res) => {
  const messageId  = parseInt(req.params.id, 10);
  const reporterId = req.user.id;
  const { reason, details } = req.body;
  const VALID = ['spam','harassment','hate_speech','violence','sexual_content','misinformation','other'];
  const norm = (reason || '').toLowerCase().replace(/ /g,'_');
  if (!VALID.includes(norm)) return res.status(400).json({ success: false, message: 'Invalid reason', valid: VALID });
  const sequelize = getSequelize();
  const [msg] = await sequelize.query(
    `SELECT id,"chatId","senderId" FROM "Messages" WHERE id=:messageId LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
  if (String(msg.senderId) === String(reporterId))
    return res.status(400).json({ success: false, message: 'Cannot report your own message' });
  try {
    await sequelize.query(
      `INSERT INTO message_reports ("reporterId","messageId","chatId","reason","details","status","createdAt","updatedAt")
       VALUES (:r,:m,:c,:reason,:details,'pending',NOW(),NOW())
       ON CONFLICT ("reporterId","messageId") DO NOTHING`,
      { replacements: { r: reporterId, m: messageId, c: msg.chatId, reason: norm, details: (details||'').slice(0,500)||null } }
    );
    res.json({ success: true, message: 'Report submitted. Thank you.' });
  } catch(e) {
    if (e.message.includes('unique') || e.message.includes('duplicate'))
      return res.status(409).json({ success: false, message: 'Already reported' });
    throw e;
  }
}));

router.get('/:id/report', asyncHandler(async (req, res) => {
  const sequelize = getSequelize();
  const [row] = await sequelize.query(
    `SELECT id,reason,status FROM message_reports WHERE "reporterId"=:r AND "messageId"=:m LIMIT 1`,
    { replacements: { r: req.user.id, m: parseInt(req.params.id,10) }, type: sequelize.QueryTypes.SELECT }
  );
  res.json({ success: true, reported: !!row, data: row||null });
}));


// FIX-9: POST /api/messages/disappearing
router.post('/disappearing', apiRateLimiter, asyncHandler(async (req, res) => {
  const senderId = req.user?.id;
  if (!senderId) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  const { chatId, duration } = req.body;
  if (!chatId) return res.status(400).json({ status: 'error', message: 'chatId required' });
  const valid = [0, 3600, 86400, 604800, 7776000];
  const d = parseInt(duration, 10);
  if (!valid.includes(d)) return res.status(400).json({ status: 'error', message: 'Invalid duration' });
  const sequelize = require('../config/database');

  // FIX-IDOR-DISAPPEARING: this route previously updated ANY chat's
  // disappearing-message duration given nothing but a chatId in the body —
  // no check that the requesting user was even a participant of that chat.
  // Any authenticated user could silently change (and get notified of) the
  // disappearing-message setting for a chat they had no membership in at all.
  const membership = await sequelize.query(
    `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :senderId LIMIT 1`,
    { replacements: { chatId, senderId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!membership || membership.length === 0) {
    return res.status(403).json({ status: 'error', message: 'Access denied' });
  }

  try {
    await sequelize.query(
      `UPDATE chats SET "disappearingDuration"=:d,"updatedAt"=NOW() WHERE id=:chatId`,
      { replacements: { d, chatId } }
    );
  } catch(e) { console.warn('[disappearing] column missing:', e.message); }
  try {
    const ws = require('../services/webSocketService');
    const parts = await sequelize.query(`SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId"=:chatId`,
      { replacements:{chatId}, type: sequelize.QueryTypes.SELECT });
    await Promise.allSettled((parts||[]).map(r => ws.sendToUser(r.userId,'disappearing:updated',{chatId,duration:d})));
  } catch(e) {}
  res.json({ status:'success', data:{chatId, duration:d, enabled:d>0} });
}));

// PHASE 1: View-once media  — POST /api/messages/:id/view-once
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns the real media URL once, then marks the message as viewed so
// subsequent calls return 410 Gone. The media URL is stored in metadata.
// Actual file deletion from storage is left to a scheduled cleanup job
// (Render free-tier: just set metadata.viewOnceOpened=true and clear the URL
//  from the Attachment record after the response).
//
router.post('/:id/view-once', apiRateLimiter, asyncHandler(async (req, res) => {
  const messageId  = parseInt(req.params.id, 10);
  const viewerId   = req.user.id;
  const sequelize  = getSequelize();

  // 1. Load message + validate recipient
  const [rows] = await sequelize.query(
    `SELECT m.id, m.metadata, m."chatId", m."senderId",
            a.url AS "attachmentUrl", a.type AS "attachmentType", a.id AS "attachmentId"
     FROM "Messages" m
     LEFT JOIN "Attachments" a ON a."messageId" = m.id
     WHERE m.id = :messageId
     LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows) return res.status(404).json({ success: false, message: 'Message not found' });

  const meta = (typeof rows.metadata === 'string') ? JSON.parse(rows.metadata || '{}') : (rows.metadata || {});

  // Must be a view-once message
  if (!meta.viewOnce) return res.status(400).json({ success: false, message: 'Not a view-once message' });

  // Already viewed
  if (meta.viewOnceOpened) return res.status(410).json({ success: false, message: 'Already opened' });

  // Must be the recipient (not the sender)
  if (String(rows.senderId) === String(viewerId)) {
    return res.status(403).json({ success: false, message: 'Senders cannot open their own view-once media' });
  }

  // Verify viewer is a participant of this chat
  const [participant] = await sequelize.query(
    `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :viewerId LIMIT 1`,
    { replacements: { chatId: rows.chatId, viewerId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!participant) return res.status(403).json({ success: false, message: 'Not a participant' });

  // 2. Mark as opened
  const updatedMeta = { ...meta, viewOnceOpened: true, viewOnceOpenedAt: new Date().toISOString(), viewOnceOpenedBy: viewerId };
  await sequelize.query(
    `UPDATE "Messages" SET metadata = :meta WHERE id = :messageId`,
    { replacements: { meta: JSON.stringify(updatedMeta), messageId } }
  );

  // 3. Emit socket event so sender sees "Opened"
  try {
    const wsService = req.app.locals.wsService || global.__wsService;
    if (wsService?.sendToUser) {
      await wsService.sendToUser(rows.senderId, 'message:viewOnceOpened', {
        messageId,
        chatId: rows.chatId,
        openedBy: viewerId,
      });
    }
  } catch (_) {}

  // 4. Return URL (one time only)
  const mediaUrl  = rows.attachmentUrl || meta.mediaUrl || null;
  const mediaType = rows.attachmentType || meta.viewOnceType || 'image';

  res.json({ success: true, url: mediaUrl, mediaType });

  // 5. Schedule URL clearance (fire-and-forget after response sent)
  setImmediate(async () => {
    try {
      if (rows.attachmentId) {
        await sequelize.query(
          `UPDATE "Attachments" SET url = '[view-once-opened]' WHERE id = :id`,
          { replacements: { id: rows.attachmentId } }
        );
      }
    } catch (_) {}
  });
}));

// ─────────────────────────────────────────────────────────────────────────────

// PHASE 1: Poll votes in DMs  — POST /api/messages/:id/poll/vote
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/poll/vote', apiRateLimiter, asyncHandler(async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  const voterId   = req.user.id;
  const optionId  = parseInt(req.body.optionId, 10);
  const sequelize = getSequelize();

  if (isNaN(optionId)) return res.status(400).json({ success: false, message: 'optionId required' });

  const [row] = await sequelize.query(
    `SELECT id, metadata, "chatId", "senderId" FROM "Messages" WHERE id = :messageId LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!row) return res.status(404).json({ success: false, message: 'Message not found' });

  const meta = (typeof row.metadata === 'string') ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
  const poll = meta.poll;
  if (!poll) return res.status(400).json({ success: false, message: 'Not a poll message' });
  if (poll.closed) return res.status(400).json({ success: false, message: 'Poll is closed' });

  const option = poll.options?.find(o => o.id === optionId);
  if (!option) return res.status(400).json({ success: false, message: 'Invalid option' });

  // Remove existing vote from all options (one vote per person)
  poll.options = poll.options.map(o => ({
    ...o,
    votes: (o.votes || []).filter(v => String(v) !== String(voterId))
  }));

  // Add new vote
  option.votes = [...(option.votes || []), String(voterId)];
  poll.totalVotes = poll.options.reduce((s, o) => s + (o.votes?.length || 0), 0);

  const updatedMeta = { ...meta, poll };
  await sequelize.query(
    `UPDATE "Messages" SET metadata = :meta WHERE id = :messageId`,
    { replacements: { meta: JSON.stringify(updatedMeta), messageId } }
  );

  // Broadcast to all chat participants
  try {
    const [participants] = await sequelize.query(
      `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
      { replacements: { chatId: row.chatId } }
    );
    const wsService = req.app.locals.wsService || global.__wsService;
    if (wsService?.sendToUser) {
      await Promise.allSettled(
        participants.map(p => wsService.sendToUser(p.userId, 'poll:vote', { messageId, poll }))
      );
    }
  } catch (_) {}

  res.json({ success: true, poll });
}));

module.exports = router;