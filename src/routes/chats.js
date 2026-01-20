const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
const sequelize = require('sequelize');
const {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, Chat, Message } = require('../models');

router.use(authenticate);

console.log('✅ Chats routes initialized');

router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        type,
        unreadOnly = false,
        search,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = {
        '$participants.id$': req.user.id,
        isArchived: false,
      };

      if (type && type !== 'all') {
        where.chatType = type;
      }

      if (unreadOnly === 'true') {
        where.unreadCount = { [sequelize.Op.gt]: 0 };
      }

      if (search && search.trim()) {
        const searchRegex = `%${search}%`;
        
        if (type === 'direct' || !type) {
          where[sequelize.Op.or] = [
            { chatName: { [sequelize.Op.iLike]: searchRegex } },
            { '$participants.username$': { [sequelize.Op.iLike]: searchRegex } },
            { '$participants.displayName$': { [sequelize.Op.iLike]: searchRegex } }
          ];
        } else {
          where.chatName = { [sequelize.Op.iLike]: searchRegex };
        }
      }

      const { count, rows: chats } = await Chat.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
            through: { attributes: [] },
            where: { id: { [sequelize.Op.ne]: req.user.id } },
            required: false
          },
          {
            model: Message,
            as: 'lastMessage',
            attributes: ['content', 'senderId', 'createdAt', 'messageType']
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          }
        ],
        order: [['updatedAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        distinct: true
      });

      const processedChats = await Promise.all(
        chats.map(async chat => {
          const chatObj = chat.toJSON();
          
          const userUnread = await chat.getUnreadCount(req.user.id);
          chatObj.unreadCount = userUnread || 0;

          if (chatObj.chatType === 'direct') {
            const otherParticipant = chatObj.participants.find(p => p.id !== req.user.id);
            chatObj.otherParticipant = otherParticipant || null;

            if (!chatObj.chatName && otherParticipant) {
              chatObj.chatName = otherParticipant.displayName || otherParticipant.username;
            }
          }

          return chatObj;
        })
      );

      res.status(200).json({
        status: 'success',
        data: {
          chats: processedChats,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching chats:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch chats'
      });
    }
  })
);

router.get(
  '/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
            through: { attributes: [] }
          },
          {
            model: Message,
            as: 'lastMessage',
            attributes: ['content', 'senderId', 'createdAt', 'messageType']
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          }
        ]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      await chat.markAsRead(req.user.id);

      const chatData = chat.toJSON();
      const userUnread = await chat.getUnreadCount(req.user.id);
      chatData.unreadCount = userUnread || 0;

      if (chat.chatType === 'direct') {
        const otherParticipant = chatData.participants.find(p => p.id !== req.user.id);
        chatData.otherParticipant = otherParticipant || null;

        if (!chatData.chatName && otherParticipant) {
          chatData.chatName = otherParticipant.displayName || otherParticipant.username;
        }
      }

      res.status(200).json({
        status: 'success',
        data: { chat: chatData },
      });
    } catch (error) {
      console.error('Error fetching chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch chat'
      });
    }
  })
);

router.post(
  '/direct',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      if (userId === req.user.id) {
        throw new ValidationError('Cannot create chat with yourself');
      }

      const otherUser = await User.findByPk(userId);
      if (!otherUser) {
        throw new NotFoundError('User not found');
      }

      const existingChat = await Chat.findOne({
        where: {
          chatType: 'direct',
          '$participants.id$': { [sequelize.Op.contains]: [req.user.id, userId] }
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar', 'displayName'],
          through: { attributes: [] }
        }]
      });

      if (existingChat) {
        const chatData = existingChat.toJSON();
        const otherParticipant = chatData.participants.find(p => p.id !== req.user.id);
        chatData.otherParticipant = otherParticipant || null;

        if (!chatData.chatName && otherParticipant) {
          chatData.chatName = otherParticipant.displayName || otherParticipant.username;
        }

        return res.status(200).json({
          status: 'success',
          message: 'Chat already exists',
          data: { chat: chatData },
        });
      }

      const currentUser = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      if (currentUser.blockedUsers.some(bu => bu.id === userId)) {
        throw new AuthorizationError('Cannot create chat with blocked user');
      }

      const otherUserWithBlocks = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      if (otherUserWithBlocks.blockedUsers.some(bu => bu.id === req.user.id)) {
        throw new AuthorizationError('User has blocked you');
      }

      const chat = await Chat.create({
        chatType: 'direct',
        createdBy: req.user.id,
        chatName: null,
      });

      await chat.setParticipants([req.user.id, userId]);

      const populatedChat = await Chat.findByPk(chat.id, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          }
        ]
      });

      const chatData = populatedChat.toJSON();
      const otherParticipant = chatData.participants.find(p => p.id !== req.user.id);
      chatData.otherParticipant = otherParticipant || null;
      chatData.chatName = otherParticipant?.displayName || otherParticipant?.username || 'Direct Chat';

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
    } catch (error) {
      console.error('Error creating direct chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to create direct chat'
      });
    }
  })
);

router.post(
  '/group',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { name, participantIds, description, avatar } = req.body;

      if (!name || !name.trim()) {
        throw new ValidationError('Group name is required');
      }

      if (!Array.isArray(participantIds) || participantIds.length === 0) {
        throw new ValidationError('At least one participant is required');
      }

      const allParticipants = [...new Set([req.user.id, ...participantIds])];

      const participants = await User.findAll({
        where: { id: allParticipants }
      });

      if (participants.length !== allParticipants.length) {
        throw new NotFoundError('One or more participants not found');
      }

      const currentUser = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      const blockedParticipants = participants.filter(p =>
        currentUser.blockedUsers.some(bu => bu.id === p.id) ||
        p.blockedUsers.some(bu => bu.id === req.user.id)
      );

      if (blockedParticipants.length > 0) {
        throw new AuthorizationError('Cannot add blocked users to group');
      }

      const chat = await Chat.create({
        chatType: 'group',
        chatName: name.trim(),
        description: description?.trim(),
        avatar,
        createdBy: req.user.id,
      });

      await chat.setParticipants(allParticipants);
      await chat.setAdmins([req.user.id]);

      const populatedChat = await Chat.findByPk(chat.id, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          }
        ]
      });

      if (req.io) {
        participants.forEach(participant => {
          if (participant.socketIds && participant.socketIds.length > 0) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:created', {
                chat: populatedChat.toJSON(),
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
    } catch (error) {
      console.error('Error creating group chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to create group chat'
      });
    }
  })
);

router.patch(
  '/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;
      const { name, description, avatar } = req.body;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          chatType: 'group'
        },
        include: [{
          model: User,
          as: 'admins',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      });

      if (!chat) {
        throw new NotFoundError('Group chat not found or access denied');
      }

      const isAdmin = chat.admins.some(admin => admin.id === req.user.id);
      if (!isAdmin) {
        throw new AuthorizationError('Only admins can update group settings');
      }

      const updates = {};
      if (name && name.trim()) updates.chatName = name.trim();
      if (description !== undefined) updates.description = description?.trim();
      if (avatar !== undefined) updates.avatar = avatar;

      await chat.update(updates);

      const updatedChat = await Chat.findByPk(chatId, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'socketIds'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          }
        ]
      });

      if (req.io) {
        const participants = await User.findAll({
          where: { id: updatedChat.participants.map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        participants.forEach(participant => {
          if (participant.socketIds && participant.socketIds.length > 0) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:updated', {
                chatId: chat.id,
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
    } catch (error) {
      console.error('Error updating chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update chat'
      });
    }
  })
);

router.post(
  '/:chatId/participants',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;
      const { participantIds } = req.body;

      if (!Array.isArray(participantIds) || participantIds.length === 0) {
        throw new ValidationError('Participant IDs are required');
      }

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          chatType: 'group'
        },
        include: [
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'participants',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!chat) {
        throw new NotFoundError('Group chat not found or access denied');
      }

      const isAdmin = chat.admins.some(admin => admin.id === req.user.id);
      if (!isAdmin) {
        throw new AuthorizationError('Only admins can add participants');
      }

      const newParticipants = await User.findAll({
        where: { id: participantIds }
      });

      if (newParticipants.length !== participantIds.length) {
        throw new NotFoundError('One or more users not found');
      }

      const existingParticipantIds = chat.participants.map(p => p.id);
      const uniqueNewParticipants = participantIds.filter(id => !existingParticipantIds.includes(id));

      if (uniqueNewParticipants.length === 0) {
        throw new ValidationError('All users are already in the chat');
      }

      await chat.addParticipants(uniqueNewParticipants);

      const updatedChat = await Chat.findByPk(chatId, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          }
        ]
      });

      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        newParticipants.forEach(participant => {
          if (participant.socketIds && participant.socketIds.length > 0) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:joined', {
                chat: updatedChat.toJSON(),
                addedBy: {
                  id: req.user.id,
                  username: currentUser.username,
                  avatar: currentUser.avatar,
                },
              });
            });
          }
        });

        const existingUsers = await User.findAll({
          where: { 
            id: existingParticipantIds.filter(id => !uniqueNewParticipants.includes(id))
          },
          attributes: ['id', 'socketIds']
        });

        existingUsers.forEach(user => {
          if (user.socketIds && user.socketIds.length > 0) {
            user.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:participants-added', {
                chatId: chat.id,
                addedParticipants: newParticipants.map(p => ({
                  id: p.id,
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
    } catch (error) {
      console.error('Error adding participants:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to add participants'
      });
    }
  })
);

router.delete(
  '/:chatId/participants/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId, userId } = req.params;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          chatType: 'group'
        },
        include: [
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'participants',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!chat) {
        throw new NotFoundError('Group chat not found or access denied');
      }

      const isAdmin = chat.admins.some(admin => admin.id === req.user.id);
      const isSelfRemoval = userId === req.user.id;

      if (!isAdmin && !isSelfRemoval) {
        throw new AuthorizationError('Only admins can remove other participants');
      }

      const isParticipant = chat.participants.some(p => p.id === userId);
      if (!isParticipant) {
        throw new ValidationError('User is not in this chat');
      }

      if (chat.admins.some(admin => admin.id === userId) && chat.admins.length === 1) {
        throw new ValidationError('Cannot remove the last admin');
      }

      await chat.removeParticipant(userId);

      if (chat.admins.some(admin => admin.id === userId)) {
        await chat.removeAdmin(userId);
      }

      const updatedChat = await Chat.findByPk(chatId, {
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
          through: { attributes: [] }
        }]
      });

      const removedUser = await User.findByPk(userId);
      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        if (removedUser.socketIds && removedUser.socketIds.length > 0) {
          removedUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:removed', {
              chatId: chat.id,
              removedBy: isSelfRemoval
                ? 'self'
                : {
                    id: req.user.id,
                    username: currentUser.username,
                  },
            });
          });
        }

        const remainingUsers = await User.findAll({
          where: { id: updatedChat.participants.map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        remainingUsers.forEach(user => {
          if (user.socketIds && user.socketIds.length > 0) {
            user.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:participant-removed', {
                chatId: chat.id,
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
    } catch (error) {
      console.error('Error removing participant:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove participant'
      });
    }
  })
);

router.post(
  '/:chatId/archive',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          isArchived: false
        }
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or already archived');
      }

      await chat.update({
        isArchived: true,
        archivedBy: req.user.id,
        archivedAt: new Date()
      });

      res.status(200).json({
        status: 'success',
        message: 'Chat archived successfully',
      });
    } catch (error) {
      console.error('Error archiving chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to archive chat'
      });
    }
  })
);

router.post(
  '/:chatId/unarchive',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          isArchived: true
        }
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or not archived');
      }

      await chat.update({
        isArchived: false,
        archivedBy: null,
        archivedAt: null
      });

      res.status(200).json({
        status: 'success',
        message: 'Chat unarchived successfully',
      });
    } catch (error) {
      console.error('Error unarchiving chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to unarchive chat'
      });
    }
  })
);

router.post(
  '/:chatId/read',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id
        }
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      await chat.markAsRead(req.user.id);

      res.status(200).json({
        status: 'success',
        message: 'Chat marked as read',
      });
    } catch (error) {
      console.error('Error marking chat as read:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to mark chat as read'
      });
    }
  })
);

router.post(
  '/:chatId/leave',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id,
          chatType: 'group'
        },
        include: [{
          model: User,
          as: 'admins',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      });

      if (!chat) {
        throw new NotFoundError('Group chat not found or access denied');
      }

      const isAdmin = chat.admins.some(admin => admin.id === req.user.id);
      if (isAdmin && chat.admins.length === 1) {
        throw new ValidationError('Cannot leave as the last admin. Promote another admin first.');
      }

      await chat.removeParticipant(req.user.id);

      if (isAdmin) {
        await chat.removeAdmin(req.user.id);
      }

      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        const remainingUsers = await User.findAll({
          where: { id: chat.participants.map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        remainingUsers.forEach(user => {
          if (user.socketIds && user.socketIds.length > 0) {
            user.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:left', {
                chatId: chat.id,
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
    } catch (error) {
      console.error('Error leaving group chat:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to leave group chat'
      });
    }
  })
);

router.get(
  '/archived/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { count, rows: chats } = await Chat.findAndCountAll({
        where: {
          '$participants.id$': req.user.id,
          isArchived: true
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName'],
            through: { attributes: [] },
            where: { id: { [sequelize.Op.ne]: req.user.id } },
            required: false
          },
          {
            model: Message,
            as: 'lastMessage',
            attributes: ['content', 'senderId', 'createdAt']
          }
        ],
        order: [['archivedAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        distinct: true
      });

      const processedChats = chats.map(chat => {
        const chatObj = chat.toJSON();

        if (chatObj.chatType === 'direct') {
          const otherParticipant = chatObj.participants.find(p => p.id !== req.user.id);
          chatObj.otherParticipant = otherParticipant || null;

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
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching archived chats:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch archived chats'
      });
    }
  })
);

module.exports = router;