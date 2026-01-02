const messageService = require('../services/messageService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class MessageController {
  async sendMessage(req, res, next) {
    try {
      const userId = req.user.id;
      const messageData = req.body;
      const file = req.file;

      const message = await messageService.sendMessage(
        parseInt(messageData.chatId),
        userId,
        messageData,
        file
      );

      res.status(201).json({
        success: true,
        message: 'Message sent successfully',
        data: {
          message,
        },
      });
    } catch (error) {
      logger.error('Send message controller error:', error);
      next(error);
    }
  }

  async getMessages(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;
      const { page = 1, limit = 50, before, after } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (before) {
        options.before = new Date(before);
      }

      if (after) {
        options.after = new Date(after);
      }

      const messages = await messageService.getMessages(parseInt(chatId), userId, options);

      res.json({
        success: true,
        data: {
          messages,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: messages.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get messages controller error:', error);
      next(error);
    }
  }

  async editMessage(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { content } = req.body;

      if (!content || content.trim().length === 0) {
        throw new AppError('Message content cannot be empty', 400);
      }

      const message = await messageService.editMessage(parseInt(messageId), userId, content);

      res.json({
        success: true,
        message: 'Message edited successfully',
        data: {
          message,
        },
      });
    } catch (error) {
      logger.error('Edit message controller error:', error);
      next(error);
    }
  }

  async deleteMessage(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { deleteForEveryone = false } = req.body;

      await messageService.deleteMessage(parseInt(messageId), userId, deleteForEveryone);

      res.json({
        success: true,
        message: 'Message deleted successfully',
      });
    } catch (error) {
      logger.error('Delete message controller error:', error);
      next(error);
    }
  }

  async forwardMessage(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { chatIds } = req.body;

      if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0) {
        throw new AppError('At least one target chat is required', 400);
      }

      const forwardedMessages = await messageService.forwardMessage(
        parseInt(messageId),
        userId,
        chatIds
      );

      res.json({
        success: true,
        message: 'Message forwarded successfully',
        data: {
          forwardedMessages,
          count: forwardedMessages.length,
        },
      });
    } catch (error) {
      logger.error('Forward message controller error:', error);
      next(error);
    }
  }

  async addReaction(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { reaction } = req.body;

      if (!reaction) {
        throw new AppError('Reaction is required', 400);
      }

      const message = await messageService.addReaction(parseInt(messageId), userId, reaction);

      res.json({
        success: true,
        message: 'Reaction added successfully',
        data: {
          message,
        },
      });
    } catch (error) {
      logger.error('Add reaction controller error:', error);
      next(error);
    }
  }

  async removeReaction(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { reaction } = req.body;

      if (!reaction) {
        throw new AppError('Reaction is required', 400);
      }

      const message = await messageService.removeReaction(parseInt(messageId), userId, reaction);

      res.json({
        success: true,
        message: 'Reaction removed successfully',
        data: {
          message,
        },
      });
    } catch (error) {
      logger.error('Remove reaction controller error:', error);
      next(error);
    }
  }

  async pinMessage(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;

      const message = await messageService.pinMessage(parseInt(messageId), userId);

      res.json({
        success: true,
        message: 'Message pinned successfully',
        data: {
          message,
        },
      });
    } catch (error) {
      logger.error('Pin message controller error:', error);
      next(error);
    }
  }

  async unpinMessage(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;

      const message = await messageService.unpinMessage(parseInt(messageId), userId);

      res.json({
        success: true,
        message: 'Message unpinned successfully',
        data: {
          message,
        },
      });
    } catch (error) {
      logger.error('Unpin message controller error:', error);
      next(error);
    }
  }

  async getPinnedMessages(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      const messages = await messageService.getPinnedMessages(parseInt(chatId), userId);

      res.json({
        success: true,
        data: {
          messages,
          count: messages.length,
        },
      });
    } catch (error) {
      logger.error('Get pinned messages controller error:', error);
      next(error);
    }
  }

  async markAsDelivered(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { deviceId } = req.body;

      await messageService.markAsDelivered(parseInt(messageId), userId, deviceId);

      res.json({
        success: true,
        message: 'Message marked as delivered',
      });
    } catch (error) {
      logger.error('Mark as delivered controller error:', error);
      next(error);
    }
  }

  async markAsRead(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;
      const { deviceId } = req.body;

      const receipt = await messageService.markAsRead(parseInt(messageId), userId, deviceId);

      res.json({
        success: true,
        message: 'Message marked as read',
        data: {
          receipt,
        },
      });
    } catch (error) {
      logger.error('Mark as read controller error:', error);
      next(error);
    }
  }

  async getReadReceipts(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId } = req.params;

      const receipts = await messageService.getReadReceipts(parseInt(messageId), userId);

      res.json({
        success: true,
        data: {
          receipts,
          count: receipts.length,
        },
      });
    } catch (error) {
      logger.error('Get read receipts controller error:', error);
      next(error);
    }
  }

  async searchMessages(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;
      const { query, page = 1, limit = 20 } = req.query;

      if (!query || query.length < 2) {
        throw new AppError('Search query must be at least 2 characters', 400);
      }

      const messages = await messageService.searchMessages(parseInt(chatId), userId, query, {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      });

      res.json({
        success: true,
        data: {
          messages,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: messages.length,
          },
        },
      });
    } catch (error) {
      logger.error('Search messages controller error:', error);
      next(error);
    }
  }
}

module.exports = new MessageController();
