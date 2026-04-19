const path = require('path');
const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const multer = require('multer');
const fs = require('fs').promises;
const {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// All routes are protected by parent auth middleware in index.js

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024;
const ALLOWED_FILE_TYPES = (
  process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/gif,application/pdf,text/plain'
).split(',');
const UPLOAD_PATH = process.env.UPLOAD_PATH || 'uploads/messages';

const ensureUploadDir = async () => {
  try {
    await fs.mkdir(UPLOAD_PATH, { recursive: true });
  } catch (error) {
    console.error('Failed to create upload directory:', error);
  }
};
ensureUploadDir();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_PATH),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

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
        (senders || []).map((row) => wsService.sendToUser(row.senderId, 'message:read', {
          chatId: safeChatId,
          messageIds: safeIds,
          readBy: userId,
          readAt: new Date().toISOString()
        }))
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
              m."replyToId",
              jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) as sender
       FROM "Messages" m
       LEFT JOIN "Users" u ON u.id = m."senderId"
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
      success: true,
      data: {
        messages: messages.reverse().map(m => ({
          ...m,
          // FIX: expose both "type" and "messageType" so any client field lookup works
          type: m.messageType || m.type || 'text',
          messageType: m.messageType || m.type || 'text',
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
    const { receiverId, content, type = 'text', chatId: existingChatId, replyToId } = req.body;
    const senderId = req.user.id;

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

    // Insert message fully parameterized
    const msgResult = await sequelize.query(
      `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"replyToId","sentAt","deliveredAt","createdAt","updatedAt")
       VALUES (:chatId,:senderId,:content,:type,'{}',:replyToId,NOW(),NOW(),NOW(),NOW())
       RETURNING id,"chatId","senderId",content,type,"replyToId","createdAt"`,
      {
        replacements: { 
          chatId, 
          senderId, 
          content: content.trim(), 
          type: messageType,
          replyToId: safeReplyToId
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );

    const messageId = msgResult[0][0].id;

    const senderRows = await sequelize.query(
      `SELECT id, username, avatar FROM "Users" WHERE id = :senderId`,
      { replacements: { senderId }, type: sequelize.QueryTypes.SELECT }
    );

    await sequelize.query(
      `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
      { replacements: { messageId, chatId } }
    );

    const populatedMessage = {
      id: messageId,
      chatId,
      senderId,
      content: content.trim(),
      type: messageType,
      reactions: {},
      replyToId: safeReplyToId,
      sentAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sender: senderRows[0] || null,
    };

    try {
      const wsService = require('../services/webSocketService');
      const participants = await sequelize.query(
        `SELECT DISTINCT "userId" FROM chat_participants
         WHERE "chatId" = :chatId
           AND "userId" != :senderId`,
        {
          replacements: { chatId, senderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      const recipientIds = (participants || []).map((row) => parseInt(row.userId, 10)).filter(Boolean);
      const deliveryResults = await Promise.allSettled(
        recipientIds.map(async (recipientId) => {
          const online = await wsService.isUserOnline(recipientId);
          await wsService.sendToUser(recipientId, 'message:new', populatedMessage);
          return online ? recipientId : null;
        })
      );

      const deliveredTo = deliveryResults
        .filter((result) => result.status === 'fulfilled' && result.value)
        .map((result) => result.value);

      if (deliveredTo.length > 0) {
        await wsService.sendToUser(senderId, 'message:delivered', {
          messageId,
          chatId,
          deliveredTo,
          deliveredAt: new Date().toISOString()
        });
      }
    } catch (notifyError) {
      console.warn('Failed to emit message:new websocket event:', notifyError.message);
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
              jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) as sender
       FROM "Messages" m
       LEFT JOIN "Users" u ON u.id = m."senderId"
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
    await sequelize.query(
      `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
      { replacements: { messageId, chatId } }
    );

    res.status(201).json({
      status: 'success',
      message: 'File uploaded successfully',
      data: {
        message: { id: messageId, chatId, senderId: req.user.id, content: caption, type: msgType },
        fileUrl: `/api/messages/${chatId}/files/${messageId}/${req.file.filename}`,
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
// PATCH /api/messages/:messageId - Edit a message
// ============================================================================
router.patch('/:messageId', apiRateLimiter, asyncHandler(async (req, res) => {
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
}));

// ============================================================================
// DELETE /api/messages/:messageId - Delete a message
// ============================================================================
router.delete('/:messageId', apiRateLimiter, asyncHandler(async (req, res) => {
  try {
    const messageId = safeInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

    const { deleteForEveryone = 'false' } = req.query;
    const sequelize = req.app.locals.db;

    const msgRows = await sequelize.query(
      `SELECT id, "chatId", "senderId" FROM "Messages" WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
      { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!msgRows || msgRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    const msg = msgRows[0];

    if (deleteForEveryone === 'true') {
      const chatRows = await sequelize.query(
        `SELECT "createdBy" FROM chats WHERE id = :chatId LIMIT 1`,
        { replacements: { chatId: msg.chatId }, type: sequelize.QueryTypes.SELECT }
      );
      const isAdmin = chatRows[0]?.createdBy === req.user.id;
      const isOwner = msg.senderId === req.user.id;
      if (!isAdmin && !isOwner) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete for everyone' });
      }
    } else {
      if (msg.senderId !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete this message' });
      }
    }

    await sequelize.query(
      `UPDATE "Messages" SET "isDeleted" = true, "deletedAt" = NOW(), "deletedBy" = :userId, "updatedAt" = NOW()
       WHERE id = :messageId`,
      { replacements: { userId: req.user.id, messageId } }
    );

    // Broadcast deletion to all chat participants
    try {
      const wsService = require('../services/webSocketService');
      wsService.broadcastToChat(msg.chatId, 'message:deleted', {
        messageId,
        chatId: msg.chatId,
        deletedBy: req.user.id,
        deleteForEveryone: deleteForEveryone === 'true',
        timestamp: new Date().toISOString()
      });
    } catch (notifyError) {
      console.warn('Failed to emit message:deleted websocket event:', notifyError.message);
    }

    res.status(200).json({ status: 'success', message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete message' });
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