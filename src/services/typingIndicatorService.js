const typingIndicatorService = require('../services/typingIndicatorService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class TypingIndicatorController {
  /**
   * Start typing indicator
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async startTyping(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId, messageType = 'text' } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const typingIndicator = await typingIndicatorService.startTyping(userId, chatId, messageType);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('typing:started', {
          userId,
          chatId,
          messageType,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Typing indicator started',
        data: {
          typingIndicator
        }
      });
    } catch (error) {
      logger.error('Start typing controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to start typing indicator', 500));
      }
    }
  }

  /**
   * Stop typing indicator
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async stopTyping(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const typingIndicator = await typingIndicatorService.stopTyping(userId, chatId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('typing:stopped', {
          userId,
          chatId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Typing indicator stopped',
        data: {
          typingIndicator
        }
      });
    } catch (error) {
      logger.error('Stop typing controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to stop typing indicator', 500));
      }
    }
  }

  /**
   * Get typing status for a chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getTypingStatus(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const typingStatus = await typingIndicatorService.getChatTypingStatus(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Typing status retrieved successfully',
        data: {
          chatId,
          typingUsers: typingStatus,
          count: typingStatus.length
        }
      });
    } catch (error) {
      logger.error('Get typing status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get typing status', 500));
      }
    }
  }

  /**
   * Get user's typing status across all chats
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getUserTypingStatus(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Users can only check their own typing status or if they have permission
      if (userId !== currentUserId.toString() && !req.user.isAdmin) {
        throw new AppError('Not authorized to view this user\'s typing status', 403);
      }

      const typingStatus = await typingIndicatorService.getUserTypingStatus(userId);

      res.status(200).json({
        success: true,
        message: 'User typing status retrieved successfully',
        data: {
          userId,
          isTypingAnywhere: typingStatus.length > 0,
          activeChats: typingStatus,
          count: typingStatus.length
        }
      });
    } catch (error) {
      logger.error('Get user typing status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get user typing status', 500));
      }
    }
  }

  /**
   * Cleanup expired typing indicators
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async cleanupTypingIndicators(req, res, next) {
    try {
      // Only admins or system can cleanup
      if (!req.user.isAdmin) {
        throw new AppError('Not authorized to perform cleanup', 403);
      }

      const result = await typingIndicatorService.cleanupExpiredIndicators();

      res.status(200).json({
        success: true,
        message: 'Typing indicators cleanup completed',
        data: {
          cleanedCount: result.cleanedCount,
          remainingCount: result.remainingCount,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error('Cleanup typing indicators controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to cleanup typing indicators', 500));
      }
    }
  }

  /**
   * Handle typing WebSocket events
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async handleTypingWebSocket(req, res, next) {
    try {
      const userId = req.user.id;
      const { action, chatId, messageType } = req.body;

      if (!action || !chatId) {
        throw new AppError('Action and Chat ID are required', 400);
      }

      if (!['start', 'stop'].includes(action)) {
        throw new AppError('Invalid action. Use "start" or "stop"', 400);
      }

      let typingIndicator;
      if (action === 'start') {
        typingIndicator = await typingIndicatorService.startTyping(userId, chatId, messageType);
      } else {
        typingIndicator = await typingIndicatorService.stopTyping(userId, chatId);
      }

      // Broadcast to all users in the chat room
      if (req.io) {
        const eventName = action === 'start' ? 'typing:started' : 'typing:stopped';
        req.io.to(`chat:${chatId}`).emit(eventName, {
          userId,
          chatId,
          messageType: action === 'start' ? messageType : undefined,
          timestamp: new Date(),
          action
        });
      }

      res.status(200).json({
        success: true,
        message: `Typing ${action}ed via WebSocket`,
        data: {
          typingIndicator,
          action
        }
      });
    } catch (error) {
      logger.error('Typing WebSocket controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to handle typing WebSocket event', 500));
      }
    }
  }
}

module.exports = new TypingIndicatorController();