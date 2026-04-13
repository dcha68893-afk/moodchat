const statusService = require('../services/statusService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class StatusController {
  /**
   * Create a new status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async createStatus(req, res, next) {
    try {
      const userId = req.user?.userId || req.user?.id;

      if (!userId) {
        throw new AppError('Authentication required', 401);
      }

      const { content, mediaUrl, mediaType, background, expiresAt, privacy } = req.body;

      if (!content && !mediaUrl) {
        throw new AppError('Content or media is required', 400);
      }

      const statusData = {
        userId,
        content,
        mediaUrl,
        mediaType,
        background,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        privacy: privacy || 'public'
      };

      const status = await statusService.createStatus(statusData);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:created', {
          statusId: status.id,
          userId,
          content: status.content,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Status created successfully',
        data: {
          status
        }
      });
    } catch (error) {
      logger.error('Create status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to create status', 500));
      }
    }
  }

  /**
   * Get status by ID
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getStatusById(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      const status = await statusService.getStatusById(statusId, userId);

      res.status(200).json({
        success: true,
        message: 'Status retrieved successfully',
        data: {
          status
        }
      });
    } catch (error) {
      logger.error('Get status by ID controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to retrieve status', 500));
      }
    }
  }

  /**
   * Update status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const updateData = req.body;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      if (!updateData || typeof updateData !== 'object') {
        throw new AppError('Update data is required', 400);
      }

      const status = await statusService.updateStatus(statusId, userId, updateData);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:updated', {
          statusId,
          userId,
          updates: updateData,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Status updated successfully',
        data: {
          status
        }
      });
    } catch (error) {
      logger.error('Update status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to update status', 500));
      }
    }
  }

  /**
   * Delete status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      await statusService.deleteStatus(statusId, userId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:deleted', {
          statusId,
          userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Status deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to delete status', 500));
      }
    }
  }

  /**
   * Get user's statuses
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getUserStatuses(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        page = 1, 
        limit = 20,
        includeExpired = false
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        includeExpired: includeExpired === 'true'
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getUserStatuses(userId, currentUserId, options);

      res.status(200).json({
        success: true,
        message: 'User statuses retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get user statuses controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get user statuses', 500));
      }
    }
  }

  /**
   * Get timeline statuses
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getTimeline(req, res, next) {
    try {
      const userId = req.user?.userId || req.user?.id;
      const { 
        page = 1, 
        limit = 20,
        onlyFollowing = true
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        onlyFollowing: onlyFollowing === 'true'
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getTimeline(userId, options);

      res.status(200).json({
        success: true,
        message: 'Timeline retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get timeline controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get timeline', 500));
      }
    }
  }

  /**
   * Like a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async likeStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      const like = await statusService.likeStatus(statusId, userId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:liked', {
          statusId,
          userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Status liked successfully',
        data: {
          like,
          liked: true
        }
      });
    } catch (error) {
      logger.error('Like status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already liked')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to like status', 500));
      }
    }
  }

  /**
   * Unlike a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async unlikeStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      await statusService.unlikeStatus(statusId, userId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:unliked', {
          statusId,
          userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Status unliked successfully',
        data: {
          liked: false
        }
      });
    } catch (error) {
      logger.error('Unlike status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('not liked')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to unlike status', 500));
      }
    }
  }

  /**
   * Comment on a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async commentOnStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { content, parentCommentId } = req.body;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      if (!content) {
        throw new AppError('Comment content is required', 400);
      }

      const comment = await statusService.commentOnStatus(statusId, userId, content, parentCommentId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:commented', {
          statusId,
          commentId: comment.id,
          userId,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Comment added successfully',
        data: {
          comment
        }
      });
    } catch (error) {
      logger.error('Comment on status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to add comment', 500));
      }
    }
  }

  /**
   * Get status comments
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getStatusComments(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getStatusComments(statusId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Status comments retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get status comments controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get status comments', 500));
      }
    }
  }

  /**
   * Delete comment
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteComment(req, res, next) {
    try {
      const { statusId, commentId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId || !commentId) {
        throw new AppError('Status ID and Comment ID are required', 400);
      }

      await statusService.deleteComment(statusId, commentId, userId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:comment:deleted', {
          statusId,
          commentId,
          userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Comment deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete comment controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to delete comment', 500));
      }
    }
  }

  /**
   * Share a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async shareStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { caption, privacy } = req.body;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      const share = await statusService.shareStatus(statusId, userId, caption, privacy);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:shared', {
          statusId,
          shareId: share.id,
          userId,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Status shared successfully',
        data: {
          share
        }
      });
    } catch (error) {
      logger.error('Share status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already shared')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to share status', 500));
      }
    }
  }

  /**
   * Get status statistics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getStatusStatistics(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      const statistics = await statusService.getStatusStatistics(statusId, userId);

      res.status(200).json({
        success: true,
        message: 'Status statistics retrieved successfully',
        data: {
          statistics
        }
      });
    } catch (error) {
      logger.error('Get status statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get status statistics', 500));
      }
    }
  }

  /**
   * Report a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async reportStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { reason, description } = req.body;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      if (!reason) {
        throw new AppError('Report reason is required', 400);
      }

      const report = await statusService.reportStatus(statusId, userId, reason, description);

      res.status(201).json({
        success: true,
        message: 'Status reported successfully',
        data: {
          report
        }
      });
    } catch (error) {
      logger.error('Report status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('already reported')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to report status', 500));
      }
    }
  }

  /**
   * Get trending statuses
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getTrendingStatuses(req, res, next) {
    try {
      const userId = req.user?.userId || req.user?.id;
      const { 
        page = 1, 
        limit = 20,
        timeframe = '24h'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        timeframe
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getTrendingStatuses(userId, options);

      res.status(200).json({
        success: true,
        message: 'Trending statuses retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get trending statuses controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get trending statuses', 500));
      }
    }
  }

  /**
   * Pin a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async pinStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      const pinnedStatus = await statusService.pinStatus(statusId, userId);

      res.status(200).json({
        success: true,
        message: 'Status pinned successfully',
        data: {
          pinnedStatus
        }
      });
    } catch (error) {
      logger.error('Pin status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already pinned')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('maximum pinned')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to pin status', 500));
      }
    }
  }

  /**
   * Unpin a status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async unpinStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;

      if (!statusId) {
        throw new AppError('Status ID is required', 400);
      }

      await statusService.unpinStatus(statusId, userId);

      res.status(200).json({
        success: true,
        message: 'Status unpinned successfully',
        data: null
      });
    } catch (error) {
      logger.error('Unpin status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('not pinned')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to unpin status', 500));
      }
    }
  }
}

module.exports = new StatusController();