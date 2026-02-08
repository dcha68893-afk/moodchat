const readReceiptService = require('../services/readReceiptService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class ReadReceiptController {
  /**
   * Mark message as read
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async markAsRead(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageId, chatId, readAt } = req.body;

      if (!messageId) {
        throw new AppError('Message ID is required', 400);
      }

      const readReceipt = await readReceiptService.markAsRead({
        userId,
        messageId,
        chatId,
        readAt: readAt ? new Date(readAt) : new Date()
      });

      // Emit WebSocket event for real-time updates
      if (req.io) {
        if (chatId) {
          req.io.to(`chat:${chatId}`).emit('message:read', {
            messageId,
            userId,
            readAt: readReceipt.readAt,
            timestamp: new Date()
          });
        }
        
        // Also emit to the message sender if different from reader
        req.io.emit('read:receipt:created', {
          messageId,
          readerId: userId,
          readAt: readReceipt.readAt
        });
      }

      res.status(200).json({
        success: true,
        message: 'Message marked as read',
        data: {
          readReceipt
        }
      });
    } catch (error) {
      logger.error('Mark as read controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already read')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to mark message as read', 500));
      }
    }
  }

  /**
   * Mark multiple messages as read
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async markMultipleAsRead(req, res, next) {
    try {
      const userId = req.user.id;
      const { messageIds, chatId } = req.body;

      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        throw new AppError('Message IDs array is required', 400);
      }

      // Limit the number of messages to prevent abuse
      if (messageIds.length > 100) {
        throw new AppError('Maximum 100 messages allowed per request', 400);
      }

      const readReceipts = await readReceiptService.markMultipleAsRead(userId, messageIds, chatId);

      // Emit WebSocket events for real-time updates
      if (req.io && chatId) {
        req.io.to(`chat:${chatId}`).emit('messages:read:bulk', {
          messageIds,
          userId,
          count: readReceipts.length,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: `${readReceipts.length} message(s) marked as read`,
        data: {
          readReceipts,
          count: readReceipts.length
        }
      });
    } catch (error) {
      logger.error('Mark multiple as read controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to mark messages as read', 500));
      }
    }
  }

  /**
   * Get read status of a message
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMessageReadStatus(req, res, next) {
    try {
      const { messageId } = req.params;
      const userId = req.user.id;

      if (!messageId) {
        throw new AppError('Message ID is required', 400);
      }

      const readStatus = await readReceiptService.getMessageReadStatus(messageId, userId);

      res.status(200).json({
        success: true,
        message: 'Message read status retrieved successfully',
        data: {
          messageId,
          readStatus,
          isReadByCurrentUser: readStatus.readBy.some(r => r.userId.toString() === userId),
          readCount: readStatus.readBy.length,
          unreadCount: readStatus.unreadCount
        }
      });
    } catch (error) {
      logger.error('Get message read status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get message read status', 500));
      }
    }
  }

  /**
   * Get unread messages count
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getUnreadCount(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId, since } = req.query;

      const unreadCount = await readReceiptService.getUnreadCount(userId, {
        chatId,
        since: since ? new Date(since) : null
      });

      res.status(200).json({
        success: true,
        message: 'Unread messages count retrieved successfully',
        data: {
          unreadCount,
          chatId,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error('Get unread count controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get unread messages count', 500));
      }
    }
  }

  /**
   * Get chat read status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getChatReadStatus(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const readStatus = await readReceiptService.getChatReadStatus(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Chat read status retrieved successfully',
        data: {
          chatId,
          readStatus,
          lastReadMessage: readStatus.lastReadMessage,
          unreadMessages: readStatus.unreadMessages,
          readPercentage: readStatus.readPercentage
        }
      });
    } catch (error) {
      logger.error('Get chat read status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get chat read status', 500));
      }
    }
  }

  /**
   * Get user's read receipts
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getUserReceipts(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        chatId,
        startDate,
        endDate,
        sortBy = 'readAt',
        sortOrder = 'desc'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        chatId,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await readReceiptService.getUserReceipts(userId, options);

      res.status(200).json({
        success: true,
        message: 'User read receipts retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get user receipts controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get user read receipts', 500));
      }
    }
  }

  /**
   * Mark all messages as read in a chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async markAllAsReadInChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { before } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const result = await readReceiptService.markAllAsReadInChat(chatId, userId, {
        before: before ? new Date(before) : null
      });

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('chat:all:read', {
          chatId,
          userId,
          count: result.markedCount,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: `Marked ${result.markedCount} message(s) as read in chat`,
        data: {
          ...result,
          chatId
        }
      });
    } catch (error) {
      logger.error('Mark all as read in chat controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to mark all messages as read', 500));
      }
    }
  }

  /**
   * Delete read receipt
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const userId = req.user.id;

      if (!receiptId) {
        throw new AppError('Receipt ID is required', 400);
      }

      await readReceiptService.deleteReceipt(receiptId, userId);

      res.status(200).json({
        success: true,
        message: 'Read receipt deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete receipt controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to delete read receipt', 500));
      }
    }
  }

  /**
   * Sync read receipts
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async syncReadReceipts(req, res, next) {
    try {
      const userId = req.user.id;
      const { receipts, deviceId, lastSyncAt } = req.body;

      if (!Array.isArray(receipts)) {
        throw new AppError('Receipts array is required', 400);
      }

      const syncResult = await readReceiptService.syncReadReceipts(userId, {
        receipts,
        deviceId,
        lastSyncAt: lastSyncAt ? new Date(lastSyncAt) : null
      });

      res.status(200).json({
        success: true,
        message: 'Read receipts synced successfully',
        data: {
          ...syncResult,
          deviceId
        }
      });
    } catch (error) {
      logger.error('Sync read receipts controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to sync read receipts', 500));
      }
    }
  }

  /**
   * Get read statistics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getReadStatistics(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { 
        timeframe = '7d',
        groupBy = 'day'
      } = req.query;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const statistics = await readReceiptService.getReadStatistics(chatId, userId, {
        timeframe,
        groupBy
      });

      res.status(200).json({
        success: true,
        message: 'Read statistics retrieved successfully',
        data: {
          statistics,
          chatId,
          timeframe,
          groupBy
        }
      });
    } catch (error) {
      logger.error('Get read statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get read statistics', 500));
      }
    }
  }

  /**
   * Handle read WebSocket events
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async handleReadWebSocket(req, res, next) {
    try {
      const userId = req.user.id;
      const { action, data } = req.body;

      if (!action) {
        throw new AppError('Action is required', 400);
      }

      let result;
      switch (action) {
        case 'markRead':
          result = await readReceiptService.markAsRead({
            userId,
            ...data
          });
          break;
        case 'markAllRead':
          result = await readReceiptService.markAllAsReadInChat(data.chatId, userId, data.options);
          break;
        case 'getStatus':
          result = await readReceiptService.getMessageReadStatus(data.messageId, userId);
          break;
        default:
          throw new AppError(`Invalid action: ${action}`, 400);
      }

      // Broadcast read update to all connected clients in the chat
      if (req.io && data.chatId) {
        req.io.to(`chat:${data.chatId}`).emit('read:ws:update', {
          userId,
          action,
          data: result,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: `Read action "${action}" completed via WebSocket`,
        data: {
          result,
          action
        }
      });
    } catch (error) {
      logger.error('Read WebSocket controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to handle read WebSocket event', 500));
      }
    }
  }
}

module.exports = new ReadReceiptController();