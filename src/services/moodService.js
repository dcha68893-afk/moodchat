const { Op } = require('sequelize');
const { Mood, SharedMood, User, Friend } = require('../models');
const redisClient = require('../utils/redisClient');
const logger = require('../utils/logger');

class MoodService {
  async createMood(userId, moodData) {
    try {
      // Create mood
      const mood = await Mood.create({
        userId,
        ...moodData,
      });

      // Clear cache
      await redisClient.del(`user:${userId}:moods`);
      await redisClient.del(`user:${userId}:mood:stats`);

      // Notify friends if mood is public
      if (mood.isPublic) {
        await this.notifyFriendsAboutMood(userId, mood);
      }

      return mood;
    } catch (error) {
      logger.error('Create mood error:', error);
      throw error;
    }
  }

  async getUserMoods(userId, options = {}) {
    try {
      const cacheKey = `user:${userId}:moods:${JSON.stringify(options)}`;
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const moods = await Mood.getUserMoods(userId, options);

      // Format response
      const formattedMoods = moods.map(mood => ({
        id: mood.id,
        mood: mood.mood,
        intensity: mood.intensity,
        note: mood.note,
        triggers: mood.triggers,
        location: mood.location,
        weather: mood.weather,
        isPublic: mood.isPublic,
        tags: mood.tags,
        color: mood.color,
        icon: mood.icon,
        createdAt: mood.createdAt,
        expiresAt: mood.expiresAt,
        metadata: mood.metadata,
      }));

      // Cache for 5 minutes
      await redisClient.setex(cacheKey, 300, JSON.stringify(formattedMoods));

      return formattedMoods;
    } catch (error) {
      logger.error('Get user moods error:', error);
      throw error;
    }
  }

  async getPublicMoods(options = {}) {
    try {
      const cacheKey = `public:moods:${JSON.stringify(options)}`;
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const moods = await Mood.getPublicMoods(options);

      // Format response
      const formattedMoods = moods.map(mood => ({
        id: mood.id,
        mood: mood.mood,
        intensity: mood.intensity,
        note: mood.note,
        tags: mood.tags,
        color: mood.color,
        icon: mood.icon,
        user: {
          id: mood.User.id,
          username: mood.User.username,
          avatar: mood.User.avatar,
        },
        createdAt: mood.createdAt,
        expiresAt: mood.expiresAt,
      }));

      // Cache for 1 minute
      await redisClient.setex(cacheKey, 60, JSON.stringify(formattedMoods));

      return formattedMoods;
    } catch (error) {
      logger.error('Get public moods error:', error);
      throw error;
    }
  }

  async updateMood(moodId, userId, updateData) {
    try {
      const mood = await Mood.findByPk(moodId);
      if (!mood) {
        throw new Error('Mood not found');
      }

      // Check authorization
      if (mood.userId !== userId) {
        throw new Error('Not authorized to update this mood');
      }

      // Update mood
      const allowedFields = [
        'mood',
        'intensity',
        'note',
        'triggers',
        'location',
        'weather',
        'isPublic',
        'tags',
      ];
      const updates = {};

      allowedFields.forEach(field => {
        if (updateData[field] !== undefined) {
          updates[field] = updateData[field];
        }
      });

      await mood.update(updates);

      // Clear cache
      await redisClient.del(`user:${userId}:moods`);
      await redisClient.del(`user:${userId}:mood:stats`);

      return mood;
    } catch (error) {
      logger.error('Update mood error:', error);
      throw error;
    }
  }

  async deleteMood(moodId, userId) {
    try {
      const mood = await Mood.findByPk(moodId);
      if (!mood) {
        throw new Error('Mood not found');
      }

      // Check authorization
      if (mood.userId !== userId) {
        throw new Error('Not authorized to delete this mood');
      }

      // Delete mood
      await mood.destroy();

      // Clear cache
      await redisClient.del(`user:${userId}:moods`);
      await redisClient.del(`user:${userId}:mood:stats`);

      return true;
    } catch (error) {
      logger.error('Delete mood error:', error);
      throw error;
    }
  }

  async shareMoodWithFriend(moodId, userId, friendId) {
    try {
      const mood = await Mood.findByPk(moodId);
      if (!mood) {
        throw new Error('Mood not found');
      }

      // Check authorization
      if (mood.userId !== userId) {
        throw new Error('Not authorized to share this mood');
      }

      // Check if users are friends
      const areFriends = await Friend.areFriends(userId, friendId);
      if (!areFriends) {
        throw new Error('Can only share moods with friends');
      }

      // Check if already shared
      const existingShare = await SharedMood.findOne({
        where: { moodId, sharedWithId: friendId },
      });

      if (existingShare) {
        throw new Error('Mood already shared with this friend');
      }

      // Share mood
      const sharedMood = await mood.shareWithFriend(friendId);

      // Send notification
      const notificationService = require('./notificationService');
      await notificationService.createFromTemplate(friendId, 'mood_shared', {
        moodId: mood.id,
        moodType: mood.mood,
        sharedById: userId,
        sharedByName: await this.getUserName(userId),
      });

      // Send real-time notification
      const webSocketService = require('./webSocketService');
      webSocketService.notifyMoodShared(friendId, {
        moodId: mood.id,
        sharedById: userId,
        mood: mood.mood,
        icon: mood.icon,
        color: mood.color,
        note: mood.note,
      });

      return sharedMood;
    } catch (error) {
      logger.error('Share mood error:', error);
      throw error;
    }
  }

  async getSharedMoods(userId, options = {}) {
    try {
      const sharedMoods = await SharedMood.findAll({
        where: {
          sharedWithId: userId,
          ...options.where,
        },
        include: [
          {
            model: Mood,
            include: [
              {
                model: User,
                attributes: ['id', 'username', 'avatar'],
              },
            ],
          },
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
        order: [['sharedAt', 'DESC']],
        limit: options.limit || 50,
        offset: options.offset || 0,
      });

      // Format response
      return sharedMoods.map(shared => ({
        id: shared.id,
        mood: {
          id: shared.Mood.id,
          mood: shared.Mood.mood,
          intensity: shared.Mood.intensity,
          note: shared.Mood.note,
          color: shared.Mood.color,
          icon: shared.Mood.icon,
          user: {
            id: shared.Mood.User.id,
            username: shared.Mood.User.username,
            avatar: shared.Mood.User.avatar,
          },
          createdAt: shared.Mood.createdAt,
        },
        sharedBy: {
          id: shared.user.id,
          username: shared.user.username,
          avatar: shared.user.avatar,
        },
        sharedAt: shared.sharedAt,
        isViewed: shared.isViewed,
        viewedAt: shared.viewedAt,
      }));
    } catch (error) {
      logger.error('Get shared moods error:', error);
      throw error;
    }
  }

  async markSharedMoodAsViewed(sharedMoodId, userId) {
    try {
      const sharedMood = await SharedMood.findByPk(sharedMoodId);
      if (!sharedMood) {
        throw new Error('Shared mood not found');
      }

      // Check authorization
      if (sharedMood.sharedWithId !== userId) {
        throw new Error('Not authorized to view this shared mood');
      }

      // Mark as viewed
      sharedMood.isViewed = true;
      sharedMood.viewedAt = new Date();
      await sharedMood.save();

      return sharedMood;
    } catch (error) {
      logger.error('Mark shared mood as viewed error:', error);
      throw error;
    }
  }

  async getMoodStats(userId, days = 30) {
    try {
      const cacheKey = `user:${userId}:mood:stats:${days}`;
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const stats = await Mood.getMoodStats(userId, days);

      // Format response
      const formattedStats = stats.map(stat => ({
        mood: stat.mood,
        count: parseInt(stat.count),
        averageIntensity: parseFloat(stat.averageIntensity),
      }));

      // Calculate totals
      const totalMoods = formattedStats.reduce((sum, stat) => sum + stat.count, 0);
      const mostCommonMood =
        formattedStats.length > 0
          ? formattedStats.reduce(
              (max, stat) => (stat.count > max.count ? stat : max),
              formattedStats[0]
            )
          : null;

      const result = {
        period: `${days} days`,
        totalMoods,
        mostCommonMood: mostCommonMood
          ? {
              mood: mostCommonMood.mood,
              count: mostCommonMood.count,
            }
          : null,
        moodDistribution: formattedStats,
      };

      // Cache for 1 hour
      await redisClient.setex(cacheKey, 3600, JSON.stringify(result));

      return result;
    } catch (error) {
      logger.error('Get mood stats error:', error);
      throw error;
    }
  }

  async getMoodTrend(userId, days = 7) {
    try {
      const cacheKey = `user:${userId}:mood:trend:${days}`;
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      // Get recent moods
      const moods = await Mood.findAll({
        where: {
          userId,
          createdAt: { [Op.gte]: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
        },
        attributes: ['mood', 'intensity', 'createdAt'],
        order: [['createdAt', 'ASC']],
      });

      // Group by day
      const trend = {};
      moods.forEach(mood => {
        const date = mood.createdAt.toISOString().split('T')[0];
        if (!trend[date]) {
          trend[date] = {
            date,
            moods: [],
            averageIntensity: 0,
          };
        }
        trend[date].moods.push(mood.mood);
        trend[date].averageIntensity =
          (trend[date].averageIntensity * (trend[date].moods.length - 1) + mood.intensity) /
          trend[date].moods.length;
      });

      const result = Object.values(trend);

      // Cache for 1 hour
      await redisClient.setex(cacheKey, 3600, JSON.stringify(result));

      return result;
    } catch (error) {
      logger.error('Get mood trend error:', error);
      throw error;
    }
  }

  async notifyFriendsAboutMood(userId, mood) {
    try {
      const friends = await Friend.getFriends(userId);

      friends.forEach(async friendship => {
        const friendId =
          friendship.requesterId === userId ? friendship.receiverId : friendship.requesterId;

        // Send WebSocket notification
        const webSocketService = require('./webSocketService');
        webSocketService.notifyFriendMood(friendId, {
          userId,
          mood: mood.mood,
          icon: mood.icon,
          color: mood.color,
          note: mood.note,
        });
      });
    } catch (error) {
      logger.error('Notify friends about mood error:', error);
    }
  }

  async getUserName(userId) {
    const user = await User.findByPk(userId, {
      attributes: ['username', 'firstName', 'lastName'],
    });

    if (!user) return 'Unknown User';

    return user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.username;
  }

  async cleanupExpiredMoods() {
    try {
      const count = await Mood.cleanupExpired();
      logger.info(`Cleaned up ${count} expired moods`);
      return count;
    } catch (error) {
      logger.error('Cleanup expired moods error:', error);
      throw error;
    }
  }
}

module.exports = new MoodService();
