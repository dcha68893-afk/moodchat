const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Import models
const User = require('../models/User');
const Token = require('../models/Token');
const Chat = require('../models/Chat');
const Call = require('../models/Call');

// Import utilities
const { logger } = require('../middleware/errorHandler');
const {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthenticationError,
} = require('../middleware/errorHandler');

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const REFRESH_TOKEN_EXPIRY = parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 30 * 24 * 60 * 60 * 1000;
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12;
const PASSWORD_RESET_EXPIRY = parseInt(process.env.PASSWORD_RESET_EXPIRY) || 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
const LOCKOUT_DURATION = parseInt(process.env.LOCKOUT_DURATION) || 15 * 60 * 1000; // 15 minutes

/**
 * User Service - Handles all user-related business logic
 * FIXED: This service should not interfere with registration/login handled by authService
 */
class UserService {
  /**
   * Register a new user - FIXED: This should not be used, authService handles registration
   */
  static async registerUser(userData) {
    throw new Error('Use authService.register() for user registration');
  }

  /**
   * Authenticate user - FIXED: This should not be used, authService handles authentication
   */
  static async authenticateUser(credentials) {
    throw new Error('Use authService.login() for user authentication');
  }

  /**
   * Generate authentication tokens - FIXED: This should not be used, authService handles token generation
   */
  static async generateAuthTokens(userId) {
    throw new Error('Use authService.generateTokens() for token generation');
  }

  /**
   * Refresh access token - FIXED: This should not be used, authService handles token refresh
   */
  static async refreshAccessToken(refreshToken) {
    throw new Error('Use authService.refreshToken() for token refresh');
  }

  /**
   * Logout user - FIXED: This should not conflict with authService.logout()
   */
  static async logoutUser(userId, refreshToken = null) {
    try {
      // Invalidate refresh token if provided - use authService for this
      if (refreshToken) {
        // This should be handled by authService, but we keep for compatibility
        await Token.findOneAndDelete({
          token: refreshToken,
          type: 'refresh',
        });
      }

      // Update user status
      await User.findByIdAndUpdate(userId, {
        online: false,
        status: 'offline',
        statusLastChanged: new Date(),
      });

      return { success: true };
    } catch (error) {
      logger.error('Logout failed:', error);
      throw error;
    }
  }

  /**
   * Logout from all devices - FIXED: This should not conflict with authService
   */
  static async logoutAllDevices(userId) {
    try {
      // Delete all refresh tokens for this user
      await Token.deleteMany({
        userId,
        type: 'refresh',
      });

      // Update user status
      await User.findByIdAndUpdate(userId, {
        online: false,
        status: 'offline',
        statusLastChanged: new Date(),
      });

      return { success: true };
    } catch (error) {
      logger.error('Logout all devices failed:', error);
      throw error;
    }
  }

  /**
   * Get user profile - FIXED: Ensure this doesn't re-validate passwords
   */
  static async getUserProfile(userId, requestingUserId = null) {
    try {
      // Build query based on who's requesting
      let query = User.findById(userId);

      if (userId === requestingUserId) {
        // Self request - include all data except sensitive fields
        query = query.select('-password -resetPasswordToken -resetPasswordExpires');
      } else {
        // Other user request - exclude sensitive data
        query = query.select('username avatar displayName bio status online lastActive createdAt');
      }

      const user = await query
        .populate('friends', 'username avatar online status lastActive')
        .populate('friendRequests', 'username avatar');

      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Add friendship status if requesting user is different
      let friendshipStatus = 'none';
      if (requestingUserId && userId !== requestingUserId) {
        const requestingUser = await User.findById(requestingUserId);

        if (requestingUser.friends.includes(user._id)) {
          friendshipStatus = 'friends';
        } else if (requestingUser.friendRequests.includes(user._id)) {
          friendshipStatus = 'request_received';
        } else if (user.friendRequests.includes(requestingUser._id)) {
          friendshipStatus = 'request_sent';
        }
      }

      const userResponse = user.toObject();
      userResponse.friendshipStatus = friendshipStatus;

      return userResponse;
    } catch (error) {
      logger.error('Get user profile failed:', error);
      throw error;
    }
  }

  /**
   * Update user profile - FIXED: Don't re-validate passwords here
   */
  static async updateUserProfile(userId, updateData) {
    try {
      const allowedUpdates = [
        'username',
        'email',
        'avatar',
        'bio',
        'status',
        'displayName',
        'emailNotifications',
        'pushNotifications',
        'settings',
      ];

      // Filter only allowed fields
      const filteredUpdates = {};
      Object.keys(updateData).forEach(key => {
        if (allowedUpdates.includes(key)) {
          filteredUpdates[key] = updateData[key];
        }
      });

      // Handle username/email uniqueness
      if (filteredUpdates.username) {
        filteredUpdates.username = filteredUpdates.username.toLowerCase();
        const existingUser = await User.findOne({
          username: filteredUpdates.username,
          _id: { $ne: userId },
        });
        if (existingUser) {
          throw new ConflictError('Username already taken');
        }
      }

      if (filteredUpdates.email) {
        filteredUpdates.email = filteredUpdates.email.toLowerCase();
        const existingUser = await User.findOne({
          email: filteredUpdates.email,
          _id: { $ne: userId },
        });
        if (existingUser) {
          throw new ConflictError('Email already taken');
        }
      }

      // Update status timestamp if status is being updated
      if (filteredUpdates.status) {
        filteredUpdates.statusLastChanged = new Date();
      }

      const updatedUser = await User.findByIdAndUpdate(userId, filteredUpdates, {
        new: true,
        runValidators: true,
      }).select('-password -resetPasswordToken -resetPasswordExpires -loginAttempts -lockedUntil');

      if (!updatedUser) {
        throw new NotFoundError('User not found');
      }

      return updatedUser;
    } catch (error) {
      logger.error('Update user profile failed:', error);
      throw error;
    }
  }

  /**
   * Change password - FIXED: This should use authService for password validation
   */
  static async changePassword(userId, passwordData) {
    try {
      const { currentPassword, newPassword, confirmPassword } = passwordData;

      // Validate new passwords match
      if (newPassword !== confirmPassword) {
        throw new ValidationError('New passwords do not match');
      }

      // Get user with password
      const user = await User.findById(userId).select('+password');

      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Verify current password - FIXED: Use bcrypt.compare
      const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isPasswordValid) {
        throw new AuthenticationError('Current password is incorrect');
      }

      // Hash new password
      const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      // Update password and reset login attempts
      user.password = hashedPassword;
      user.loginAttempts = 0;
      user.lockedUntil = null;
      await user.save();

      // Invalidate all refresh tokens for security
      await Token.deleteMany({ userId, type: 'refresh' });

      return { success: true };
    } catch (error) {
      logger.error('Change password failed:', error);
      throw error;
    }
  }

  /**
   * Initiate password reset - FIXED: This should not duplicate authService functionality
   */
  static async initiatePasswordReset(email) {
    try {
      const user = await User.findOne({ email: email.toLowerCase() });

      if (!user) {
        // Don't reveal that user doesn't exist
        return { success: true };
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

      // Save reset token to user
      user.resetPasswordToken = resetTokenHash;
      user.resetPasswordExpires = new Date(Date.now() + PASSWORD_RESET_EXPIRY);
      await user.save();

      // Return reset token (in production, send via email)
      const resetUrl = `${process.env.CLIENT_URL}/reset-password/${resetToken}`;

      return {
        success: true,
        resetToken: process.env.NODE_ENV === 'development' ? resetToken : undefined,
        resetUrl: process.env.NODE_ENV === 'development' ? resetUrl : undefined,
      };
    } catch (error) {
      logger.error('Initiate password reset failed:', error);
      throw error;
    }
  }

  /**
   * Reset password with token - FIXED: This should not duplicate authService functionality
   */
  static async resetPasswordWithToken(token, newPassword, confirmPassword) {
    try {
      // Validate passwords match
      if (newPassword !== confirmPassword) {
        throw new ValidationError('Passwords do not match');
      }

      // Hash token to compare with stored hash
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const user = await User.findOne({
        resetPasswordToken: tokenHash,
        resetPasswordExpires: { $gt: new Date() },
      });

      if (!user) {
        throw new ValidationError('Invalid or expired reset token');
      }

      // Hash new password
      const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      // Update user password and clear reset token
      user.password = hashedPassword;
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      user.loginAttempts = 0;
      user.lockedUntil = null;
      await user.save();

      // Invalidate all refresh tokens for security
      await Token.deleteMany({ userId: user._id, type: 'refresh' });

      return { success: true };
    } catch (error) {
      logger.error('Reset password failed:', error);
      throw error;
    }
  }

  /**
   * Search users - FIXED: This doesn't interfere with auth
   */
  static async searchUsers(query, options = {}) {
    try {
      const {
        page = 1,
        limit = 20,
        excludeCurrentUser = true,
        excludeFriends = false,
        excludeBlocked = true,
      } = options;

      const skip = (page - 1) * limit;

      // Build search query
      const searchQuery = {
        $or: [
          { username: { $regex: query, $options: 'i' } },
          { displayName: { $regex: query, $options: 'i' } },
        ],
      };

      // Exclude current user if specified
      if (excludeCurrentUser && options.currentUserId) {
        searchQuery._id = { $ne: options.currentUserId };
      }

      // If excluding friends, get current user's friends
      if (excludeFriends && options.currentUserId) {
        const currentUser = await User.findById(options.currentUserId);
        if (currentUser && currentUser.friends.length > 0) {
          searchQuery._id = {
            ...searchQuery._id,
            $nin: currentUser.friends,
          };
        }
      }

      // If excluding blocked users
      if (excludeBlocked && options.currentUserId) {
        const currentUser = await User.findById(options.currentUserId);
        if (currentUser && currentUser.blockedUsers && currentUser.blockedUsers.length > 0) {
          searchQuery._id = {
            ...searchQuery._id,
            $nin: [...(searchQuery._id?.$nin || []), ...currentUser.blockedUsers],
          };
        }

        // Also exclude users who have blocked the current user
        const usersWhoBlockedMe = await User.find({
          blockedUsers: options.currentUserId,
        }).select('_id');

        if (usersWhoBlockedMe.length > 0) {
          searchQuery._id = {
            ...searchQuery._id,
            $nin: [...(searchQuery._id?.$nin || []), ...usersWhoBlockedMe.map(u => u._id)],
          };
        }
      }

      // Execute search
      const [users, total] = await Promise.all([
        User.find(searchQuery)
          .select('username avatar displayName online status lastActive bio')
          .skip(skip)
          .limit(limit)
          .sort({ online: -1, username: 1 })
          .lean(),
        User.countDocuments(searchQuery),
      ]);

      // Add relationship status if current user provided
      if (options.currentUserId) {
        const currentUser = await User.findById(options.currentUserId);

        const usersWithStatus = users.map(user => {
          const relationship = {
            isFriend: currentUser.friends.some(friendId => friendId.equals(user._id)),
            hasSentRequest: currentUser.friendRequests.some(requestId =>
              requestId.equals(user._id)
            ),
            hasReceivedRequest:
              user.friendRequests?.some(requestId => requestId.equals(currentUser._id)) || false,
            isBlocked:
              currentUser.blockedUsers?.some(blockedId => blockedId.equals(user._id)) || false,
          };

          return {
            ...user,
            relationship,
          };
        });

        return {
          users: usersWithStatus,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
          },
        };
      }

      return {
        users,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Search users failed:', error);
      throw error;
    }
  }

  /**
   * Get user suggestions (people you may know) - FIXED: This doesn't interfere with auth
   */
  static async getUserSuggestions(userId, limit = 10) {
    try {
      const user = await User.findById(userId).populate('friends');

      // Get friends of friends who are not already friends
      const friendIds = user.friends.map(friend => friend._id);

      if (friendIds.length === 0) {
        // If no friends, suggest popular users
        const suggestions = await User.find({
          _id: {
            $ne: userId,
            $nin: [...(user.blockedUsers || [])],
          },
        })
          .select('username avatar displayName online status bio')
          .limit(limit)
          .sort({ createdAt: -1 });

        return suggestions;
      }

      const suggestions = await User.aggregate([
        {
          $match: {
            _id: {
              $ne: mongoose.Types.ObjectId(userId),
              $nin: [...friendIds, ...(user.blockedUsers || [])],
            },
            friends: { $in: friendIds },
          },
        },
        {
          $addFields: {
            mutualCount: {
              $size: {
                $setIntersection: ['$friends', friendIds],
              },
            },
          },
        },
        {
          $sort: {
            mutualCount: -1,
            online: -1,
            createdAt: -1,
          },
        },
        {
          $limit: limit,
        },
        {
          $project: {
            username: 1,
            avatar: 1,
            displayName: 1,
            online: 1,
            status: 1,
            bio: 1,
            mutualCount: 1,
          },
        },
      ]);

      return suggestions;
    } catch (error) {
      logger.error('Get user suggestions failed:', error);
      throw error;
    }
  }

  /**
   * Update user presence status - FIXED: This doesn't interfere with auth
   */
  static async updatePresenceStatus(userId, statusData) {
    try {
      const { status, statusText, statusEmoji, expiresIn } = statusData;

      // Validate status
      const validStatuses = ['online', 'away', 'busy', 'offline'];
      if (status && !validStatuses.includes(status)) {
        throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
      }

      // Calculate expiration if provided
      let statusExpiresAt = null;
      if (expiresIn) {
        const expiresInMinutes = parseInt(expiresIn);
        if (isNaN(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 1440) {
          throw new ValidationError('Expires in must be between 1 and 1440 minutes');
        }
        statusExpiresAt = new Date(Date.now() + expiresInMinutes * 60000);
      }

      const updates = {
        status: status || 'online',
        statusText: statusText || '',
        statusEmoji: statusEmoji || '',
        statusExpiresAt,
        statusLastChanged: new Date(),
        lastActive: new Date(),
      };

      // Update online status based on presence
      if (status === 'online' || status === 'away' || status === 'busy') {
        updates.online = true;
      } else if (status === 'offline') {
        updates.online = false;
      }

      const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true }).select(
        'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive'
      );

      if (!updatedUser) {
        throw new NotFoundError('User not found');
      }

      return updatedUser;
    } catch (error) {
      logger.error('Update presence status failed:', error);
      throw error;
    }
  }

  /**
   * Get user statistics - FIXED: This doesn't interfere with auth
   */
  static async getUserStatistics(userId) {
    try {
      const user = await User.findById(userId).populate('friends');

      // Get call statistics for last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const callStats = await Call.aggregate([
        {
          $match: {
            $or: [
              { caller: mongoose.Types.ObjectId(userId) },
              { participants: mongoose.Types.ObjectId(userId) },
            ],
            startedAt: { $gte: thirtyDaysAgo },
          },
        },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            completedCalls: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
            missedCalls: {
              $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] },
            },
            totalDuration: { $sum: '$duration' },
          },
        },
      ]);

      // Get chat statistics
      const chatStats = await Chat.aggregate([
        {
          $match: {
            participants: mongoose.Types.ObjectId(userId),
            isArchived: false,
          },
        },
        {
          $group: {
            _id: '$chatType',
            count: { $sum: 1 },
          },
        },
      ]);

      // Get message statistics for last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const Message = require('../models/Message');
      const messageStats = await Message.aggregate([
        {
          $match: {
            sender: mongoose.Types.ObjectId(userId),
            createdAt: { $gte: sevenDaysAgo },
            isDeleted: false,
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        {
          $sort: { _id: 1 },
        },
      ]);

      const stats = {
        friends: {
          total: user.friends.length,
          online: user.friends.filter(f => f.online).length,
        },
        calls: callStats[0] || {
          totalCalls: 0,
          completedCalls: 0,
          missedCalls: 0,
          totalDuration: 0,
        },
        chats: {
          direct: chatStats.find(c => c._id === 'direct')?.count || 0,
          group: chatStats.find(c => c._id === 'group')?.count || 0,
          total:
            (chatStats.find(c => c._id === 'direct')?.count || 0) +
            (chatStats.find(c => c._id === 'group')?.count || 0),
        },
        messages: {
          totalLast7Days: messageStats.reduce((sum, day) => sum + day.count, 0),
          dailyStats: messageStats,
        },
        account: {
          createdAt: user.createdAt,
          lastLogin: user.lastLogin,
          lastActive: user.lastActive,
        },
      };

      return stats;
    } catch (error) {
      logger.error('Get user statistics failed:', error);
      throw error;
    }
  }

  /**
   * Deactivate user account - FIXED: This doesn't interfere with auth
   */
  static async deactivateAccount(userId, reason = 'user_request') {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Mark user as deactivated
      user.isActive = false;
      user.deactivatedAt = new Date();
      user.deactivationReason = reason;
      user.online = false;
      user.status = 'offline';
      await user.save();

      // Remove all active sessions
      await Token.deleteMany({ userId, type: 'refresh' });

      // Archive user's chats
      await Chat.updateMany({ participants: userId }, { $set: { isArchived: true } });

      // Notify friends (optional - could be done via WebSocket)
      // ...

      return { success: true };
    } catch (error) {
      logger.error('Deactivate account failed:', error);
      throw error;
    }
  }

  /**
   * Reactivate user account - FIXED: This doesn't interfere with auth
   */
  static async reactivateAccount(userId) {
    try {
      const user = await User.findByIdAndUpdate(
        userId,
        {
          isActive: true,
          deactivatedAt: null,
          deactivationReason: null,
          online: true,
          status: 'online',
        },
        { new: true }
      );

      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Unarchive user's chats
      await Chat.updateMany(
        { participants: userId, archivedBy: userId },
        {
          $set: {
            isArchived: false,
            archivedBy: null,
            archivedAt: null,
          },
        }
      );

      return { success: true, user };
    } catch (error) {
      logger.error('Reactivate account failed:', error);
      throw error;
    }
  }

  /**
   * Delete user account permanently - FIXED: This doesn't interfere with auth
   */
  static async deleteAccount(userId, confirmPassword) {
    try {
      // Verify password
      const user = await User.findById(userId).select('+password');

      if (!user) {
        throw new NotFoundError('User not found');
      }

      const isPasswordValid = await bcrypt.compare(confirmPassword, user.password);
      if (!isPasswordValid) {
        throw new AuthenticationError('Password is incorrect');
      }

      // Start deletion process (in production, you might want to schedule this)
      // For now, we'll mark for deletion and clean up related data

      // 1. Delete all tokens
      await Token.deleteMany({ userId });

      // 2. Remove user from all chats
      await Chat.updateMany({ participants: userId }, { $pull: { participants: userId } });

      // 3. Delete user's messages (soft delete)
      const Message = require('../models/Message');
      await Message.updateMany(
        { sender: userId },
        { $set: { isDeleted: true, deletedBy: 'system' } }
      );

      // 4. Remove user from friends lists
      await User.updateMany({ friends: userId }, { $pull: { friends: userId } });

      // 5. Remove from friend requests
      await User.updateMany({ friendRequests: userId }, { $pull: { friendRequests: userId } });

      // 6. Delete user calls
      await Call.deleteMany({
        $or: [{ caller: userId }, { participants: userId }],
      });

      // 7. Finally delete the user
      await User.findByIdAndDelete(userId);

      return { success: true };
    } catch (error) {
      logger.error('Delete account failed:', error);
      throw error;
    }
  }

  /**
   * Validate user session - FIXED: This doesn't interfere with auth
   */
  static async validateSession(userId, sessionData = {}) {
    try {
      const user = await User.findById(userId).select('-password');

      if (!user) {
        throw new NotFoundError('User not found');
      }

      if (!user.isActive) {
        throw new AuthenticationError('Account is deactivated');
      }

      // Check if session is valid (add more checks as needed)
      const isValid = true;

      return {
        isValid,
        user,
        requiresReauth: false, // Add logic for reauthentication if needed
      };
    } catch (error) {
      logger.error('Validate session failed:', error);
      throw error;
    }
  }

  /**
   * Bulk update user statuses (for admin/background jobs) - FIXED: This doesn't interfere with auth
   */
  static async bulkUpdateUserStatuses(updates) {
    try {
      const operations = updates.map(update => ({
        updateOne: {
          filter: { _id: update.userId },
          update: {
            $set: {
              status: update.status,
              statusText: update.statusText || '',
              statusEmoji: update.statusEmoji || '',
              statusLastChanged: new Date(),
              lastActive: new Date(),
            },
          },
        },
      }));

      if (operations.length > 0) {
        await User.bulkWrite(operations);
      }

      return { success: true, updated: operations.length };
    } catch (error) {
      logger.error('Bulk update user statuses failed:', error);
      throw error;
    }
  }
}

module.exports = UserService;