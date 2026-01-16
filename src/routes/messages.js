const express = require('express');
const router = express.Router();
const { Op, fn, col, literal } = require('sequelize');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter, createMessageRateLimiter } = require('../middleware/rateLimiter');
const { User, Chat, Message, Reaction } = require('../models');

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
  destination: (req, file, cb) => {
    cb(null, UPLOAD_PATH);
  },
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

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

router.use(authMiddleware);

console.log('✅ Messages routes initialized');

router.get(
  '/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;
      const {
        page = 1,
        limit = 50,
        before = null,
        after = null,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          isArchived: false
        },
        include: [{
          model: User,
          as: 'participants',
          where: { id: req.user.id },
          required: true
        }]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      const where = { chatId: chatId, isDeleted: false };

      if (before) {
        where.createdAt = { [Op.lt]: new Date(before) };
      }

      if (after) {
        where.createdAt = { [Op.gt]: new Date(after) };
      }

      const { count, rows: messages } = await Message.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar', 'displayName']
          },
          {
            model: Message,
            as: 'repliesTo',
            attributes: ['content', 'senderId', 'createdAt'],
            include: [{
              model: User,
              as: 'sender',
              attributes: ['id', 'username', 'avatar']
            }]
          },
          {
            model: User,
            as: 'readBy',
            attributes: ['id', 'username', 'avatar'],
            through: { attributes: ['readAt'] }
          },
          {
            model: Reaction,
            as: 'reactions',
            include: [{
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'avatar']
            }]
          }
        ],
        order: [['createdAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        distinct: true
      });

      const chronologicalMessages = messages.reverse();

      const unreadMessages = messages.filter(
        msg => !msg.readBy.some(reader => reader.id === req.user.id)
      );

      if (unreadMessages.length > 0) {
        const now = new Date();
        const messageIds = unreadMessages.map(msg => msg.id);
        
        for (const messageId of messageIds) {
          const message = await Message.findByPk(messageId);
          if (message) {
            const readBy = message.readBy || [];
            if (!readBy.includes(req.user.id)) {
              readBy.push(req.user.id);
              await message.update({ readBy });
            }
          }
        }

        if (chat.markAsRead) {
          await chat.markAsRead(req.user.id);
        }

        if (req.io && unreadMessages.length > 0) {
          const senderIds = [...new Set(unreadMessages.map(msg => msg.senderId))];

          senderIds.forEach(senderId => {
            if (senderId !== req.user.id) {
              const sender = unreadMessages.find(msg => msg.senderId === senderId)?.sender;
              if (sender) {
                req.io.to(`chat:${chatId}`).emit('messages:read', {
                  chatId,
                  readerId: req.user.id,
                  messageIds: unreadMessages
                    .filter(msg => msg.senderId === senderId)
                    .map(msg => msg.id),
                  readAt: now,
                });
              }
            }
          });
        }
      }

      res.status(200).json({
        status: 'success',
        data: {
          messages: chronologicalMessages,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
          chatInfo: {
            id: chat.id,
            chatType: chat.chatType,
            chatName: chat.chatName,
          },
        },
      });
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch messages'
      });
    }
  })
);

router.post(
  '/:chatId',
  createMessageRateLimiter(),
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;
      const { content, replyTo, messageType = 'text' } = req.body;

      if (messageType === 'text' && (!content || content.trim().length === 0)) {
        throw new ValidationError('Message content is required for text messages');
      }

      if (messageType === 'text' && content.length > 5000) {
        throw new ValidationError('Message too long (max 5000 characters)');
      }

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          isArchived: false
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar'],
          through: { attributes: [] }
        }]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found');
      }

      const isParticipant = chat.participants.some(p => p.id === req.user.id);
      if (!isParticipant) {
        throw new AuthorizationError('Access denied');
      }

      let replyToMessage = null;
      if (replyTo) {
        replyToMessage = await Message.findOne({
          where: {
            id: replyTo,
            chatId: chatId,
            isDeleted: false
          }
        });

        if (!replyToMessage) {
          throw new ValidationError('Message to reply to not found');
        }
      }

      const currentUser = await User.findByPk(req.user.id);

      const blockedParticipants = chat.participants.filter(participant => {
        if (currentUser.blockedUsers && currentUser.blockedUsers.some(bu => bu.id === participant.id)) {
          return true;
        }
        if (participant.blockedUsers && participant.blockedUsers.some(bu => bu.id === req.user.id)) {
          return true;
        }
        return false;
      });

      if (blockedParticipants.length > 0) {
        throw new AuthorizationError('Cannot send messages in chat with blocked users');
      }

      const message = await Message.create({
        chatId: chatId,
        senderId: req.user.id,
        content: content?.trim(),
        messageType,
        replyTo: replyToMessage?.id,
        attachments: [],
        readBy: [req.user.id]
      });

      const populatedMessage = await Message.findByPk(message.id, {
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar', 'displayName']
          },
          {
            model: Message,
            as: 'replyTo',
            attributes: ['content', 'senderId', 'createdAt'],
            include: [{
              model: User,
              as: 'sender',
              attributes: ['id', 'username', 'avatar']
            }]
          }
        ]
      });

      await chat.update({
        lastMessageId: message.id,
        updatedAt: new Date()
      });

      if (chat.incrementUnreadCounts) {
        await chat.incrementUnreadCounts(req.user.id);
      }

      const messageData = populatedMessage.toJSON();
      messageData.unreadCount = 1;

      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('message:new', {
          message: messageData,
          chat: {
            id: chat.id,
            chatType: chat.chatType,
            chatName: chat.chatName,
          },
          sender: {
            id: req.user.id,
            username: currentUser.username,
            avatar: currentUser.avatar,
          },
        });

        req.io.to(`user:${req.user.id}`).emit('message:sent', {
          message: messageData,
          chatId: chat.id,
        });
      }

      res.status(201).json({
        status: 'success',
        message: 'Message sent successfully',
        data: { message: populatedMessage },
      });
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to send message'
      });
    }
  })
);

router.post(
  '/:chatId/upload',
  apiRateLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;

      if (!req.file) {
        throw new ValidationError('No file uploaded');
      }

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          isArchived: false
        },
        include: [{
          model: User,
          as: 'participants',
          where: { id: req.user.id },
          required: true
        }]
      });

      if (!chat) {
        await fs.unlink(req.file.path).catch(() => {});
        throw new NotFoundError('Chat not found or access denied');
      }

      const message = await Message.create({
        chatId: chatId,
        senderId: req.user.id,
        messageType: getMessageTypeFromMime(req.file.mimetype),
        attachments: [
          {
            filename: req.file.originalname,
            path: req.file.path,
            mimetype: req.file.mimetype,
            size: req.file.size,
            thumbnail: await generateThumbnailIfImage(req.file),
          },
        ],
        content: req.body.caption || '',
        readBy: [req.user.id]
      });

      await chat.update({
        lastMessageId: message.id,
        updatedAt: new Date()
      });

      if (chat.incrementUnreadCounts) {
        await chat.incrementUnreadCounts(req.user.id);
      }

      const populatedMessage = await Message.findByPk(message.id, {
        include: [{
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar', 'displayName']
        }]
      });

      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('message:new', {
          message: populatedMessage.toJSON(),
          chat: {
            id: chat.id,
            chatType: chat.chatType,
            chatName: chat.chatName,
          },
        });
      }

      res.status(201).json({
        status: 'success',
        message: 'File uploaded successfully',
        data: {
          message: populatedMessage,
          fileUrl: `/api/messages/${chatId}/files/${message.id}/${req.file.filename}`,
        },
      });
    } catch (error) {
      console.error('Error uploading file:', error);
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      res.status(500).json({
        status: 'error',
        message: 'Failed to upload file'
      });
    }
  })
);

router.patch(
  '/:messageId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { messageId } = req.params;
      const { content } = req.body;

      if (!content || content.trim().length === 0) {
        throw new ValidationError('Message content is required');
      }

      const message = await Message.findOne({
        where: {
          id: messageId,
          senderId: req.user.id,
          isDeleted: false
        }
      });

      if (!message) {
        throw new NotFoundError('Message not found or not authorized to edit');
      }

      const editWindow = 15 * 60 * 1000;
      if (Date.now() - message.createdAt.getTime() > editWindow) {
        throw new ValidationError('Message can only be edited within 15 minutes of sending');
      }

      await message.update({
        content: content.trim(),
        isEdited: true,
        editedAt: new Date()
      });

      const updatedMessage = await Message.findByPk(messageId, {
        include: [{
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar', 'displayName']
        }]
      });

      if (req.io) {
        req.io.to(`chat:${message.chatId}`).emit('message:edited', {
          messageId: message.id,
          chatId: message.chatId,
          content: message.content,
          editedAt: message.editedAt,
          editedBy: {
            id: req.user.id,
            username: req.user.username,
          },
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Message updated successfully',
        data: { message: updatedMessage },
      });
    } catch (error) {
      console.error('Error editing message:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to edit message'
      });
    }
  })
);

router.delete(
  '/:messageId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { messageId } = req.params;
      const { deleteForEveryone = false } = req.query;

      const message = await Message.findOne({
        where: {
          id: messageId,
          isDeleted: false
        }
      });

      if (!message) {
        throw new NotFoundError('Message not found');
      }

      let canDeleteForEveryone = false;
      if (deleteForEveryone === 'true') {
        const chat = await Chat.findByPk(message.chatId, {
          include: [{
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          }]
        });
        
        if (!chat) {
          throw new NotFoundError('Chat not found');
        }
        
        canDeleteForEveryone = chat.admins.some(admin => admin.id === req.user.id) || 
                              message.senderId === req.user.id;
        
        if (!canDeleteForEveryone) {
          throw new AuthorizationError('Not authorized to delete message for everyone');
        }
      } else {
        if (message.senderId !== req.user.id) {
          throw new AuthorizationError('Not authorized to delete this message');
        }
      }

      await message.update({
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: req.user.id,
        deleteForEveryone: deleteForEveryone === 'true'
      });

      const chat = await Chat.findByPk(message.chatId);
      if (chat && chat.lastMessageId === messageId) {
        const previousMessage = await Message.findOne({
          where: {
            chatId: message.chatId,
            isDeleted: false,
            id: { [Op.ne]: messageId }
          },
          order: [['createdAt', 'DESC']]
        });

        await chat.update({ lastMessageId: previousMessage?.id || null });
      }

      if (req.io) {
        req.io.to(`chat:${message.chatId}`).emit('message:deleted', {
          messageId: message.id,
          chatId: message.chatId,
          deletedBy: {
            id: req.user.id,
            username: req.user.username,
          },
          deleteForEveryone: message.deleteForEveryone,
          deletedAt: message.deletedAt,
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Message deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting message:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to delete message'
      });
    }
  })
);

router.post(
  '/:messageId/react',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { messageId } = req.params;
      const { emoji } = req.body;

      if (!emoji || emoji.trim().length === 0) {
        throw new ValidationError('Emoji is required');
      }

      const message = await Message.findOne({
        where: {
          id: messageId,
          isDeleted: false
        }
      });

      if (!message) {
        throw new NotFoundError('Message not found');
      }

      const chat = await Chat.findOne({
        where: { id: message.chatId },
        include: [{
          model: User,
          as: 'participants',
          where: { id: req.user.id },
          required: true
        }]
      });

      if (!chat) {
        throw new AuthorizationError('Access denied');
      }

      const existingReaction = await Reaction.findOne({
        where: {
          messageId: messageId,
          userId: req.user.id,
          emoji: emoji
        }
      });

      if (existingReaction) {
        await existingReaction.destroy();
      } else {
        await Reaction.create({
          messageId: messageId,
          userId: req.user.id,
          emoji: emoji,
          reactedAt: new Date()
        });
      }

      const updatedMessage = await Message.findByPk(messageId, {
        include: [
          {
            model: Reaction,
            as: 'reactions',
            include: [{
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'avatar']
            }]
          }
        ]
      });

      if (req.io) {
        req.io.to(`chat:${message.chatId}`).emit('message:reacted', {
          messageId: message.id,
          chatId: message.chatId,
          userId: req.user.id,
          username: req.user.username,
          emoji,
          action: existingReaction ? 'removed' : 'added',
          reactions: updatedMessage.reactions,
          timestamp: new Date(),
        });
      }

      res.status(200).json({
        status: 'success',
        message: existingReaction ? 'Reaction removed' : 'Reaction added',
        data: { reactions: updatedMessage.reactions },
      });
    } catch (error) {
      console.error('Error reacting to message:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to react to message'
      });
    }
  })
);

router.post(
  '/mark-read/batch',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { messageIds, chatId } = req.body;

      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        throw new ValidationError('Message IDs are required');
      }

      const chat = await Chat.findOne({
        where: { id: chatId },
        include: [{
          model: User,
          as: 'participants',
          where: { id: req.user.id },
          required: true
        }]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      const now = new Date();
      let markedCount = 0;

      for (const messageId of messageIds) {
        const message = await Message.findByPk(messageId);
        if (message && message.chatId === chatId) {
          const readBy = message.readBy || [];
          if (!readBy.includes(req.user.id)) {
            readBy.push(req.user.id);
            await message.update({ readBy });
            markedCount++;
          }
        }
      }

      if (chat.decrementUnreadCount) {
        await chat.decrementUnreadCount(req.user.id, markedCount);
      }

      if (req.io && markedCount > 0) {
        req.io.to(`chat:${chatId}`).emit('messages:read-batch', {
          chatId,
          readerId: req.user.id,
          messageIds: messageIds.filter(id => true),
          readAt: now,
        });
      }

      res.status(200).json({
        status: 'success',
        message: `${markedCount} message(s) marked as read`,
        data: { markedCount },
      });
    } catch (error) {
      console.error('Error marking messages as read:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to mark messages as read'
      });
    }
  })
);

router.get(
  '/:chatId/search',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;
      const { query, page = 1, limit = 20, senderId, dateFrom, dateTo } = req.query;

      if (!query || query.trim().length < 2) {
        throw new ValidationError('Search query must be at least 2 characters');
      }

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const chat = await Chat.findOne({
        where: { id: chatId },
        include: [{
          model: User,
          as: 'participants',
          where: { id: req.user.id },
          required: true
        }]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      const where = {
        chatId: chatId,
        isDeleted: false,
        [Op.or]: [
          { content: { [Op.iLike]: `%${query}%` } },
          literal(`attachments::text ILIKE '%${query}%'`)
        ]
      };

      if (senderId) {
        where.senderId = senderId;
      }

      if (dateFrom) {
        where.createdAt = { ...where.createdAt, [Op.gte]: new Date(dateFrom) };
      }

      if (dateTo) {
        where.createdAt = { ...where.createdAt, [Op.lte]: new Date(dateTo) };
      }

      const { count, rows: messages } = await Message.findAndCountAll({
        where,
        include: [{
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar', 'displayName']
        }],
        order: [['createdAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        distinct: true
      });

      res.status(200).json({
        status: 'success',
        data: {
          messages,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error searching messages:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to search messages'
      });
    }
  })
);

router.get(
  '/:messageId/status',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { messageId } = req.params;

      const message = await Message.findOne({
        where: {
          id: messageId,
          senderId: req.user.id
        },
        include: [{
          model: User,
          as: 'readBy',
          attributes: ['id', 'username', 'avatar', 'online'],
          through: { attributes: ['readAt'] }
        }]
      });

      if (!message) {
        throw new NotFoundError('Message not found or not authorized');
      }

      const chat = await Chat.findByPk(message.chatId, {
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar', 'online'],
          through: { attributes: [] }
        }]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found');
      }

      const status = {
        sentAt: message.createdAt,
        deliveredTo: [],
        readBy: message.readBy.map(reader => ({
          user: reader,
          readAt: reader.MessageReadBy?.readAt,
        })),
        pending: [],
      };

      chat.participants.forEach(participant => {
        if (participant.id !== req.user.id) {
          const hasRead = message.readBy.some(reader => reader.id === participant.id);

          if (hasRead) {
          } else if (participant.online) {
            status.deliveredTo.push({
              user: participant,
              deliveredAt: message.createdAt,
            });
          } else {
            status.pending.push(participant);
          }
        }
      });

      res.status(200).json({
        status: 'success',
        data: { status },
      });
    } catch (error) {
      console.error('Error getting message status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to get message status'
      });
    }
  })
);

const getMessageTypeFromMime = mimeType => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'document';
  return 'file';
};

const generateThumbnailIfImage = async file => {
  if (file.mimetype.startsWith('image/')) {
    return `/thumbnails/${file.filename}`;
  }
  return null;
};

module.exports = router;