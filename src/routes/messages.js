const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

// Import middleware and utilities
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
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');

// Environment variables
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10MB
const ALLOWED_FILE_TYPES = (
  process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/gif,application/pdf,text/plain'
).split(',');
const UPLOAD_PATH = process.env.UPLOAD_PATH || 'uploads/messages';

// Ensure upload directory exists
const ensureUploadDir = async () => {
  try {
    await fs.mkdir(UPLOAD_PATH, { recursive: true });
  } catch (error) {
    console.error('Failed to create upload directory:', error);
  }
};
ensureUploadDir();

// Configure multer for file uploads
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

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get messages for a chat with pagination
 */
router.get(
  '/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const {
      page = 1,
      limit = 50,
      before = null, // Get messages before this timestamp
      after = null, // Get messages after this timestamp
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Verify user has access to chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      isArchived: false,
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or access denied');
    }

    // Build query
    const query = { chat: chatId, isDeleted: false };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    if (after) {
      query.createdAt = { $gt: new Date(after) };
    }

    // Get messages with pagination
    const [messages, total] = await Promise.all([
      Message.find(query)
        .populate({
          path: 'sender',
          select: 'username avatar displayName',
        })
        .populate({
          path: 'repliesTo',
          select: 'content sender createdAt',
          populate: {
            path: 'sender',
            select: 'username avatar',
          },
        })
        .populate({
          path: 'readBy.user',
          select: 'username avatar',
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Message.countDocuments(query),
    ]);

    // Reverse to get chronological order for response
    const chronologicalMessages = messages.reverse();

    // Mark messages as read for current user
    const unreadMessages = messages.filter(
      msg => !msg.readBy.some(reader => reader.user && reader.user._id.toString() === req.user.id)
    );

    if (unreadMessages.length > 0) {
      const now = new Date();
      await Message.updateMany(
        { _id: { $in: unreadMessages.map(msg => msg._id) } },
        {
          $addToSet: {
            readBy: {
              user: req.user.id,
              readAt: now,
            },
          },
        }
      );

      // Update chat's unread count for current user
      if (chat.unreadCounts && chat.unreadCounts.has(req.user.id)) {
        chat.unreadCounts.set(
          req.user.id,
          Math.max(0, chat.unreadCounts.get(req.user.id) - unreadMessages.length)
        );
        await chat.save();
      }

      // Send WebSocket read receipts to other participants
      if (req.io && unreadMessages.length > 0) {
        const senderIds = [...new Set(unreadMessages.map(msg => msg.sender._id.toString()))];

        senderIds.forEach(senderId => {
          if (senderId !== req.user.id) {
            const sender = unreadMessages.find(
              msg => msg.sender._id.toString() === senderId
            )?.sender;
            if (sender && sender.socketIds) {
              sender.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('messages:read', {
                  chatId,
                  readerId: req.user.id,
                  messageIds: unreadMessages
                    .filter(msg => msg.sender._id.toString() === senderId)
                    .map(msg => msg._id),
                  readAt: now,
                });
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
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
        chatInfo: {
          id: chat._id,
          chatType: chat.chatType,
          chatName: chat.chatName,
        },
      },
    });
  })
);

/**
 * Send a new message
 */
router.post(
  '/:chatId',
  createMessageRateLimiter(),
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const { content, replyTo, messageType = 'text' } = req.body;

    // Validate content based on message type
    if (messageType === 'text' && (!content || content.trim().length === 0)) {
      throw new ValidationError('Message content is required for text messages');
    }

    if (messageType === 'text' && content.length > 5000) {
      throw new ValidationError('Message too long (max 5000 characters)');
    }

    // Verify user has access to chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      isArchived: false,
    }).populate({
      path: 'participants',
      select: 'username avatar socketIds blockedUsers',
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or access denied');
    }

    // Check if replying to a valid message
    let replyToMessage = null;
    if (replyTo) {
      replyToMessage = await Message.findOne({
        _id: replyTo,
        chat: chatId,
        isDeleted: false,
      });

      if (!replyToMessage) {
        throw new ValidationError('Message to reply to not found');
      }
    }

    // Check for blocked users in the chat
    const currentUser = await User.findById(req.user.id);
    const blockedParticipants = chat.participants.filter(
      participant =>
        currentUser.blockedUsers?.includes(participant._id) ||
        participant.blockedUsers?.includes(req.user.id)
    );

    if (blockedParticipants.length > 0) {
      throw new AuthorizationError('Cannot send messages in chat with blocked users');
    }

    // Create the message
    const message = await Message.create({
      chat: chatId,
      sender: req.user.id,
      content: content?.trim(),
      messageType,
      repliesTo: replyToMessage?._id,
      attachments: [], // For file uploads in separate endpoint
    });

    // Populate the message
    const populatedMessage = await Message.findById(message._id)
      .populate({
        path: 'sender',
        select: 'username avatar displayName',
      })
      .populate({
        path: 'repliesTo',
        select: 'content sender createdAt',
        populate: {
          path: 'sender',
          select: 'username avatar',
        },
      });

    // Update chat's last message and timestamps
    chat.lastMessage = message._id;
    chat.updatedAt = new Date();

    // Increment unread counts for all participants except sender
    chat.participants.forEach(participant => {
      if (participant._id.toString() !== req.user.id) {
        const currentCount = chat.unreadCounts.get(participant._id.toString()) || 0;
        chat.unreadCounts.set(participant._id.toString(), currentCount + 1);
      }
    });

    await chat.save();

    // Prepare message data for WebSocket
    const messageData = populatedMessage.toObject();
    messageData.unreadCount = 1; // Initial unread count for recipients

    // Send WebSocket notification to all participants except sender
    if (req.io) {
      chat.participants.forEach(participant => {
        if (participant._id.toString() !== req.user.id && participant.socketIds) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('message:new', {
              message: messageData,
              chat: {
                id: chat._id,
                chatType: chat.chatType,
                chatName: chat.chatName,
                unreadCount: chat.unreadCounts.get(participant._id.toString()) || 0,
              },
              sender: {
                id: req.user.id,
                username: currentUser.username,
                avatar: currentUser.avatar,
              },
            });
          });
        }
      });

      // Also emit to sender for consistency (with different event type)
      if (currentUser.socketIds) {
        currentUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('message:sent', {
            message: messageData,
            chatId: chat._id,
          });
        });
      }
    }

    res.status(201).json({
      status: 'success',
      message: 'Message sent successfully',
      data: { message: populatedMessage },
    });
  })
);

/**
 * Upload file attachment for a message
 */
router.post(
  '/:chatId/upload',
  apiRateLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    // Verify user has access to chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      isArchived: false,
    });

    if (!chat) {
      // Clean up uploaded file
      await fs.unlink(req.file.path).catch(() => {});
      throw new NotFoundError('Chat not found or access denied');
    }

    // Create message with attachment
    const message = await Message.create({
      chat: chatId,
      sender: req.user.id,
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
    });

    // Update chat
    chat.lastMessage = message._id;
    chat.updatedAt = new Date();

    // Increment unread counts for all participants except sender
    chat.participants.forEach(participantId => {
      if (participantId.toString() !== req.user.id) {
        const currentCount = chat.unreadCounts.get(participantId.toString()) || 0;
        chat.unreadCounts.set(participantId.toString(), currentCount + 1);
      }
    });

    await chat.save();

    // Populate message
    const populatedMessage = await Message.findById(message._id).populate({
      path: 'sender',
      select: 'username avatar displayName',
    });

    // Send WebSocket notifications (similar to text messages)
    if (req.io) {
      const participants = await User.find({
        _id: { $in: chat.participants },
      }).select('socketIds');

      participants.forEach(participant => {
        if (participant._id.toString() !== req.user.id && participant.socketIds) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('message:new', {
              message: populatedMessage.toObject(),
              chat: {
                id: chat._id,
                chatType: chat.chatType,
                chatName: chat.chatName,
              },
            });
          });
        }
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'File uploaded successfully',
      data: {
        message: populatedMessage,
        fileUrl: `/api/messages/${chatId}/files/${message._id}/${req.file.filename}`,
      },
    });
  })
);

/**
 * Edit a message
 */
router.patch(
  '/:messageId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      throw new ValidationError('Message content is required');
    }

    const message = await Message.findOne({
      _id: messageId,
      sender: req.user.id,
      isDeleted: false,
    }).populate('chat');

    if (!message) {
      throw new NotFoundError('Message not found or not authorized to edit');
    }

    // Check if message is too old to edit (e.g., 15 minutes)
    const editWindow = 15 * 60 * 1000; // 15 minutes
    if (Date.now() - message.createdAt.getTime() > editWindow) {
      throw new ValidationError('Message can only be edited within 15 minutes of sending');
    }

    // Update message
    message.content = content.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    // Populate updated message
    const updatedMessage = await Message.findById(messageId).populate({
      path: 'sender',
      select: 'username avatar displayName',
    });

    // Send WebSocket notification
    if (req.io) {
      const chat = await Chat.findById(message.chat._id).populate({
        path: 'participants',
        select: 'socketIds',
      });

      if (chat) {
        chat.participants.forEach(participant => {
          if (participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('message:edited', {
                messageId: message._id,
                chatId: message.chat._id,
                content: message.content,
                editedAt: message.editedAt,
                editedBy: {
                  id: req.user.id,
                  username: req.user.username,
                },
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Message updated successfully',
      data: { message: updatedMessage },
    });
  })
);

/**
 * Delete a message (soft delete)
 */
router.delete(
  '/:messageId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const { deleteForEveryone = false } = req.query;

    const message = await Message.findOne({
      _id: messageId,
      $or: [
        { sender: req.user.id },
        deleteForEveryone === 'true' ? { chat: { $exists: true } } : {},
      ],
      isDeleted: false,
    }).populate('chat');

    if (!message) {
      throw new NotFoundError('Message not found or not authorized to delete');
    }

    // For delete for everyone, check if user is admin in group chats
    if (deleteForEveryone === 'true' && message.chat.chatType === 'group') {
      const chat = await Chat.findById(message.chat._id);
      if (!chat.admins.includes(req.user.id)) {
        throw new AuthorizationError('Only admins can delete messages for everyone');
      }
    }

    // Soft delete the message
    message.isDeleted = true;
    message.deletedAt = new Date();
    message.deletedBy = req.user.id;
    message.deleteForEveryone = deleteForEveryone === 'true';
    await message.save();

    // If this was the last message in chat, update chat's last message
    const chat = await Chat.findById(message.chat._id);
    if (chat.lastMessage && chat.lastMessage.toString() === messageId) {
      // Find the most recent non-deleted message
      const previousMessage = await Message.findOne({
        chat: message.chat._id,
        isDeleted: false,
        _id: { $ne: messageId },
      }).sort({ createdAt: -1 });

      chat.lastMessage = previousMessage?._id || null;
      await chat.save();
    }

    // Send WebSocket notification
    if (req.io) {
      const populatedChat = await Chat.findById(message.chat._id).populate({
        path: 'participants',
        select: 'socketIds',
      });

      if (populatedChat) {
        populatedChat.participants.forEach(participant => {
          if (participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('message:deleted', {
                messageId: message._id,
                chatId: message.chat._id,
                deletedBy: {
                  id: req.user.id,
                  username: req.user.username,
                },
                deleteForEveryone: message.deleteForEveryone,
                deletedAt: message.deletedAt,
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Message deleted successfully',
    });
  })
);

/**
 * React to a message
 */
router.post(
  '/:messageId/react',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji || emoji.trim().length === 0) {
      throw new ValidationError('Emoji is required');
    }

    const message = await Message.findOne({
      _id: messageId,
      isDeleted: false,
    }).populate('chat');

    if (!message) {
      throw new NotFoundError('Message not found');
    }

    // Check if user has access to the chat
    const chat = await Chat.findOne({
      _id: message.chat._id,
      participants: req.user.id,
    });

    if (!chat) {
      throw new AuthorizationError('Access denied');
    }

    // Add or update reaction
    const existingReactionIndex = message.reactions.findIndex(
      r => r.user.toString() === req.user.id && r.emoji === emoji
    );

    if (existingReactionIndex >= 0) {
      // Remove reaction if already exists
      message.reactions.splice(existingReactionIndex, 1);
    } else {
      // Add new reaction
      message.reactions.push({
        user: req.user.id,
        emoji,
        reactedAt: new Date(),
      });
    }

    await message.save();

    // Populate reactions
    const updatedMessage = await Message.findById(messageId).populate({
      path: 'reactions.user',
      select: 'username avatar',
    });

    // Send WebSocket notification
    if (req.io) {
      const populatedChat = await Chat.findById(message.chat._id).populate({
        path: 'participants',
        select: 'socketIds',
      });

      if (populatedChat) {
        populatedChat.participants.forEach(participant => {
          if (participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('message:reacted', {
                messageId: message._id,
                chatId: message.chat._id,
                userId: req.user.id,
                username: req.user.username,
                emoji,
                action: existingReactionIndex >= 0 ? 'removed' : 'added',
                reactions: updatedMessage.reactions,
                timestamp: new Date(),
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: existingReactionIndex >= 0 ? 'Reaction removed' : 'Reaction added',
      data: { reactions: updatedMessage.reactions },
    });
  })
);

/**
 * Mark multiple messages as read
 */
router.post(
  '/mark-read/batch',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { messageIds, chatId } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new ValidationError('Message IDs are required');
    }

    // Verify user has access to chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or access denied');
    }

    // Mark messages as read
    const now = new Date();
    const result = await Message.updateMany(
      {
        _id: { $in: messageIds },
        chat: chatId,
        'readBy.user': { $ne: req.user.id },
      },
      {
        $addToSet: {
          readBy: {
            user: req.user.id,
            readAt: now,
          },
        },
      }
    );

    // Update chat's unread count
    if (chat.unreadCounts && chat.unreadCounts.has(req.user.id)) {
      const currentUnread = chat.unreadCounts.get(req.user.id);
      const newUnread = Math.max(0, currentUnread - result.modifiedCount);
      chat.unreadCounts.set(req.user.id, newUnread);
      await chat.save();
    }

    // Send WebSocket read receipts
    if (req.io && result.modifiedCount > 0) {
      // Get unique senders of the marked messages
      const messages = await Message.find({
        _id: { $in: messageIds },
      }).populate('sender', 'socketIds');

      const senderMap = new Map();
      messages.forEach(msg => {
        if (msg.sender && msg.sender._id.toString() !== req.user.id) {
          const senderId = msg.sender._id.toString();
          if (!senderMap.has(senderId)) {
            senderMap.set(senderId, []);
          }
          senderMap.get(senderId).push(msg._id);
        }
      });

      // Send notifications to each sender
      for (const [senderId, msgIds] of senderMap) {
        const sender = messages.find(msg => msg.sender._id.toString() === senderId)?.sender;
        if (sender && sender.socketIds) {
          sender.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('messages:read-batch', {
              chatId,
              readerId: req.user.id,
              messageIds: msgIds,
              readAt: now,
            });
          });
        }
      }
    }

    res.status(200).json({
      status: 'success',
      message: `${result.modifiedCount} message(s) marked as read`,
      data: { markedCount: result.modifiedCount },
    });
  })
);

/**
 * Search messages in a chat
 */
router.get(
  '/:chatId/search',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const { query, page = 1, limit = 20, senderId, dateFrom, dateTo } = req.query;

    if (!query || query.trim().length < 2) {
      throw new ValidationError('Search query must be at least 2 characters');
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Verify user has access to chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or access denied');
    }

    // Build search query
    const searchQuery = {
      chat: chatId,
      isDeleted: false,
      $or: [
        { content: { $regex: query, $options: 'i' } },
        { 'attachments.filename': { $regex: query, $options: 'i' } },
      ],
    };

    if (senderId) {
      searchQuery.sender = senderId;
    }

    if (dateFrom) {
      searchQuery.createdAt = { ...searchQuery.createdAt, $gte: new Date(dateFrom) };
    }

    if (dateTo) {
      searchQuery.createdAt = { ...searchQuery.createdAt, $lte: new Date(dateTo) };
    }

    // Execute search
    const [messages, total] = await Promise.all([
      Message.find(searchQuery)
        .populate({
          path: 'sender',
          select: 'username avatar displayName',
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Message.countDocuments(searchQuery),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        messages,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  })
);

/**
 * Get message delivery status
 */
router.get(
  '/:messageId/status',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { messageId } = req.params;

    const message = await Message.findOne({
      _id: messageId,
      sender: req.user.id,
    }).populate({
      path: 'readBy.user',
      select: 'username avatar online',
    });

    if (!message) {
      throw new NotFoundError('Message not found or not authorized');
    }

    // Get chat participants
    const chat = await Chat.findById(message.chat).populate({
      path: 'participants',
      select: 'username avatar online',
    });

    if (!chat) {
      throw new NotFoundError('Chat not found');
    }

    // Build status report
    const status = {
      sentAt: message.createdAt,
      deliveredTo: [],
      readBy: message.readBy.map(reader => ({
        user: reader.user,
        readAt: reader.readAt,
      })),
      pending: [],
    };

    // Determine delivery status for each participant (except sender)
    chat.participants.forEach(participant => {
      if (participant._id.toString() !== req.user.id) {
        const hasRead = message.readBy.some(
          reader => reader.user && reader.user._id.toString() === participant._id.toString()
        );

        if (hasRead) {
          // Already in readBy array
        } else if (participant.online) {
          status.deliveredTo.push({
            user: participant,
            deliveredAt: message.createdAt, // Assuming immediate delivery for online users
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
  })
);

// Helper functions
const getMessageTypeFromMime = mimeType => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'document';
  return 'file';
};

const generateThumbnailIfImage = async file => {
  // Implement thumbnail generation for images
  // This is a placeholder - in production, use a library like sharp
  if (file.mimetype.startsWith('image/')) {
    return `/thumbnails/${file.filename}`;
  }
  return null;
};

module.exports = router;
