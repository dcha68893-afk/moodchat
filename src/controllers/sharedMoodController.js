const sharedMoodService = require('../services/sharedMoodService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class SharedMoodController {
  /**
   * Share a mood
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async shareMood(req, res, next) {
    try {
      const userId = req.user.id;
      const { emotion, intensity, description, tags, location, weather, privacy } = req.body;

      if (!emotion) {
        throw new AppError('Emotion is required', 400);
      }

      if (intensity && (intensity < 1 || intensity > 10)) {
        throw new AppError('Intensity must be between 1 and 10', 400);
      }

      const moodData = {
        userId,
        emotion,
        intensity: intensity || 5,
        description,
        tags: tags || [],
        location,
        weather,
        privacy: privacy || 'friends'
      };

      const mood = await sharedMoodService.shareMood(moodData);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('mood:shared', {
          moodId: mood.id,
          userId,
          emotion: mood.emotion,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Mood shared successfully',
        data: {
          mood
        }
      });
    } catch (error) {
      logger.error('Share mood controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to share mood', 500));
      }
    }
  }

  /**
   * Get user's mood history
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMoodHistory(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        page = 1, 
        limit = 30,
        startDate,
        endDate,
        emotion,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Check permission
      if (userId !== currentUserId.toString()) {
        // Check if users are friends or if mood is public
        const canView = await sharedMoodService.canViewUserMoods(userId, currentUserId);
        if (!canView) {
          throw new AppError('Not authorized to view this user\'s mood history', 403);
        }
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        emotion,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await sharedMoodService.getMoodHistory(userId, currentUserId, options);

      res.status(200).json({
        success: true,
        message: 'Mood history retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get mood history controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get mood history', 500));
      }
    }
  }

  /**
   * Get current mood of a user
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getCurrentMood(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Check permission
      if (userId !== currentUserId.toString()) {
        const canView = await sharedMoodService.canViewUserMoods(userId, currentUserId);
        if (!canView) {
          throw new AppError('Not authorized to view this user\'s current mood', 403);
        }
      }

      const currentMood = await sharedMoodService.getCurrentMood(userId);

      res.status(200).json({
        success: true,
        message: 'Current mood retrieved successfully',
        data: {
          currentMood,
          hasCurrentMood: !!currentMood
        }
      });
    } catch (error) {
      logger.error('Get current mood controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get current mood', 500));
      }
    }
  }

  /**
   * Get mood insights
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMoodInsights(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        timeframe = '30d',
        compareWith = null
      } = req.query;

      const insights = await sharedMoodService.getMoodInsights(userId, timeframe, compareWith);

      res.status(200).json({
        success: true,
        message: 'Mood insights retrieved successfully',
        data: {
          insights,
          timeframe
        }
      });
    } catch (error) {
      logger.error('Get mood insights controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get mood insights', 500));
      }
    }
  }

  /**
   * React to a mood
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async reactToMood(req, res, next) {
    try {
      const { moodId } = req.params;
      const userId = req.user.id;
      const { reaction, emoji } = req.body;

      if (!moodId) {
        throw new AppError('Mood ID is required', 400);
      }

      if (!reaction && !emoji) {
        throw new AppError('Reaction or emoji is required', 400);
      }

      const reactionData = await sharedMoodService.reactToMood(moodId, userId, {
        reaction,
        emoji
      });

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('mood:reacted', {
          moodId,
          userId,
          reaction: reaction || emoji,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Reaction added successfully',
        data: {
          reaction: reactionData
        }
      });
    } catch (error) {
      logger.error('React to mood controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already reacted')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to react to mood', 500));
      }
    }
  }

  /**
   * Comment on a mood
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async commentOnMood(req, res, next) {
    try {
      const { moodId } = req.params;
      const userId = req.user.id;
      const { content, parentCommentId } = req.body;

      if (!moodId) {
        throw new AppError('Mood ID is required', 400);
      }

      if (!content) {
        throw new AppError('Comment content is required', 400);
      }

      const comment = await sharedMoodService.commentOnMood(moodId, userId, content, parentCommentId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('mood:commented', {
          moodId,
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
      logger.error('Comment on mood controller error:', error);
      
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
   * Get mood comments
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMoodComments(req, res, next) {
    try {
      const { moodId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      if (!moodId) {
        throw new AppError('Mood ID is required', 400);
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

      const result = await sharedMoodService.getMoodComments(moodId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Mood comments retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get mood comments controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get mood comments', 500));
      }
    }
  }

  /**
   * Delete a mood
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteMood(req, res, next) {
    try {
      const { moodId } = req.params;
      const userId = req.user.id;

      if (!moodId) {
        throw new AppError('Mood ID is required', 400);
      }

      await sharedMoodService.deleteMood(moodId, userId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('mood:deleted', {
          moodId,
          userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Mood deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete mood controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to delete mood', 500));
      }
    }
  }

  /**
   * Get mood statistics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMoodStatistics(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { timeframe = 'all' } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Check permission
      if (userId !== currentUserId.toString()) {
        const canView = await sharedMoodService.canViewUserMoods(userId, currentUserId);
        if (!canView) {
          throw new AppError('Not authorized to view this user\'s mood statistics', 403);
        }
      }

      const statistics = await sharedMoodService.getMoodStatistics(userId, timeframe);

      res.status(200).json({
        success: true,
        message: 'Mood statistics retrieved successfully',
        data: {
          statistics,
          timeframe
        }
      });
    } catch (error) {
      logger.error('Get mood statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get mood statistics', 500));
      }
    }
  }

  /**
   * Get shared moods feed
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMoodFeed(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 20,
        emotion,
        friendsOnly = true,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        emotion,
        friendsOnly: friendsOnly === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await sharedMoodService.getMoodFeed(userId, options);

      res.status(200).json({
        success: true,
        message: 'Mood feed retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get mood feed controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get mood feed', 500));
      }
    }
  }

  /**
   * Set mood privacy
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async setMoodPrivacy(req, res, next) {
    try {
      const { moodId } = req.params;
      const userId = req.user.id;
      const { privacy } = req.body;

      if (!moodId) {
        throw new AppError('Mood ID is required', 400);
      }

      if (!privacy) {
        throw new AppError('Privacy setting is required', 400);
      }

      const validPrivacySettings = ['public', 'friends', 'private'];
      if (!validPrivacySettings.includes(privacy)) {
        throw new AppError(`Invalid privacy setting. Valid values: ${validPrivacySettings.join(', ')}`, 400);
      }

      const mood = await sharedMoodService.setMoodPrivacy(moodId, userId, privacy);

      res.status(200).json({
        success: true,
        message: 'Mood privacy updated successfully',
        data: {
          mood
        }
      });
    } catch (error) {
      logger.error('Set mood privacy controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to set mood privacy', 500));
      }
    }
  }

  /**
   * Search moods by emotion
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async searchMoodsByEmotion(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        emotion,
        page = 1, 
        limit = 20,
        minIntensity,
        maxIntensity,
        startDate,
        endDate
      } = req.query;

      if (!emotion) {
        throw new AppError('Emotion is required for search', 400);
      }

      const options = {
        emotion,
        page: parseInt(page),
        limit: parseInt(limit),
        minIntensity: minIntensity ? parseInt(minIntensity) : null,
        maxIntensity: maxIntensity ? parseInt(maxIntensity) : null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await sharedMoodService.searchMoodsByEmotion(userId, options);

      res.status(200).json({
        success: true,
        message: `Moods with emotion "${emotion}" retrieved successfully`,
        data: result
      });
    } catch (error) {
      logger.error('Search moods by emotion controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to search moods by emotion', 500));
      }
    }
  }

  /**
   * Get mood trends
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMoodTrends(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        timeframe = '30d',
        groupBy = 'day',
        compareWith = null
      } = req.query;

      const trends = await sharedMoodService.getMoodTrends(userId, timeframe, groupBy, compareWith);

      res.status(200).json({
        success: true,
        message: 'Mood trends retrieved successfully',
        data: {
          trends,
          timeframe,
          groupBy
        }
      });
    } catch (error) {
      logger.error('Get mood trends controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get mood trends', 500));
      }
    }
  }

  /**
   * Export mood data
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async exportMoodData(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        format = 'json',
        startDate,
        endDate,
        includeReactions = true,
        includeComments = false
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Users can only export their own data
      if (userId !== currentUserId.toString()) {
        throw new AppError('Not authorized to export this user\'s mood data', 403);
      }

      const exportData = await sharedMoodService.exportMoodData(userId, {
        format,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        includeReactions: includeReactions === 'true',
        includeComments: includeComments === 'true'
      });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=mood_data_${userId}_${new Date().toISOString().split('T')[0]}.csv`);
        return res.send(exportData);
      } else if (format === 'json') {
        res.status(200).json({
          success: true,
          message: 'Mood data exported successfully',
          data: exportData
        });
      } else {
        throw new AppError('Invalid export format. Use "json" or "csv"', 400);
      }
    } catch (error) {
      logger.error('Export mood data controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to export mood data', 500));
      }
    }
  }
}

module.exports = new SharedMoodController();