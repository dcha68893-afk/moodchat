const path = require('path');
const asyncHandler = require('express-async-handler');
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
const { apiRateLimiter } = require('../middleware/rateLimiter');

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
    storage = multerS3({
      s3: s3Client,
      bucket: process.env.AWS_S3_BUCKET,
      acl: 'public-read',
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `messages/${uniqueSuffix}${path.extname(file.originalname)}`);
      },
    });
    _storageBackend = 's3';
    console.log('✅ Media storage: AWS S3 (persistent CDN)');
  } else {
    throw new Error('S3 not configured');
  }
} catch (_) {
  // Fall back to disk
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
    console.warn('⚠️  Media storage: local disk (ephemeral on Render). Set AWS_S3_BUCKET for persistent storage.');
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

function _validateMagicBytes(filePath, declaredMime) {
  try {
    const sigs = MAGIC_SIGNATURES[declaredMime];
    if (!sigs) return false; // mime not in our allow-list at all
    if (sigs[0] === null) return true; // skip deep check for this type
    const fd  = fsSync.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fsSync.readSync(fd, buf, 0, 12, 0);
    fsSync.closeSync(fd);
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

const ALLOWED_MSG_TYPES = ['text', 'image', 'file', 'audio', 'video', 'document'];

console.log('✅ Messages routes initialized');

// ============================================================================
// GET /api/messages/unread-counts - Get unread counts for all user's chats
// ============================================================================
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

    // Build values for bulk insert
    const values = safeIds.map(id => `(${id}, ${userId}, NOW(), NOW())`).join(',');
    
    // Insert read receipts with ON CONFLICT DO NOTHING to avoid duplicates
    await sequelize.query(
      `INSERT INTO "ReadReceipts" ("messageId", "userId", "readAt", "createdAt")
       VALUES ${values}
       ON CONFLICT ("messageId", "userId") DO NOTHING`,
      { type: sequelize.QueryTypes.INSERT }
    );

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
              m."replyToId", m.metadata,
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
       ORDER BY m."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`,
      { replacements: { ...replacements, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
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
        messages: messages.reverse().map(m => ({
          ...m,
          // FIX: expose both "type" and "messageType" so any client field lookup works
          type: m.messageType || m.type || 'text',
          messageType: m.messageType || m.type || 'text',
          // FIX: expose mediaUrl from metadata so media messages render correctly
          mediaUrl: m.metadata?.mediaUrl || m.mediaUrl || null,
          fileUrl:  m.metadata?.mediaUrl || m.fileUrl  || null,
        })),
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
router.post('/', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const { receiverId, content, type = 'text', chatId: existingChatId, replyToId, localId: clientLocalId, linkPreview } = req.body;
    const senderId = req.user.id;

    // ── FORENSIC LOG: SEND_START ──────────────────────────────────────────────
    console.log(`[FORENSIC] SEND_START | senderId=${senderId} | chatId=${existingChatId||'?'} | receiverId=${receiverId||'?'} | localId=${clientLocalId||'?'} | contentLen=${(content||'').length} | ts=${Date.now()}`);

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

    // Find or create direct chat when no chatId given
    if (!chatId && receiverId) {
      const safeReceiverId = safeInt(receiverId);
      if (!safeReceiverId) {
        return res.status(400).json({ success: false, message: 'Invalid receiverId' });
      }
      if (safeReceiverId === senderId) {
        return res.status(400).json({ success: false, message: 'Cannot message yourself' });
      }

      // Check if user exists
      const receiverExists = await sequelize.query(
        `SELECT id FROM "Users" WHERE id = :receiverId LIMIT 1`,
        { replacements: { receiverId: safeReceiverId }, type: sequelize.QueryTypes.SELECT }
      );
      
      if (!receiverExists || receiverExists.length === 0) {
        return res.status(404).json({ success: false, message: 'Receiver not found' });
      }

      const existing = await sequelize.query(
        `SELECT c.id FROM chats c
         JOIN chat_participants cp1 ON cp1."chatId" = c.id AND cp1."userId" = :senderId
         JOIN chat_participants cp2 ON cp2."chatId" = c.id AND cp2."userId" = :receiverId
         WHERE c.type = 'direct' LIMIT 1`,
        { replacements: { senderId, receiverId: safeReceiverId }, type: sequelize.QueryTypes.SELECT }
      );

      if (existing && existing.length > 0) {
        chatId = existing[0].id;
      } else {
        const newChat = await sequelize.query(
          `INSERT INTO chats (type, "createdBy", "createdAt", "updatedAt")
           VALUES ('direct', :senderId, NOW(), NOW()) RETURNING id`,
          { replacements: { senderId }, type: sequelize.QueryTypes.INSERT }
        );
        chatId = newChat[0][0].id;

        await sequelize.query(
          `INSERT INTO chat_participants ("chatId", "userId", "joinedAt", "createdAt", "updatedAt")
           VALUES (:chatId, :senderId, NOW(), NOW(), NOW()),
                  (:chatId, :receiverId, NOW(), NOW(), NOW())`,
          { replacements: { chatId, senderId, receiverId: safeReceiverId } }
        );
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
    console.log(`[FORENSIC] BACKEND_RECEIVED | senderId=${senderId} | chatId=${chatId} | localId=${clientLocalId||'?'} | ts=${Date.now()}`);

    // ── IDEMPOTENCY: If a localId was provided, check if this message was already saved.
    // Prevents duplicate inserts when the client retries a failed/timed-out request.
    // FIX-PHASE16: This is the correct place to check — after participant validation,
    // before the transaction, so we can return early with the existing message.
    if (clientLocalId) {
      try {
        const existing = await sequelize.query(
          `SELECT id, \"chatId\", \"senderId\", content, type, \"createdAt\" FROM \"Messages\"
           WHERE \"senderId\" = :senderId AND \"chatId\" = :chatId
             AND content = :content
             AND \"createdAt\" > NOW() - INTERVAL '5 minutes'
           ORDER BY \"createdAt\" DESC LIMIT 1`,
          { replacements: { senderId, chatId, content: content.trim() }, type: sequelize.QueryTypes.SELECT }
        );
        if (existing && existing.length > 0) {
          const dup = existing[0];
          console.log(`[messages.js] 🔁 Idempotency hit — returning existing message id=${dup.id} for localId=${clientLocalId}`);
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
    
    // Build initial metadata including linkPreview + disappearing timer from chat settings
    const msgMetadata = {};
    if (linkPreview && typeof linkPreview === 'object' && linkPreview.title) {
      msgMetadata.linkPreview = {
        title:       linkPreview.title,
        description: linkPreview.description || null,
        imageUrl:    linkPreview.imageUrl     || null,
        siteName:    linkPreview.siteName     || null,
        url:         linkPreview.url          || null,
      };
    }
    
    try {
      const msgResult = await sequelize.query(
        `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"replyToId",metadata,"sentAt","deliveredAt","createdAt","updatedAt")
         VALUES (:chatId,:senderId,:content,:type,'{}',:replyToId,:metadata,NOW(),NOW(),NOW(),NOW())
         RETURNING id,"chatId","senderId",content,type,"replyToId","createdAt"`,
        {
          replacements: { chatId, senderId, content: content.trim(), type: messageType, replyToId: safeReplyToId, metadata: JSON.stringify(msgMetadata) },
          type: sequelize.QueryTypes.INSERT,
          transaction: t,
        }
      );
      messageId = msgResult[0][0].id;

      await sequelize.query(
        `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
        { replacements: { messageId, chatId }, transaction: t }
      );

      await t.commit();

      // ── FORENSIC LOG: DB_SAVED ──────────────────────────────────────────────
      console.log(`[FORENSIC] DB_SAVED | messageId=${messageId} | chatId=${chatId} | senderId=${senderId} | ts=${Date.now()}`);

      senderRows = await sequelize.query(
        `SELECT id, username, avatar FROM "Users" WHERE id = :senderId`,
        { replacements: { senderId }, type: sequelize.QueryTypes.SELECT }
      );
    } catch (txErr) {
      await t.rollback();
      throw txErr;
    }

    // ✅ FIX: Fetch replyTo content so receiver gets preview immediately
    let replyToData = null;
    if (safeReplyToId) {
      try {
        const replyRows = await sequelize.query(
          `SELECT m.id, m.content, m.type, m."senderId", u.username as "senderName"
           FROM "Messages" m
           LEFT JOIN "Users" u ON u.id = m."senderId"
           WHERE m.id = :replyToId AND m."isDeleted" = false LIMIT 1`,
          { replacements: { replyToId: safeReplyToId }, type: sequelize.QueryTypes.SELECT }
        );
        if (replyRows && replyRows.length > 0) replyToData = replyRows[0];
      } catch(_) {}
    }

    const populatedMessage = {
      id: messageId,
      localId: clientLocalId || null,
      chatId,
      senderId,
      content: content.trim(),
      type: messageType,
      reactions: {},
      replyToId: safeReplyToId,
      replyTo: replyToData,
      sentAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sender: senderRows[0] || null,
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
        console.log(`[FORENSIC] TRANSPORT_SELECTED | messageId=${messageId} | transport=${_htrAvail?'HTR+SocketIO':'SocketIO'} | recipients=${recipientIds.join(',')} | ts=${Date.now()}`);

        // Emit message:new to RECIPIENTS ONLY (not sender) — sender already has optimistic message
        // FIX: Sending message:new to the sender caused double-render and dedup collisions.
        // sendToUser() already emits to all room name variants (user:X, user_X, user:Xstr, user_Xstr)
        // FIX-010: Single canonical 'message:new' event per recipient
        const deliveryResults = await Promise.allSettled(
          recipientIds.map(uid => wsService.sendToUser(uid, 'message:new', populatedMessage))
        );

        // ── FORENSIC LOG: BROADCASTED ─────────────────────────────────────────
        const _delivered = deliveryResults.filter(r => r.status === 'fulfilled' && r.value === true).length;
        const _failed    = deliveryResults.length - _delivered;
        console.log(`[FORENSIC] BROADCASTED | messageId=${messageId} | chatId=${chatId} | recipients=${recipientIds.join(',')} | delivered=${_delivered}/${deliveryResults.length} | failed=${_failed} | ts=${Date.now()}`);

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

        // FIX-AUDIT-2: Also emit group:message for group chats so group.html receives it
        if (_chatType === 'group') {
          try {
            const groupPayload = { ...populatedMessage, groupId: chatId, chatId };
            const _io = wsService.getIO?.() || wsService.io;
            if (_io) {
              _io.to(`group:${chatId}`).emit('group:message', groupPayload);
              _io.to(`group_${chatId}`).emit('group:message', groupPayload);
              _io.to(`chat:${chatId}`).emit('new_group_message', groupPayload);
            }
          } catch(_) {}
        }

        // Count successes for diagnostics (already logged in FORENSIC:BROADCASTED above)
        if (_failed > 0) {
          console.warn(`[messages.js] ⚠️ sendToUser: ${_delivered}/${deliveryResults.length} delivered, ${_failed} failed for chatId=${chatId}`);
        }

        // Also broadcast to the chat:<id> room — catches any socket that joined
        // via _joinUserChatRooms but isn't tracked in onlineUsers yet
        // FIX-010: Single event name for broadcastToChat
        // FIX: Use except(senderSocketId) pattern — sender should NOT receive message:new
        // via the room broadcast either (they have the optimistic message already).
        if (typeof wsService.broadcastToChat === 'function') {
          // broadcastToChat with recipientIds only (excludes senderId)
          wsService.broadcastToChat(chatId, 'message:new', populatedMessage, recipientIds);
        }

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

        // FIX-MSG-DELIVERY: schedule 10s delivery timeout per recipient
        for (const rid of recipientIds) {
          if (typeof wsService.scheduleMessageDeliveryTimeout === 'function') {
            wsService.scheduleMessageDeliveryTimeout(messageId, chatId, senderId);
          }
        }

        // Tell sender when at least one recipient was targeted
        // NOTE: message:delivered is now sent by the TWO-PHASE ACK system:
        //   receiver emits 'message:delivery_ack' → server emits 'message:delivered' to sender.
        // The old eager emit here is removed to prevent false "delivered" status.
        if (recipientIds.length > 0) {
          console.log(`[messages.js] 📨 Delivery tracking started for messageId=${messageId} recipients=${recipientIds.join(',')}`);
        }

        console.log(
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
              m."replyToId",
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
       ORDER BY m."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
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
        messages: messages.reverse(),
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
    if (!_validateMagicBytes(req.file.path, req.file.mimetype)) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ success: false, message: 'File content does not match declared type' });
    }

    const isParticipant = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId, userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );

    if (!isParticipant || isParticipant.length === 0) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ success: false, message: 'Chat not found or access denied' });
    }

    const caption = req.body.caption ? req.body.caption.substring(0, 500) : '';
    const msgType = getMessageTypeFromMime(req.file.mimetype);

    const msgResult = await sequelize.query(
      `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"sentAt","deliveredAt","createdAt","updatedAt")
       VALUES (:chatId,:senderId,:content,:type,'{}',NOW(),NOW(),NOW(),NOW())
       RETURNING id,"chatId","senderId",content,type,"createdAt"`,
      {
        replacements: { chatId, senderId: req.user.id, content: caption, type: msgType },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    const messageId = msgResult[0][0].id;

    // Build absolute URL — S3 returns req.file.location; disk uses relative path
    let absUrl;
    if (_storageBackend === 's3' && req.file && req.file.location) {
      absUrl = req.file.location;
    } else {
      const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
      const subDir  = msgType === 'image' ? 'images' : msgType === 'audio' ? 'audio' : msgType === 'video' ? 'video' : 'files';
      absUrl = `${baseUrl.replace(/\/+$/, '')}/uploads/${subDir}/${req.file.filename}`;
    }

    // Store mediaUrl in message metadata so GET messages can return it
    await sequelize.query(
      `UPDATE "Messages" SET metadata = jsonb_set(COALESCE(metadata,'{}'), '{mediaUrl}', :url::jsonb),
                             "lastMessageId" = id
       WHERE id = :messageId`,
      { replacements: { messageId, url: JSON.stringify(absUrl) } }
    ).catch(() => {});

    await sequelize.query(
      `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
      { replacements: { messageId, chatId } }
    );

    res.status(201).json({
      status: 'success',
      message: 'File uploaded successfully',
      data: {
        message: { id: messageId, chatId, senderId: req.user.id, content: caption, type: msgType, mediaUrl: absUrl },
        fileUrl: absUrl,
        url: absUrl,
        mediaUrl: absUrl,
      },
    });
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
       ORDER BY m."createdAt" DESC LIMIT ${limitNum} OFFSET ${offset}`,
      { replacements: { chatId, pattern: `%${searchQuery.trim()}%` }, type: sequelize.QueryTypes.SELECT }
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
router.post('/bulk', apiRateLimiter, asyncHandler(async (req, res) => {
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
          `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"sentAt","deliveredAt","createdAt","updatedAt",metadata)
           VALUES (:chatId,:senderId,:content,:type,'{}',NOW(),NOW(),NOW(),NOW(),:metadata)
           RETURNING id,"chatId","senderId",content,type,"createdAt"`,
          {
            replacements: {
              chatId, senderId, content: content.trim(), type: messageType,
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
          id: messageId, chatId, senderId, content: content.trim(), type: messageType,
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
            wsService.broadcastToChat(chatId, 'message:new', populatedMessage);
          }
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
      { replacements: { content: content.trim(), messageId } }
    );

    // Broadcast edit to all chat participants
    try {
      const wsService = require('../services/webSocketService');
      wsService.broadcastToChat(msgRows[0].chatId, 'message:edited', {
        messageId,
        chatId: msgRows[0].chatId,
        content: content.trim(),
        editedAt: new Date().toISOString(),
        editedBy: req.user.id
      });
    } catch (notifyError) {
      console.warn('Failed to emit message:edited websocket event:', notifyError.message);
    }

    res.status(200).json({
      status: 'success',
      message: 'Message updated successfully',
      data: { messageId, content: content.trim(), editedAt: new Date().toISOString() },
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
      wsService.broadcastToChat(msg.chatId, 'message:deleted', deletePayload);
      wsService.broadcastToChat(msg.chatId, 'message_deleted', deletePayload);
      // Also send direct to all participants via user rooms for reliability
      const participants = await sequelize.query(
        `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
        { replacements: { chatId: msg.chatId }, type: sequelize.QueryTypes.SELECT }
      );
      await Promise.allSettled(
        (participants || []).map(p =>
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
        `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"sentAt","deliveredAt","createdAt","updatedAt")
         VALUES (:chatId,:senderId,:content,:type,'{}',NOW(),NOW(),NOW(),NOW())
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

module.exports = router;