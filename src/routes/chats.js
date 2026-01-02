const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

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

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get all chats for current user with pagination
 */
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      type, // 'direct', 'group', 'all'
      unreadOnly = false,
      search,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build query
    const query = {
      participants: req.user.id,
      isArchived: false,
    };

    // Filter by chat type
    if (type && type !== 'all') {
      query.chatType = type;
    }

    // Filter unread chats
    if (unreadOnly === 'true') {
      query.unreadCount = { $gt: 0 };
    }

    // Search in chat names or participant names
    if (search && search.trim()) {
      const searchRegex = new RegExp(search, 'i');

      // For direct chats, we need to look up participant names
      if (type === 'direct' || !type) {
        // Get users matching search
        const matchingUsers = await User.find({
          $or: [{ username: searchRegex }, { displayName: searchRegex }],
        }).select('_id');

        const matchingUserIds = matchingUsers.map(user => user._id);

        query.$or = [{ chatName: searchRegex }, { participants: { $in: matchingUserIds } }];
      } else {
        query.chatName = searchRegex;
      }
    }

    // Get chats with populated participants
    const [chats, total] = await Promise.all([
      Chat.find(query)
        .populate({
          path: 'participants',
          select: 'username avatar displayName online status',
          match: { _id: { $ne: req.user.id } },
        })
        .populate({
          path: 'lastMessage',
          select: 'content sender createdAt messageType',
        })
        .populate({
          path: 'createdBy',
          select: 'username avatar',
        })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Chat.countDocuments(query),
    ]);

    // Process chats to add metadata
    const processedChats = await Promise.all(
      chats.map(async chat => {
        const chatObj = chat;

        // Get unread count for current user
        if (chatObj.unreadCounts && chatObj.unreadCounts.has(req.user.id)) {
          chatObj.unreadCount = chatObj.unreadCounts.get(req.user.id);
        } else {
          chatObj.unreadCount = 0;
        }

        // For direct chats, get the other participant
        if (chatObj.chatType === 'direct') {
          const otherParticipant = chatObj.participants.find(p => p._id.toString() !== req.user.id);
          chatObj.otherParticipant = otherParticipant || null;

          // Get chat name from participant if not set
          if (!chatObj.chatName && otherParticipant) {
            chatObj.chatName = otherParticipant.displayName || otherParticipant.username;
          }
        }

        // Remove sensitive data
        delete chatObj.unreadCounts;

        return chatObj;
      })
    );

    res.status(200).json({
      status: 'success',
      data: {
        chats: processedChats,
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
 * Get a specific chat by ID
 */
router.get(
  '/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      isArchived: false,
    })
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status',
      })
      .populate({
        path: 'lastMessage',
        select: 'content sender createdAt messageType',
      })
      .populate({
        path: 'createdBy',
        select: 'username avatar',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      });

    if (!chat) {
      throw new NotFoundError('Chat not found or access denied');
    }

    // Mark as read for current user
    if (chat.unreadCounts && chat.unreadCounts.has(req.user.id)) {
      chat.unreadCounts.set(req.user.id, 0);
      await chat.save();
    }

    // Process chat data
    const chatData = chat.toObject();

    // Add unread count
    chatData.unreadCount = chat.unreadCounts?.get(req.user.id) || 0;

    // For direct chats, get the other participant
    if (chat.chatType === 'direct') {
      const otherParticipant = chat.participants.find(p => p._id.toString() !== req.user.id);
      chatData.otherParticipant = otherParticipant || null;

      // Get chat name from participant if not set
      if (!chatData.chatName && otherParticipant) {
        chatData.chatName = otherParticipant.displayName || otherParticipant.username;
      }
    }

    // Remove sensitive data
    delete chatData.unreadCounts;

    res.status(200).json({
      status: 'success',
      data: { chat: chatData },
    });
  })
);

/**
 * Create a new direct chat
 */
router.post(
  '/direct',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
      throw new ValidationError('User ID is required');
    }

    if (userId === req.user.id) {
      throw new ValidationError('Cannot create chat with yourself');
    }

    // Check if other user exists
    const otherUser = await User.findById(userId);
    if (!otherUser) {
      throw new NotFoundError('User not found');
    }

    // Check if chat already exists
    const existingChat = await Chat.findOne({
      chatType: 'direct',
      participants: { $all: [req.user.id, userId], $size: 2 },
    });

    if (existingChat) {
      // Return existing chat
      const chatData = existingChat.toObject();

      // Get other participant
      const otherParticipant = existingChat.participants.find(
        p => p._id.toString() !== req.user.id
      );
      chatData.otherParticipant = otherParticipant || null;

      // Get chat name from participant if not set
      if (!chatData.chatName && otherParticipant) {
        chatData.chatName = otherParticipant.displayName || otherParticipant.username;
      }

      return res.status(200).json({
        status: 'success',
        message: 'Chat already exists',
        data: { chat: chatData },
      });
    }

    // Check if users are blocked
    const currentUser = await User.findById(req.user.id);
    if (currentUser.blockedUsers && currentUser.blockedUsers.includes(userId)) {
      throw new AuthorizationError('Cannot create chat with blocked user');
    }

    if (otherUser.blockedUsers && otherUser.blockedUsers.includes(req.user.id)) {
      throw new AuthorizationError('User has blocked you');
    }

    // Create new direct chat
    const chat = await Chat.create({
      chatType: 'direct',
      participants: [req.user.id, userId],
      createdBy: req.user.id,
      chatName: null, // For direct chats, name is derived from participants
      unreadCounts: new Map([
        [req.user.id, 0],
        [userId, 0],
      ]),
    });

    // Populate the created chat
    const populatedChat = await Chat.findById(chat._id)
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status',
      })
      .populate({
        path: 'createdBy',
        select: 'username avatar',
      });

    const chatData = populatedChat.toObject();

    // Get other participant
    const otherParticipant = populatedChat.participants.find(p => p._id.toString() !== req.user.id);
    chatData.otherParticipant = otherParticipant || null;
    chatData.chatName =
      otherParticipant?.displayName || otherParticipant?.username || 'Direct Chat';

    // Send WebSocket notification to other user
    if (req.io && otherUser.socketIds && otherUser.socketIds.length > 0) {
      otherUser.socketIds.forEach(socketId => {
        req.io.to(socketId).emit('chat:created', {
          chat: chatData,
          createdBy: {
            id: req.user.id,
            username: currentUser.username,
            avatar: currentUser.avatar,
          },
        });
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'Chat created successfully',
      data: { chat: chatData },
    });
  })
);

/**
 * Create a new group chat
 */
router.post(
  '/group',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { name, participantIds, description, avatar } = req.body;

    if (!name || !name.trim()) {
      throw new ValidationError('Group name is required');
    }

    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      throw new ValidationError('At least one participant is required');
    }

    // Add current user to participants if not already included
    const allParticipants = [...new Set([req.user.id, ...participantIds])];

    // Check if all participants exist and are not blocked
    const participants = await User.find({
      _id: { $in: allParticipants },
    });

    if (participants.length !== allParticipants.length) {
      throw new NotFoundError('One or more participants not found');
    }

    // Check for blocked users
    const currentUser = await User.findById(req.user.id);
    const blockedParticipants = participants.filter(
      p => currentUser.blockedUsers?.includes(p._id) || p.blockedUsers?.includes(req.user.id)
    );

    if (blockedParticipants.length > 0) {
      throw new AuthorizationError('Cannot add blocked users to group');
    }

    // Check if group with same participants already exists (optional)
    // This can be heavy for large groups, so might want to skip or optimize

    // Create group chat
    const chat = await Chat.create({
      chatType: 'group',
      chatName: name.trim(),
      description: description?.trim(),
      avatar,
      participants: allParticipants,
      admins: [req.user.id],
      createdBy: req.user.id,
      unreadCounts: new Map(allParticipants.map(participantId => [participantId, 0])),
    });

    // Populate the created chat
    const populatedChat = await Chat.findById(chat._id)
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      })
      .populate({
        path: 'createdBy',
        select: 'username avatar',
      });

    // Send WebSocket notifications to all participants
    if (req.io) {
      participants.forEach(participant => {
        if (participant.socketIds && participant.socketIds.length > 0) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:created', {
              chat: populatedChat.toObject(),
              addedBy: {
                id: req.user.id,
                username: currentUser.username,
                avatar: currentUser.avatar,
              },
            });
          });
        }
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'Group chat created successfully',
      data: { chat: populatedChat },
    });
  })
);

/**
 * Update chat settings (group chats only)
 */
router.patch(
  '/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const { name, description, avatar } = req.body;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      chatType: 'group',
    });

    if (!chat) {
      throw new NotFoundError('Group chat not found or access denied');
    }

    // Check if user is admin
    if (!chat.admins.includes(req.user.id)) {
      throw new AuthorizationError('Only admins can update group settings');
    }

    // Update fields if provided
    const updates = {};
    if (name && name.trim()) updates.chatName = name.trim();
    if (description !== undefined) updates.description = description?.trim();
    if (avatar !== undefined) updates.avatar = avatar;

    const updatedChat = await Chat.findByIdAndUpdate(chatId, updates, {
      new: true,
      runValidators: true,
    })
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      });

    // Send WebSocket notification to all participants
    if (req.io) {
      const participants = await User.find({
        _id: { $in: chat.participants },
      }).select('socketIds');

      participants.forEach(participant => {
        if (participant.socketIds && participant.socketIds.length > 0) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:updated', {
              chatId: chat._id,
              updates,
              updatedBy: {
                id: req.user.id,
                username: req.user.username,
              },
            });
          });
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Chat updated successfully',
      data: { chat: updatedChat },
    });
  })
);

/**
 * Add participants to group chat
 */
router.post(
  '/:chatId/participants',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const { participantIds } = req.body;

    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      throw new ValidationError('Participant IDs are required');
    }

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      chatType: 'group',
    });

    if (!chat) {
      throw new NotFoundError('Group chat not found or access denied');
    }

    // Check if user is admin
    if (!chat.admins.includes(req.user.id)) {
      throw new AuthorizationError('Only admins can add participants');
    }

    // Check if new participants exist
    const newParticipants = await User.find({
      _id: { $in: participantIds },
    });

    if (newParticipants.length !== participantIds.length) {
      throw new NotFoundError('One or more users not found');
    }

    // Check for duplicates
    const existingParticipants = new Set(chat.participants.map(p => p.toString()));
    const uniqueNewParticipants = participantIds.filter(id => !existingParticipants.has(id));

    if (uniqueNewParticipants.length === 0) {
      throw new ValidationError('All users are already in the chat');
    }

    // Add new participants
    chat.participants.push(...uniqueNewParticipants);

    // Initialize unread counts for new participants
    uniqueNewParticipants.forEach(participantId => {
      chat.unreadCounts.set(participantId, 0);
    });

    await chat.save();

    // Get updated chat with populated data
    const updatedChat = await Chat.findById(chatId)
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      });

    // Get current user info
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify new participants
      newParticipants.forEach(participant => {
        if (participant.socketIds && participant.socketIds.length > 0) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:joined', {
              chat: updatedChat.toObject(),
              addedBy: {
                id: req.user.id,
                username: currentUser.username,
                avatar: currentUser.avatar,
              },
            });
          });
        }
      });

      // Notify existing participants
      const existingUsers = await User.find({
        _id: { $in: chat.participants.filter(p => !uniqueNewParticipants.includes(p.toString())) },
      }).select('socketIds');

      existingUsers.forEach(user => {
        if (user.socketIds && user.socketIds.length > 0) {
          user.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:participants-added', {
              chatId: chat._id,
              addedParticipants: newParticipants.map(p => ({
                id: p._id,
                username: p.username,
                avatar: p.avatar,
              })),
              addedBy: {
                id: req.user.id,
                username: currentUser.username,
              },
            });
          });
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Participants added successfully',
      data: {
        chat: updatedChat,
        addedCount: uniqueNewParticipants.length,
      },
    });
  })
);

/**
 * Remove participant from group chat
 */
router.delete(
  '/:chatId/participants/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId, userId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      chatType: 'group',
    });

    if (!chat) {
      throw new NotFoundError('Group chat not found or access denied');
    }

    // Check if user is admin or removing themselves
    const isAdmin = chat.admins.includes(req.user.id);
    const isSelfRemoval = userId === req.user.id;

    if (!isAdmin && !isSelfRemoval) {
      throw new AuthorizationError('Only admins can remove other participants');
    }

    // Check if user to remove is in the chat
    if (!chat.participants.includes(userId)) {
      throw new ValidationError('User is not in this chat');
    }

    // Cannot remove the last admin
    if (chat.admins.includes(userId) && chat.admins.length === 1) {
      throw new ValidationError('Cannot remove the last admin');
    }

    // Remove user from participants
    chat.participants = chat.participants.filter(p => p.toString() !== userId);

    // Remove from admins if they were an admin
    chat.admins = chat.admins.filter(admin => admin.toString() !== userId);

    // Remove unread count
    chat.unreadCounts.delete(userId);

    await chat.save();

    // Get updated chat
    const updatedChat = await Chat.findById(chatId).populate({
      path: 'participants',
      select: 'username avatar displayName online status',
    });

    // Get user info
    const removedUser = await User.findById(userId);
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify removed user
      if (removedUser.socketIds && removedUser.socketIds.length > 0) {
        removedUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('group:removed', {
            chatId: chat._id,
            removedBy: isSelfRemoval
              ? 'self'
              : {
                  id: req.user.id,
                  username: currentUser.username,
                },
          });
        });
      }

      // Notify remaining participants
      const remainingUsers = await User.find({
        _id: { $in: chat.participants },
      }).select('socketIds');

      remainingUsers.forEach(user => {
        if (user.socketIds && user.socketIds.length > 0) {
          user.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:participant-removed', {
              chatId: chat._id,
              removedUserId: userId,
              removedUsername: removedUser.username,
              removedBy: {
                id: req.user.id,
                username: currentUser.username,
              },
            });
          });
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Participant removed successfully',
      data: { chat: updatedChat },
    });
  })
);

/**
 * Archive a chat (soft delete)
 */
router.post(
  '/:chatId/archive',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      isArchived: false,
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or already archived');
    }

    chat.isArchived = true;
    chat.archivedBy = req.user.id;
    chat.archivedAt = new Date();
    await chat.save();

    res.status(200).json({
      status: 'success',
      message: 'Chat archived successfully',
    });
  })
);

/**
 * Unarchive a chat
 */
router.post(
  '/:chatId/unarchive',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      isArchived: true,
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or not archived');
    }

    chat.isArchived = false;
    chat.archivedBy = null;
    chat.archivedAt = null;
    await chat.save();

    res.status(200).json({
      status: 'success',
      message: 'Chat unarchived successfully',
    });
  })
);

/**
 * Mark chat as read
 */
router.post(
  '/:chatId/read',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
    });

    if (!chat) {
      throw new NotFoundError('Chat not found or access denied');
    }

    // Reset unread count for current user
    if (chat.unreadCounts) {
      chat.unreadCounts.set(req.user.id, 0);
      await chat.save();
    }

    res.status(200).json({
      status: 'success',
      message: 'Chat marked as read',
    });
  })
);

/**
 * Leave group chat
 */
router.post(
  '/:chatId/leave',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user.id,
      chatType: 'group',
    });

    if (!chat) {
      throw new NotFoundError('Group chat not found or access denied');
    }

    // Check if user is the last admin
    if (chat.admins.includes(req.user.id) && chat.admins.length === 1) {
      throw new ValidationError('Cannot leave as the last admin. Promote another admin first.');
    }

    // Remove user from participants
    chat.participants = chat.participants.filter(p => p.toString() !== req.user.id);

    // Remove from admins if they were an admin
    chat.admins = chat.admins.filter(admin => admin.toString() !== req.user.id);

    // Remove unread count
    chat.unreadCounts.delete(req.user.id);

    await chat.save();

    // Get current user info
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify remaining participants
      const remainingUsers = await User.find({
        _id: { $in: chat.participants },
      }).select('socketIds');

      remainingUsers.forEach(user => {
        if (user.socketIds && user.socketIds.length > 0) {
          user.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:left', {
              chatId: chat._id,
              userId: req.user.id,
              username: currentUser.username,
            });
          });
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Left group chat successfully',
    });
  })
);

/**
 * Get archived chats
 */
router.get(
  '/archived/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [chats, total] = await Promise.all([
      Chat.find({
        participants: req.user.id,
        isArchived: true,
      })
        .populate({
          path: 'participants',
          select: 'username avatar displayName',
          match: { _id: { $ne: req.user.id } },
        })
        .populate({
          path: 'lastMessage',
          select: 'content sender createdAt',
        })
        .sort({ archivedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Chat.countDocuments({
        participants: req.user.id,
        isArchived: true,
      }),
    ]);

    // Process chats
    const processedChats = chats.map(chat => {
      const chatObj = chat;

      // For direct chats, get the other participant
      if (chatObj.chatType === 'direct') {
        const otherParticipant = chatObj.participants.find(p => p._id.toString() !== req.user.id);
        chatObj.otherParticipant = otherParticipant || null;

        // Get chat name from participant if not set
        if (!chatObj.chatName && otherParticipant) {
          chatObj.chatName = otherParticipant.displayName || otherParticipant.username;
        }
      }

      return chatObj;
    });

    res.status(200).json({
      status: 'success',
      data: {
        chats: processedChats,
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

module.exports = router;
