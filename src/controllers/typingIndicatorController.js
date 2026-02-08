// src/controllers/typingIndicatorController.js
const typingIndicatorService = require('../services/typingIndicatorService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class TypingIndicatorController {
  /**
   * Start typing indicator
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async startTyping(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId, messageType = 'text' } = req.body;

      // Validate required fields
      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const typingData = await typingIndicatorService.startTyping(
        parseInt(userId),
        parseInt(chatId),
        messageType
      );

      res.status(201).json({
        success: true,
        message: 'Typing indicator started',
        data: {
          typingIndicator: typingData,
        },
      });
    } catch (error) {
      logger.error('Start typing controller error:', error);
      next(error);
    }
  }

  /**
   * Stop typing indicator
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async stopTyping(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.body;

      // Validate required fields
      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const result = await typingIndicatorService.stopTyping(
        parseInt(userId),
        parseInt(chatId)
      );

      res.json({
        success: true,
        message: 'Typing indicator stopped',
        data: result,
      });
    } catch (error) {
      logger.error('Stop typing controller error:', error);
      next(error);
    }
  }

  /**
   * Get active typing indicators for a chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async getActiveTyping(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;

      // Validate required fields
      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const typingIndicators = await typingIndicatorService.getActiveTypingIndicators(
        parseInt(chatId)
      );

      res.json({
        success: true,
        data: {
          typingIndicators,
          count: typingIndicators.length,
        },
      });
    } catch (error) {
      logger.error('Get active typing controller error:', error);
      next(error);
    }
  }

  /**
   * Get typing status for multiple chats
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async getTypingStatus(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatIds } = req.body;

      // Validate required fields
      if (!chatIds || !Array.isArray(chatIds)) {
        throw new AppError('Chat IDs array is required', 400);
      }

      if (chatIds.length === 0) {
        return res.json({
          success: true,
          data: {
            typingStatus: [],
          },
        });
      }

      const chatIdsInt = chatIds.map(id => parseInt(id));
      const typingStatus = await typingIndicatorService.getTypingStatusForChats(chatIdsInt);

      res.json({
        success: true,
        data: {
          typingStatus,
        },
      });
    } catch (error) {
      logger.error('Get typing status controller error:', error);
      next(error);
    }
  }

  /**
   * Get user typing status (router contract requirement)
   * Bridges to getUserTypingActivity for backward compatibility
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async getUserTypingStatus(req, res, next) {
    try {
      const userId = req.user.id;
      const { limit = 20, page = 1 } = req.query;

      logger.info(`getUserTypingStatus called by user ${userId}`, {
        userId,
        limit,
        page
      });

      // Reuse existing getUserTypingActivity method
      const options = {
        limit: parseInt(limit),
        offset: (page - 1) * parseInt(limit),
      };

      const activity = await typingIndicatorService.getUserTypingActivity(
        parseInt(userId),
        options
      );

      res.json({
        success: true,
        data: {
          typingStatus: activity.records,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: activity.total,
            totalPages: Math.ceil(activity.total / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      logger.error('Get user typing status controller error:', error);
      next(error);
    }
  }

  /**
   * Cleanup typing indicators (router contract requirement)
   * Bridges to clearExpiredTyping for backward compatibility
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async cleanupTypingIndicators(req, res, next) {
    try {
      const userId = req.user.id;
      
      logger.info(`cleanupTypingIndicators called by user ${userId}`, {
        userId
      });

      // Reuse existing clearExpiredIndicators method
      const result = await typingIndicatorService.clearExpiredIndicators();

      res.json({
        success: true,
        message: 'Typing indicators cleaned up',
        data: {
          clearedCount: result.clearedCount,
          remainingActive: result.remainingActive,
        },
      });
    } catch (error) {
      logger.error('Cleanup typing indicators controller error:', error);
      next(error);
    }
  }

  /**
   * Handle typing WebSocket (router contract requirement)
   * Safe fallback when WebSocket infrastructure is unavailable
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async handleTypingWebSocket(req, res, next) {
    try {
      const userId = req.user?.id || 'unknown';
      
      // One-time warning log
      if (!this._websocketWarningLogged) {
        logger.warn('WebSocket handler called but WebSocket infrastructure may be unavailable', {
          userId,
          timestamp: new Date().toISOString()
        });
        this._websocketWarningLogged = true;
      }

      logger.info(`handleTypingWebSocket called by user ${userId}`, {
        userId,
        method: req.method,
        path: req.path
      });

      // Return 501 Not Implemented with graceful degradation
      res.status(501).json({
        success: false,
        message: 'WebSocket functionality is currently unavailable',
        data: {
          fallbackAvailable: true,
          httpAlternatives: [
            { method: 'POST', path: '/api/typing/start', description: 'Start typing indicator' },
            { method: 'POST', path: '/api/typing/stop', description: 'Stop typing indicator' }
          ],
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      // Never throw during WebSocket handling
      logger.error('WebSocket handler error (non-critical):', {
        error: error.message,
        userId: req.user?.id || 'unknown'
      });
      
      // Still return a controlled response
      res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable',
        data: {
          retryAfter: 30,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * Clear expired typing indicators (admin/maintenance)
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async clearExpiredTyping(req, res, next) {
    try {
      const userId = req.user.id;
      
      // Optional: Add admin check
      // if (!req.user.isAdmin) {
      //   throw new AppError('Not authorized', 403);
      // }

      const result = await typingIndicatorService.clearExpiredIndicators();

      res.json({
        success: true,
        message: 'Expired typing indicators cleared',
        data: {
          clearedCount: result.clearedCount,
          remainingActive: result.remainingActive,
        },
      });
    } catch (error) {
      logger.error('Clear expired typing controller error:', error);
      next(error);
    }
  }

  /**
   * Get user's typing activity across chats
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async getUserTypingActivity(req, res, next) {
    try {
      const userId = req.user.id;
      const { limit = 20, page = 1 } = req.query;

      const options = {
        limit: parseInt(limit),
        offset: (page - 1) * parseInt(limit),
      };

      const activity = await typingIndicatorService.getUserTypingActivity(
        parseInt(userId),
        options
      );

      res.json({
        success: true,
        data: {
          activity: activity.records,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: activity.total,
            totalPages: Math.ceil(activity.total / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      logger.error('Get user typing activity controller error:', error);
      next(error);
    }
  }

  /**
   * Bulk update typing indicators (for batch operations)
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async bulkUpdateTyping(req, res, next) {
    try {
      const userId = req.user.id;
      const { updates } = req.body;

      // Validate required fields
      if (!updates || !Array.isArray(updates)) {
        throw new AppError('Updates array is required', 400);
      }

      // Validate each update
      const validUpdates = updates.every(update => 
        update.userId && update.chatId && update.action
      );

      if (!validUpdates) {
        throw new AppError('Each update must have userId, chatId, and action', 400);
      }

      const results = await typingIndicatorService.bulkUpdateTypingIndicators(updates);

      res.json({
        success: true,
        message: 'Bulk typing updates processed',
        data: {
          processed: results.processed,
          succeeded: results.succeeded,
          failed: results.failed,
          failures: results.failures,
        },
      });
    } catch (error) {
      logger.error('Bulk update typing controller error:', error);
      next(error);
    }
  }

  /**
   * Get typing statistics for analytics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async getTypingStats(req, res, next) {
    try {
      const userId = req.user.id;
      const { startDate, endDate, chatId } = req.query;

      // Optional: Add admin check
      // if (!req.user.isAdmin) {
      //   throw new AppError('Not authorized', 403);
      // }

      const stats = await typingIndicatorService.getTypingStatistics({
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        chatId: chatId ? parseInt(chatId) : null,
      });

      res.json({
        success: true,
        data: {
          stats,
        },
      });
    } catch (error) {
      logger.error('Get typing stats controller error:', error);
      next(error);
    }
  }
}

// Initialize singleton instance
const controllerInstance = new TypingIndicatorController();

// Add one-time logging control
controllerInstance._websocketWarningLogged = false;

module.exports = controllerInstance;