const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const {
  NotFoundError,
  ValidationError,
  AuthorizationError,
} = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { Mood, SharedMood, User } = require('../models');

router.use(authenticate);

console.log('✅ Moods routes initialized');

// Create mood
router.post(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { mood, intensity, description, isPublic = false, tags } = req.body;

      if (!mood) {
        throw new ValidationError('Mood is required');
      }

      const validMoods = ['happy', 'sad', 'angry', 'anxious', 'excited', 'calm', 'tired', 'neutral'];
      if (!validMoods.includes(mood.toLowerCase())) {
        throw new ValidationError(`Mood must be one of: ${validMoods.join(', ')}`);
      }

      if (intensity && (intensity < 1 || intensity > 10)) {
        throw new ValidationError('Intensity must be between 1 and 10');
      }

      const moodEntry = await Mood.create({
        userId: req.user.id,
        mood: mood.toLowerCase(),
        intensity: intensity || 5,
        description: description || null,
        isPublic: isPublic,
        tags: tags ? tags.split(',').map(tag => tag.trim()) : [],
        metadata: {
          createdAt: new Date(),
          createdBy: {
            id: req.user.id,
            username: req.user.username,
          },
        }
      });

      res.status(201).json({
        status: 'success',
        message: 'Mood recorded successfully',
        data: { mood: moodEntry },
      });
    } catch (error) {
      console.error('Error creating mood:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to record mood'
      });
    }
  })
);

// Get user's moods
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20, startDate, endDate, mood, sortBy = 'createdAt', sortOrder = 'DESC' } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { userId: req.user.id };

      if (startDate) {
        where.createdAt = { [require('sequelize').Op.gte]: new Date(startDate) };
      }

      if (endDate) {
        where.createdAt = { [require('sequelize').Op.lte]: new Date(endDate) };
      }

      if (mood) {
        where.mood = mood.toLowerCase();
      }

      const { count, rows: moods } = await Mood.findAndCountAll({
        where,
        order: [[sortBy, sortOrder]],
        offset,
        limit: parseInt(limit),
        include: [{
          model: User,
          as: 'moodUser',
          attributes: ['id', 'username', 'avatar']
        }]
      });

      res.status(200).json({
        status: 'success',
        data: {
          moods,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching moods:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch moods'
      });
    }
  })
);

// Get public moods
router.get(
  '/public',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { count, rows: moods } = await Mood.findAndCountAll({
        where: {
          isPublic: true,
          userId: { [require('sequelize').Op.ne]: req.user.id }
        },
        order: [['createdAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        include: [{
          model: User,
          as: 'moodUser',
          attributes: ['id', 'username', 'avatar', 'displayName']
        }]
      });

      res.status(200).json({
        status: 'success',
        data: {
          moods,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching public moods:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch public moods'
      });
    }
  })
);

// Get mood by ID
router.get(
  '/:moodId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { moodId } = req.params;

      const mood = await Mood.findOne({
        where: {
          id: moodId,
          [require('sequelize').Op.or]: [
            { userId: req.user.id },
            { isPublic: true }
          ]
        },
        include: [{
          model: User,
          as: 'moodUser',
          attributes: ['id', 'username', 'avatar', 'displayName']
        }]
      });

      if (!mood) {
        throw new NotFoundError('Mood not found or access denied');
      }

      res.status(200).json({
        status: 'success',
        data: { mood },
      });
    } catch (error) {
      console.error('Error fetching mood:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to fetch mood'
      });
    }
  })
);

// Update mood
router.put(
  '/:moodId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { moodId } = req.params;
      const { mood, intensity, description, isPublic, tags } = req.body;

      const moodEntry = await Mood.findOne({
        where: {
          id: moodId,
          userId: req.user.id
        }
      });

      if (!moodEntry) {
        throw new NotFoundError('Mood not found or not authorized');
      }

      const updates = {};
      if (mood) {
        const validMoods = ['happy', 'sad', 'angry', 'anxious', 'excited', 'calm', 'tired', 'neutral'];
        if (!validMoods.includes(mood.toLowerCase())) {
          throw new ValidationError(`Mood must be one of: ${validMoods.join(', ')}`);
        }
        updates.mood = mood.toLowerCase();
      }
      
      if (intensity !== undefined) {
        if (intensity < 1 || intensity > 10) {
          throw new ValidationError('Intensity must be between 1 and 10');
        }
        updates.intensity = intensity;
      }
      
      if (description !== undefined) updates.description = description;
      if (isPublic !== undefined) updates.isPublic = isPublic;
      if (tags !== undefined) updates.tags = tags.split(',').map(tag => tag.trim());

      await moodEntry.update(updates);

      res.status(200).json({
        status: 'success',
        message: 'Mood updated successfully',
        data: { mood: moodEntry },
      });
    } catch (error) {
      console.error('Error updating mood:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to update mood'
      });
    }
  })
);

// Delete mood
router.delete(
  '/:moodId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { moodId } = req.params;

      const mood = await Mood.findOne({
        where: {
          id: moodId,
          userId: req.user.id
        }
      });

      if (!mood) {
        throw new NotFoundError('Mood not found or not authorized');
      }

      await mood.destroy();

      res.status(200).json({
        status: 'success',
        message: 'Mood deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting mood:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to delete mood'
      });
    }
  })
);

// Share mood with friend
router.post(
  '/:moodId/share',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { moodId } = req.params;
      const { friendId } = req.body;

      if (!friendId) {
        throw new ValidationError('Friend ID is required');
      }

      const mood = await Mood.findOne({
        where: {
          id: moodId,
          userId: req.user.id
        }
      });

      if (!mood) {
        throw new NotFoundError('Mood not found or not authorized');
      }

      const friend = await User.findByPk(friendId);
      if (!friend) {
        throw new NotFoundError('Friend not found');
      }

      const existingShare = await SharedMood.findOne({
        where: {
          moodId: moodId,
          userId: req.user.id,
          sharedWithId: friendId
        }
      });

      if (existingShare) {
        throw new ValidationError('Mood already shared with this friend');
      }

      const sharedMood = await SharedMood.create({
        moodId: moodId,
        userId: req.user.id,
        sharedWithId: friendId,
        sharedAt: new Date(),
        isViewed: false
      });

      if (req.io && friend.socketIds && friend.socketIds.length > 0) {
        friend.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('mood:shared', {
            moodId: mood.id,
            mood: mood.mood,
            intensity: mood.intensity,
            description: mood.description,
            sharedBy: {
              id: req.user.id,
              username: req.user.username,
              avatar: req.user.avatar,
            },
            sharedAt: sharedMood.sharedAt,
          });
        });
      }

      res.status(201).json({
        status: 'success',
        message: 'Mood shared successfully',
        data: { sharedMood },
      });
    } catch (error) {
      console.error('Error sharing mood:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to share mood'
      });
    }
  })
);

// Get shared moods
router.get(
  '/shared',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { count, rows: sharedMoods } = await SharedMood.findAndCountAll({
        where: {
          sharedWithId: req.user.id
        },
        include: [
          {
            model: Mood,
            as: 'sharedMood',
            include: [{
              model: User,
              as: 'moodUser',
              attributes: ['id', 'username', 'avatar', 'displayName']
            }]
          },
          {
            model: User,
            as: 'sharedMoodUser',
            attributes: ['id', 'username', 'avatar']
          }
        ],
        order: [['sharedAt', 'DESC']],
        offset,
        limit: parseInt(limit)
      });

      res.status(200).json({
        status: 'success',
        data: {
          sharedMoods,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching shared moods:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch shared moods'
      });
    }
  })
);

// Mark shared mood as viewed
router.post(
  '/shared/:sharedMoodId/view',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { sharedMoodId } = req.params;

      const sharedMood = await SharedMood.findOne({
        where: {
          id: sharedMoodId,
          sharedWithId: req.user.id
        }
      });

      if (!sharedMood) {
        throw new NotFoundError('Shared mood not found');
      }

      await sharedMood.update({
        isViewed: true,
        viewedAt: new Date()
      });

      res.status(200).json({
        status: 'success',
        message: 'Shared mood marked as viewed',
        data: { sharedMood },
      });
    } catch (error) {
      console.error('Error marking shared mood as viewed:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to mark shared mood as viewed'
      });
    }
  })
);

// Get mood stats
router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { period = '7d' } = req.query;

      let startDate = new Date();
      switch (period) {
        case '1d':
          startDate.setDate(startDate.getDate() - 1);
          break;
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
        case '90d':
          startDate.setDate(startDate.getDate() - 90);
          break;
        default:
          throw new ValidationError('Invalid period. Use: 1d, 7d, 30d, 90d');
      }

      const moodStats = await Mood.findAll({
        where: {
          userId: req.user.id,
          createdAt: { [require('sequelize').Op.gte]: startDate }
        },
        attributes: [
          [require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'date'],
          'mood',
          [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
          [require('sequelize').fn('AVG', require('sequelize').col('intensity')), 'avgIntensity']
        ],
        group: [require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'mood'],
        order: [[require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'ASC'], ['mood', 'ASC']],
        raw: true
      });

      const moodDistribution = await Mood.findAll({
        where: {
          userId: req.user.id,
          createdAt: { [require('sequelize').Op.gte]: startDate }
        },
        attributes: [
          'mood',
          [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
          [require('sequelize').fn('AVG', require('sequelize').col('intensity')), 'avgIntensity']
        ],
        group: ['mood'],
        order: [[require('sequelize').fn('COUNT', require('sequelize').col('id')), 'DESC']],
        raw: true
      });

      const totalMoods = moodDistribution.reduce((sum, stat) => sum + parseInt(stat.count), 0);

      res.status(200).json({
        status: 'success',
        data: {
          period,
          totalMoods,
          dailyStats: moodStats.map(stat => ({
            _id: { mood: stat.mood, date: stat.date },
            count: parseInt(stat.count),
            avgIntensity: parseFloat(stat.avgIntensity) || 0
          })),
          moodDistribution: moodDistribution.map(stat => ({
            _id: stat.mood,
            count: parseInt(stat.count),
            percentage: totalMoods > 0 ? Math.round((parseInt(stat.count) / totalMoods) * 100) : 0,
            avgIntensity: parseFloat(stat.avgIntensity) || 0
          })),
        },
      });
    } catch (error) {
      console.error('Error fetching mood stats:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch mood stats'
      });
    }
  })
);

// Get mood trend
router.get(
  '/trend',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { days = 30 } = req.query;

      const daysInt = parseInt(days);
      if (isNaN(daysInt) || daysInt < 1 || daysInt > 365) {
        throw new ValidationError('Days must be between 1 and 365');
      }

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysInt);

      const moodTrend = await Mood.findAll({
        where: {
          userId: req.user.id,
          createdAt: { [require('sequelize').Op.gte]: startDate }
        },
        attributes: [
          [require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'date'],
          [require('sequelize').fn('AVG', require('sequelize').col('intensity')), 'avgIntensity'],
          [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
        ],
        group: [require('sequelize').fn('DATE', require('sequelize').col('createdAt'))],
        order: [[require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'ASC']],
        raw: true
      });

      res.status(200).json({
        status: 'success',
        data: {
          days: daysInt,
          trend: moodTrend.map(day => ({
            date: day.date,
            avgIntensity: parseFloat(day.avgIntensity) || 0,
            count: parseInt(day.count)
          })),
        },
      });
    } catch (error) {
      console.error('Error fetching mood trend:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch mood trend'
      });
    }
  })
);

module.exports = router;