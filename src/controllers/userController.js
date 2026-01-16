const userService = require('../services/userService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class UserController {
  async getAllUsers(req, res, next) {
    try {
      // Get current user ID from authenticated request
      const currentUserId = req.user.id;
      
      // Get all registered users excluding the current user
      const users = await userService.getAllRegisteredUsers(currentUserId);

      // Format response to only include required fields
      const formattedUsers = users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar
      }));

      // Log for debugging
      logger.info(`Retrieved ${formattedUsers.length} users for current user: ${currentUserId}`);

      res.json({
        success: true,
        data: {
          users: formattedUsers,
          count: formattedUsers.length
        }
      });
    } catch (error) {
      logger.error('Get all users controller error:', error);
      
      // Return 500 error with descriptive JSON if DB fetch fails
      res.status(500).json({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'Failed to fetch users from database',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        }
      });
    }
  }

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

      // Validate update data
      if (updateData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updateData.email)) {
        throw new AppError('Invalid email format', 400);
      }

      if (updateData.username && !/^[a-zA-Z0-9_]+$/.test(updateData.username)) {
        throw new AppError('Username can only contain letters, numbers, and underscores', 400);
      }

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
      
      // Handle duplicate email/username errors
      if (error.message.includes('duplicate') || error.code === 11000) {
        return next(new AppError('Email or username already exists', 409));
      }
      
      next(error);
    }
  }

  async updateAvatar(req, res, next) {
    try {
      const userId = req.user.id;

      if (!req.file) {
        throw new AppError('No file uploaded', 400);
      }

      // Validate file type
      const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedMimeTypes.includes(req.file.mimetype)) {
        throw new AppError('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed', 400);
      }

      // Validate file size (max 5MB)
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (req.file.size > maxSize) {
        throw new AppError('File size exceeds 5MB limit', 400);
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

      // Validate required fields
      if (!currentPassword || !newPassword) {
        throw new AppError('Current password and new password are required', 400);
      }

      // Validate new password strength
      if (newPassword.length < 8) {
        throw new AppError('New password must be at least 8 characters long', 400);
      }

      // Ensure new password is different from current password
      if (currentPassword === newPassword) {
        throw new AppError('New password must be different from current password', 400);
      }

      await userService.changePassword(userId, currentPassword, newPassword);

      // Log password change for security auditing
      logger.info(`Password changed for user: ${userId}`);

      res.json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      logger.error('Change password controller error:', error);
      
      // Handle specific error cases
      if (error.message.includes('Current password is incorrect')) {
        return next(new AppError('Current password is incorrect', 401));
      }
      
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

      if (!status || typeof status !== 'string') {
        throw new AppError('Status is required and must be a string', 400);
      }

      // Validate status length
      if (status.length > 100) {
        throw new AppError('Status must be 100 characters or less', 400);
      }

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

      if (!settings || typeof settings !== 'object') {
        throw new AppError('Settings object is required', 400);
      }

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

      // Additional confirmation validation
      if (confirm !== 'DELETE' && confirm !== 'YES') {
        throw new AppError('Please type "DELETE" or "YES" to confirm account deactivation', 400);
      }

      await userService.deactivateAccount(userId);

      // Log account deactivation for security auditing
      logger.warn(`Account deactivated for user: ${userId}`);

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

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Only allow viewing public profiles or friends
      const friendService = require('../services/friendService');
      const areFriends = await friendService.areFriends(userId, currentUserId);

      if (userId !== currentUserId && !areFriends) {
        // Return limited public information
        const user = await userService.getUserProfile(userId);

        const publicInfo = {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          bio: user.bio,
          status: user.status,
          lastSeen: user.lastSeen,
          isOnline: user.isOnline,
          createdAt: user.createdAt,
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
      
      if (error.message.includes('not found') || error.message.includes('User not found')) {
        return next(new AppError('User not found', 404));
      }
      
      next(error);
    }
  }
}

module.exports = new UserController();