const userService = require('../services/userService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class UserController {
  async getProfile(req, res, next) {
    try {
      const userId = req.user.id;
      const user = await userService.getUserProfile(userId);

      res.json({
        success: true,
        data: {
          user,
        },
      });
    } catch (error) {
      logger.error('Get profile controller error:', error);
      next(error);
    }
  }

  async updateProfile(req, res, next) {
    try {
      const userId = req.user.id;
      const updateData = req.body;

      const user = await userService.updateProfile(userId, updateData);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: {
          user,
        },
      });
    } catch (error) {
      logger.error('Update profile controller error:', error);
      next(error);
    }
  }

  async updateAvatar(req, res, next) {
    try {
      const userId = req.user.id;

      if (!req.file) {
        throw new AppError('No file uploaded', 400);
      }

      const user = await userService.updateAvatar(userId, req.file);

      res.json({
        success: true,
        message: 'Avatar updated successfully',
        data: {
          user: {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
          },
        },
      });
    } catch (error) {
      logger.error('Update avatar controller error:', error);
      next(error);
    }
  }

  async removeAvatar(req, res, next) {
    try {
      const userId = req.user.id;

      const user = await userService.removeAvatar(userId);

      res.json({
        success: true,
        message: 'Avatar removed successfully',
        data: {
          user: {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
          },
        },
      });
    } catch (error) {
      logger.error('Remove avatar controller error:', error);
      next(error);
    }
  }

  async changePassword(req, res, next) {
    try {
      const userId = req.user.id;
      const { currentPassword, newPassword } = req.body;

      await userService.changePassword(userId, currentPassword, newPassword);

      res.json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      logger.error('Change password controller error:', error);
      next(error);
    }
  }

  async searchUsers(req, res, next) {
    try {
      const userId = req.user.id;
      const { query, limit = 20 } = req.query;

      if (!query || query.length < 2) {
        throw new AppError('Search query must be at least 2 characters', 400);
      }

      const users = await userService.searchUsers(query, userId, parseInt(limit));

      res.json({
        success: true,
        data: {
          users,
          count: users.length,
        },
      });
    } catch (error) {
      logger.error('Search users controller error:', error);
      next(error);
    }
  }

  async getUserStatus(req, res, next) {
    try {
      const userId = req.params.userId || req.user.id;

      const status = await userService.getUserStatus(userId);

      res.json({
        success: true,
        data: {
          userId,
          status,
        },
      });
    } catch (error) {
      logger.error('Get user status controller error:', error);
      next(error);
    }
  }

  async updateStatus(req, res, next) {
    try {
      const userId = req.user.id;
      const { status } = req.body;

      const user = await userService.updateStatus(userId, status);

      res.json({
        success: true,
        message: 'Status updated successfully',
        data: {
          userId,
          status: user.status,
          lastSeen: user.lastSeen,
        },
      });
    } catch (error) {
      logger.error('Update status controller error:', error);
      next(error);
    }
  }

  async getSettings(req, res, next) {
    try {
      const userId = req.user.id;

      const settings = await userService.getSettings(userId);

      res.json({
        success: true,
        data: {
          settings,
        },
      });
    } catch (error) {
      logger.error('Get settings controller error:', error);
      next(error);
    }
  }

  async updateSettings(req, res, next) {
    try {
      const userId = req.user.id;
      const { settings } = req.body;

      const updatedSettings = await userService.updateSettings(userId, settings);

      res.json({
        success: true,
        message: 'Settings updated successfully',
        data: {
          settings: updatedSettings,
        },
      });
    } catch (error) {
      logger.error('Update settings controller error:', error);
      next(error);
    }
  }

  async deactivateAccount(req, res, next) {
    try {
      const userId = req.user.id;
      const { confirm } = req.body;

      if (!confirm) {
        throw new AppError('Please confirm account deactivation', 400);
      }

      await userService.deactivateAccount(userId);

      res.json({
        success: true,
        message: 'Account deactivated successfully',
      });
    } catch (error) {
      logger.error('Deactivate account controller error:', error);
      next(error);
    }
  }

  async getUserById(req, res, next) {
    try {
      const userId = req.params.userId;
      const currentUserId = req.user.id;

      // Only allow viewing public profiles or friends
      const friendService = require('../services/friendService');
      const areFriends = await friendService.areFriends(userId, currentUserId);

      if (userId !== currentUserId && !areFriends) {
        // Return limited public information
        const userService = require('../services/userService');
        const user = await userService.getUserProfile(userId);

        const publicInfo = {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          bio: user.bio,
          status: user.status,
        };

        return res.json({
          success: true,
          data: {
            user: publicInfo,
            isFriend: false,
          },
        });
      }

      // Return full profile for self or friends
      const user = await userService.getUserProfile(userId);

      res.json({
        success: true,
        data: {
          user,
          isFriend: areFriends,
        },
      });
    } catch (error) {
      logger.error('Get user by ID controller error:', error);
      next(error);
    }
  }
}

module.exports = new UserController();
