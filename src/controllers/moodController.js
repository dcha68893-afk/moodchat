const moodService = require('../services/moodService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class MoodController {
  async createMood(req, res, next) {
    try {
      const userId = req.user.id;
      const moodData = req.body;

      const mood = await moodService.createMood(userId, moodData);

      res.status(201).json({
        success: true,
        message: 'Mood created successfully',
        data: {
          mood,
        },
      });
    } catch (error) {
      logger.error('Create mood controller error:', error);
      next(error);
    }
  }

  async getUserMoods(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20, startDate, endDate, mood } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (startDate) {
        options.startDate = new Date(startDate);
      }

      if (endDate) {
        options.endDate = new Date(endDate);
      }

      if (mood) {
        options.mood = mood;
      }

      const moods = await moodService.getUserMoods(userId, options);

      res.json({
        success: true,
        data: {
          moods,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: moods.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get user moods controller error:', error);
      next(error);
    }
  }

  async getPublicMoods(req, res, next) {
    try {
      const { page = 1, limit = 20, userId, mood } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (userId) {
        options.userId = parseInt(userId);
      }

      if (mood) {
        options.mood = mood;
      }

      const moods = await moodService.getPublicMoods(options);

      res.json({
        success: true,
        data: {
          moods,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: moods.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get public moods controller error:', error);
      next(error);
    }
  }

  async updateMood(req, res, next) {
    try {
      const userId = req.user.id;
      const { moodId } = req.params;
      const updateData = req.body;

      const mood = await moodService.updateMood(parseInt(moodId), userId, updateData);

      res.json({
        success: true,
        message: 'Mood updated successfully',
        data: {
          mood,
        },
      });
    } catch (error) {
      logger.error('Update mood controller error:', error);
      next(error);
    }
  }

  async deleteMood(req, res, next) {
    try {
      const userId = req.user.id;
      const { moodId } = req.params;

      await moodService.deleteMood(parseInt(moodId), userId);

      res.json({
        success: true,
        message: 'Mood deleted successfully',
      });
    } catch (error) {
      logger.error('Delete mood controller error:', error);
      next(error);
    }
  }

  async shareMoodWithFriend(req, res, next) {
    try {
      const userId = req.user.id;
      const { moodId } = req.params;
      const { friendId } = req.body;

      const sharedMood = await moodService.shareMoodWithFriend(
        parseInt(moodId),
        userId,
        parseInt(friendId)
      );

      res.status(201).json({
        success: true,
        message: 'Mood shared successfully',
        data: {
          sharedMood,
        },
      });
    } catch (error) {
      logger.error('Share mood controller error:', error);
      next(error);
    }
  }

  async getSharedMoods(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20, unreadOnly } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (unreadOnly === 'true') {
        options.where = { isViewed: false };
      }

      const sharedMoods = await moodService.getSharedMoods(userId, options);

      res.json({
        success: true,
        data: {
          sharedMoods,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: sharedMoods.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get shared moods controller error:', error);
      next(error);
    }
  }

  async markSharedMoodAsViewed(req, res, next) {
    try {
      const userId = req.user.id;
      const { sharedMoodId } = req.params;

      const sharedMood = await moodService.markSharedMoodAsViewed(parseInt(sharedMoodId), userId);

      res.json({
        success: true,
        message: 'Shared mood marked as viewed',
        data: {
          sharedMood,
        },
      });
    } catch (error) {
      logger.error('Mark shared mood as viewed controller error:', error);
      next(error);
    }
  }

  async getMoodStats(req, res, next) {
    try {
      const userId = req.user.id;
      const { days = 30 } = req.query;

      const stats = await moodService.getMoodStats(userId, parseInt(days));

      res.json({
        success: true,
        data: {
          stats,
        },
      });
    } catch (error) {
      logger.error('Get mood stats controller error:', error);
      next(error);
    }
  }

  async getMoodTrend(req, res, next) {
    try {
      const userId = req.user.id;
      const { days = 7 } = req.query;

      const trend = await moodService.getMoodTrend(userId, parseInt(days));

      res.json({
        success: true,
        data: {
          trend,
        },
      });
    } catch (error) {
      logger.error('Get mood trend controller error:', error);
      next(error);
    }
  }

  async getMoodById(req, res, next) {
    try {
      const userId = req.user.id;
      const { moodId } = req.params;

      const mood = await moodService.getMood(parseInt(moodId));

      // Check if user can view this mood
      if (mood.userId !== userId && !mood.isPublic) {
        throw new AppError('Not authorized to view this mood', 403);
      }

      res.json({
        success: true,
        data: {
          mood,
        },
      });
    } catch (error) {
      logger.error('Get mood by ID controller error:', error);
      next(error);
    }
  }
}

module.exports = new MoodController();
