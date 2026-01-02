const chatService = require('../services/chatService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class ChatController {
  async createDirectChat(req, res, next) {
    try {
      const userId = req.user.id;
      const { participantId } = req.body;

      if (userId === participantId) {
        throw new AppError('Cannot create chat with yourself', 400);
      }

      const chat = await chatService.createDirectChat(userId, participantId);

      res.status(201).json({
        success: true,
        message: 'Chat created successfully',
        data: {
          chat,
        },
      });
    } catch (error) {
      logger.error('Create direct chat controller error:', error);
      next(error);
    }
  }

  async createGroupChat(req, res, next) {
    try {
      const userId = req.user.id;
      const chatData = req.body;

      if (!chatData.participantIds || chatData.participantIds.length === 0) {
        throw new AppError('At least one participant is required', 400);
      }

      // Remove self from participantIds if present
      chatData.participantIds = chatData.participantIds.filter(id => id !== userId);

      const chat = await chatService.createGroupChat(userId, chatData);

      res.status(201).json({
        success: true,
        message: 'Group chat created successfully',
        data: {
          chat,
        },
      });
    } catch (error) {
      logger.error('Create group chat controller error:', error);
      next(error);
    }
  }

  async getUserChats(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 50 } = req.query;

      const chats = await chatService.getUserChats(userId, {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      });

      res.json({
        success: true,
        data: {
          chats,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: chats.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get user chats controller error:', error);
      next(error);
    }
  }

  async getChatDetails(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      const chat = await chatService.getChatDetails(parseInt(chatId), userId);

      res.json({
        success: true,
        data: {
          chat,
        },
      });
    } catch (error) {
      logger.error('Get chat details controller error:', error);
      next(error);
    }
  }

  async updateChat(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;
      const updateData = req.body;

      const chat = await chatService.updateChat(parseInt(chatId), userId, updateData);

      res.json({
        success: true,
        message: 'Chat updated successfully',
        data: {
          chat,
        },
      });
    } catch (error) {
      logger.error('Update chat controller error:', error);
      next(error);
    }
  }

  async addParticipant(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;
      const { participantId, role = 'member' } = req.body;

      await chatService.addParticipant(parseInt(chatId), userId, participantId, role);

      res.json({
        success: true,
        message: 'Participant added successfully',
      });
    } catch (error) {
      logger.error('Add participant controller error:', error);
      next(error);
    }
  }

  async removeParticipant(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId, participantId } = req.params;

      await chatService.removeParticipant(parseInt(chatId), userId, parseInt(participantId));

      res.json({
        success: true,
        message: 'Participant removed successfully',
      });
    } catch (error) {
      logger.error('Remove participant controller error:', error);
      next(error);
    }
  }

  async updateParticipantRole(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId, participantId } = req.params;
      const { role } = req.body;

      await chatService.updateParticipantRole(
        parseInt(chatId),
        userId,
        parseInt(participantId),
        role
      );

      res.json({
        success: true,
        message: 'Participant role updated successfully',
      });
    } catch (error) {
      logger.error('Update participant role controller error:', error);
      next(error);
    }
  }

  async leaveChat(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      await chatService.leaveChat(parseInt(chatId), userId);

      res.json({
        success: true,
        message: 'Left chat successfully',
      });
    } catch (error) {
      logger.error('Leave chat controller error:', error);
      next(error);
    }
  }

  async deleteChat(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      await chatService.deleteChat(parseInt(chatId), userId);

      res.json({
        success: true,
        message: 'Chat deleted successfully',
      });
    } catch (error) {
      logger.error('Delete chat controller error:', error);
      next(error);
    }
  }

  async markAsRead(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      const count = await chatService.markAsRead(parseInt(chatId), userId);

      res.json({
        success: true,
        message: 'Chat marked as read',
        data: {
          markedCount: count,
        },
      });
    } catch (error) {
      logger.error('Mark as read controller error:', error);
      next(error);
    }
  }

  async getUnreadCount(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      const count = await chatService.getUnreadCount(parseInt(chatId), userId);

      res.json({
        success: true,
        data: {
          chatId: parseInt(chatId),
          unreadCount: count,
        },
      });
    } catch (error) {
      logger.error('Get unread count controller error:', error);
      next(error);
    }
  }

  async getChatParticipants(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      const chat = await chatService.getChatDetails(parseInt(chatId), userId);

      res.json({
        success: true,
        data: {
          participants: chat.participants,
          count: chat.participants.length,
        },
      });
    } catch (error) {
      logger.error('Get chat participants controller error:', error);
      next(error);
    }
  }
}

module.exports = new ChatController();
