const UserStatus = require('../models/UserStatus');
const User = require('../models/Users');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * User Status Service
 * Handles user online status and presence
 */
class UserStatusService {
  /**
   * Update user status
   * @param {string} userId - User ID
   * @param {Object} statusData - Status data
   * @returns {Promise<Object>} Updated user status
   */
  async updateStatus(userId, statusData) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const { status, customMessage, expiresAt, deviceInfo } = statusData;

      // Validate status
      const validStatuses = ['online', 'away', 'busy', 'offline', 'invisible'];
      if (status && !validStatuses.includes(status)) {
        throw new ValidationError(`Invalid status. Valid values: ${validStatuses.join(', ')}`);
      }

      // Check if user exists
      const user = await User.findById(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Find or create user status
      let userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        userStatus = new UserStatus({ userId });
      }

      // Update status fields
      if (status) {
        userStatus.status = status;
        if (status === 'online') {
          userStatus.lastSeen = new Date();
          userStatus.isOnline = true;
        } else if (status === 'offline') {
          userStatus.isOnline = false;
        } else {
          userStatus.isOnline = true;
        }
      }

      if (customMessage !== undefined) {
        userStatus.customMessage = customMessage;
        if (customMessage) {
          userStatus.customMessageSetAt = new Date();
        }
      }

      if (expiresAt) {
        userStatus.expiresAt = new Date(expiresAt);
      }

      if (deviceInfo) {
        userStatus.deviceInfo = deviceInfo;
      }

      userStatus.lastUpdated = new Date();

      await userStatus.save();

      // Populate user details
      await userStatus.populate('userId', 'username avatar displayName email');

      return this._formatUserStatus(userStatus);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error updating user status:', error);
      throw new ServerError('Failed to update user status');
    }
  }

  /**
   * Get user status
   * @param {string} userId - User ID
   * @param {string} requesterId - ID of user requesting the status
   * @returns {Promise<Object>} User status
   */
  async getStatus(userId, requesterId) {
    try {
      if (!userId || !requesterId) {
        throw new ValidationError('User ID and Requester ID are required');
      }

      // Check if users exist
      const [user, requester] = await Promise.all([
        User.findById(userId),
        User.findById(requesterId)
      ]);

      if (!user || !requester) {
        throw new NotFoundError('User not found');
      }

      // Get user status
      let userStatus = await UserStatus.findOne({ userId })
        .populate('userId', 'username avatar displayName email');

      if (!userStatus) {
        // Create default status if not exists
        userStatus = new UserStatus({
          userId: user._id,
          status: 'offline',
          isOnline: false,
          lastSeen: new Date()
        });
        await userStatus.save();
        await userStatus.populate('userId', 'username avatar displayName email');
      }

      // Check privacy settings
      const formattedStatus = this._formatUserStatus(userStatus);
      
      // If user is invisible, only show to self
      if (formattedStatus.status === 'invisible' && userId !== requesterId) {
        return {
          userId: formattedStatus.userId,
          username: formattedStatus.username,
          avatar: formattedStatus.avatar,
          status: 'offline',
          isOnline: false,
          lastSeen: formattedStatus.lastSeen,
          isInvisible: true
        };
      }

      return formattedStatus;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error getting user status:', error);
      throw new ServerError('Failed to get user status');
    }
  }

  /**
   * Get multiple users' statuses
   * @param {Array<string>} userIds - Array of user IDs
   * @param {string} requesterId - ID of user requesting the statuses
   * @returns {Promise<Array>} Array of user statuses
   */
  async getBulkStatus(userIds, requesterId) {
    try {
      if (!Array.isArray(userIds) || userIds.length === 0 || !requesterId) {
        throw new ValidationError('User IDs array and Requester ID are required');
      }

      // Limit the number of users
      if (userIds.length > 100) {
        throw new ValidationError('Maximum 100 users allowed per request');
      }

      // Get all statuses
      const userStatuses = await UserStatus.find({ userId: { $in: userIds } })
        .populate('userId', 'username avatar displayName email');

      // Create default statuses for users without one
      const statusMap = new Map();
      userStatuses.forEach(status => {
        statusMap.set(status.userId._id.toString(), status);
      });

      const results = [];
      for (const userId of userIds) {
        let status = statusMap.get(userId);
        
        if (!status) {
          // Create default status
          const user = await User.findById(userId);
          if (user) {
            status = new UserStatus({
              userId: user._id,
              status: 'offline',
              isOnline: false,
              lastSeen: new Date()
            });
            await status.save();
            status.userId = user;
          }
        }

        if (status) {
          const formattedStatus = this._formatUserStatus(status);
          
          // Handle invisible status
          if (formattedStatus.status === 'invisible' && userId !== requesterId) {
            results.push({
              userId: formattedStatus.userId,
              username: formattedStatus.username,
              avatar: formattedStatus.avatar,
              status: 'offline',
              isOnline: false,
              lastSeen: formattedStatus.lastSeen,
              isInvisible: true
            });
          } else {
            results.push(formattedStatus);
          }
        }
      }

      return results;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting bulk status:', error);
      throw new ServerError('Failed to get bulk status');
    }
  }

  /**
   * Get user's status history
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Status history with pagination
   */
  async getStatusHistory(userId, options = {}) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const {
        page = 1,
        limit = 50,
        startDate,
        endDate,
        status
      } = options;

      const skip = (page - 1) * limit;

      // Build query
      const query = { userId };
      
      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = startDate;
        if (endDate) query.timestamp.$lte = endDate;
      }
      
      if (status) {
        query.status = status;
      }

      const [history, total] = await Promise.all([
        UserStatus.historyModel
          ? UserStatus.historyModel.find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit)
          : [],
        UserStatus.historyModel
          ? UserStatus.historyModel.countDocuments(query)
          : 0
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        history: history.map(record => ({
          status: record.status,
          customMessage: record.customMessage,
          timestamp: record.timestamp,
          deviceInfo: record.deviceInfo
        })),
        pagination: {
          currentPage: page,
          totalPages,
          totalRecords: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting status history:', error);
      throw new ServerError('Failed to get status history');
    }
  }

  /**
   * Set custom status
   * @param {string} userId - User ID
   * @param {Object} customStatusData - Custom status data
   * @returns {Promise<Object>} Updated user status
   */
  async setCustomStatus(userId, customStatusData) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const { customMessage, emoji, expiresAt } = customStatusData;

      if (!customMessage) {
        throw new ValidationError('Custom message is required');
      }

      if (customMessage.length > 100) {
        throw new ValidationError('Custom message cannot exceed 100 characters');
      }

      let userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        userStatus = new UserStatus({ userId });
      }

      userStatus.customMessage = customMessage;
      userStatus.customMessageSetAt = new Date();
      
      if (emoji) {
        userStatus.emoji = emoji;
      }
      
      if (expiresAt) {
        userStatus.customMessageExpiresAt = new Date(expiresAt);
      }

      await userStatus.save();
      await userStatus.populate('userId', 'username avatar displayName email');

      return this._formatUserStatus(userStatus);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error setting custom status:', error);
      throw new ServerError('Failed to set custom status');
    }
  }

  /**
   * Clear custom status
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Updated user status
   */
  async clearCustomStatus(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        throw new NotFoundError('User status not found');
      }

      userStatus.customMessage = null;
      userStatus.emoji = null;
      userStatus.customMessageSetAt = null;
      userStatus.customMessageExpiresAt = null;

      await userStatus.save();
      await userStatus.populate('userId', 'username avatar displayName email');

      return this._formatUserStatus(userStatus);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error clearing custom status:', error);
      throw new ServerError('Failed to clear custom status');
    }
  }

  /**
   * Set auto-reply message
   * @param {string} userId - User ID
   * @param {Object} autoReplyData - Auto-reply data
   * @returns {Promise<Object>} Updated auto-reply settings
   */
  async setAutoReply(userId, autoReplyData) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const { message, enabled = true, schedule } = autoReplyData;

      if (enabled && !message) {
        throw new ValidationError('Auto-reply message is required when enabling');
      }

      let userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        userStatus = new UserStatus({ userId });
      }

      userStatus.autoReply = {
        message: enabled ? message : null,
        enabled,
        schedule: schedule || {},
        lastUpdated: new Date()
      };

      await userStatus.save();

      return {
        autoReply: userStatus.autoReply,
        userId
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error setting auto-reply:', error);
      throw new ServerError('Failed to set auto-reply');
    }
  }

  /**
   * Get online users count
   * @returns {Promise<number>} Number of online users
   */
  async getOnlineUsersCount() {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const count = await UserStatus.countDocuments({
        isOnline: true,
        lastSeen: { $gte: fiveMinutesAgo },
        status: { $ne: 'invisible' }
      });

      return count;
    } catch (error) {
      logger.error('Error getting online users count:', error);
      throw new ServerError('Failed to get online users count');
    }
  }

  /**
   * Get users by status
   * @param {string} status - Status to filter by
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Users with specified status
   */
  async getUsersByStatus(status, options = {}) {
    try {
      const validStatuses = ['online', 'away', 'busy', 'offline', 'invisible'];
      if (!validStatuses.includes(status)) {
        throw new ValidationError(`Invalid status. Valid values: ${validStatuses.join(', ')}`);
      }

      const {
        page = 1,
        limit = 50,
        includeInvisible = false
      } = options;

      const skip = (page - 1) * limit;

      // Build query
      const query = { status };
      
      if (!includeInvisible && status !== 'invisible') {
        query.status = { $ne: 'invisible' };
      }

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (status === 'online') {
        query.lastSeen = { $gte: fiveMinutesAgo };
        query.isOnline = true;
      }

      const [userStatuses, total] = await Promise.all([
        UserStatus.find(query)
          .populate('userId', 'username avatar displayName email')
          .sort({ lastSeen: -1 })
          .skip(skip)
          .limit(limit),
        UserStatus.countDocuments(query)
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        users: userStatuses.map(status => this._formatUserStatus(status)),
        pagination: {
          currentPage: page,
          totalPages,
          totalUsers: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting users by status:', error);
      throw new ServerError('Failed to get users by status');
    }
  }

  /**
   * Set do not disturb schedule
   * @param {string} userId - User ID
   * @param {Object} dndData - Do Not Disturb data
   * @returns {Promise<Object>} Updated DND settings
   */
  async setDoNotDisturbSchedule(userId, dndData) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const { schedule, enabled = true, exceptions } = dndData;

      if (enabled && !schedule) {
        throw new ValidationError('Schedule is required when enabling Do Not Disturb');
      }

      let userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        userStatus = new UserStatus({ userId });
      }

      userStatus.doNotDisturb = {
        enabled,
        schedule: schedule || {},
        exceptions: exceptions || [],
        lastUpdated: new Date()
      };

      await userStatus.save();

      return userStatus.doNotDisturb;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error setting Do Not Disturb schedule:', error);
      throw new ServerError('Failed to set Do Not Disturb schedule');
    }
  }

  /**
   * Get do not disturb status
   * @param {string} userId - User ID
   * @returns {Promise<Object>} DND status
   */
  async getDoNotDisturbStatus(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        return {
          enabled: false,
          schedule: {},
          exceptions: [],
          lastUpdated: null
        };
      }

      return userStatus.doNotDisturb || {
        enabled: false,
        schedule: {},
        exceptions: [],
        lastUpdated: null
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting Do Not Disturb status:', error);
      throw new ServerError('Failed to get Do Not Disturb status');
    }
  }

  /**
   * Check if Do Not Disturb is active
   * @param {Object} dndStatus - DND status object
   * @returns {boolean} Whether DND is active
   */
  isDoNotDisturbActive(dndStatus) {
    if (!dndStatus || !dndStatus.enabled) {
      return false;
    }

    const now = new Date();
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const currentTime = now.getHours() * 60 + now.getMinutes(); // Minutes since midnight

    // Check schedule
    const daySchedule = dndStatus.schedule[currentDay];
    if (daySchedule && daySchedule.enabled) {
      const startTime = this._timeToMinutes(daySchedule.startTime);
      const endTime = this._timeToMinutes(daySchedule.endTime);
      
      if (startTime <= endTime) {
        // Normal schedule (same day)
        if (currentTime >= startTime && currentTime <= endTime) {
          return true;
        }
      } else {
        // Overnight schedule
        if (currentTime >= startTime || currentTime <= endTime) {
          return true;
        }
      }
    }

    // Check exceptions
    if (dndStatus.exceptions && dndStatus.exceptions.length > 0) {
      const currentDate = now.toISOString().split('T')[0];
      const exception = dndStatus.exceptions.find(exp => 
        exp.date === currentDate && exp.enabled
      );
      
      if (exception) {
        return !exception.override; // If override is true, DND is disabled for that day
      }
    }

    return false;
  }

  /**
   * Update last seen timestamp
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Updated user status
   */
  async updateLastSeen(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      let userStatus = await UserStatus.findOne({ userId });
      
      if (!userStatus) {
        userStatus = new UserStatus({ userId });
      }

      userStatus.lastSeen = new Date();
      userStatus.isOnline = true;
      
      // If status was offline, change to online
      if (userStatus.status === 'offline') {
        userStatus.status = 'online';
      }

      await userStatus.save();
      await userStatus.populate('userId', 'username avatar displayName email');

      return this._formatUserStatus(userStatus);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error updating last seen:', error);
      throw new ServerError('Failed to update last seen');
    }
  }

  /**
   * Convert time string to minutes since midnight
   * @private
   * @param {string} timeStr - Time string (HH:MM)
   * @returns {number} Minutes since midnight
   */
  _timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Format user status response
   * @private
   * @param {Object} userStatus - User status document
   * @returns {Object} Formatted user status
   */
  _formatUserStatus(userStatus) {
    return {
      id: userStatus._id,
      userId: userStatus.userId._id,
      username: userStatus.userId.username,
      displayName: userStatus.userId.displayName,
      avatar: userStatus.userId.avatar,
      email: userStatus.userId.email,
      status: userStatus.status,
      customMessage: userStatus.customMessage,
      emoji: userStatus.emoji,
      isOnline: userStatus.isOnline,
      lastSeen: userStatus.lastSeen,
      lastUpdated: userStatus.lastUpdated,
      deviceInfo: userStatus.deviceInfo,
      autoReply: userStatus.autoReply,
      doNotDisturb: userStatus.doNotDisturb,
      customMessageSetAt: userStatus.customMessageSetAt,
      customMessageExpiresAt: userStatus.customMessageExpiresAt,
      expiresAt: userStatus.expiresAt
    };
  }
}

module.exports = new UserStatusService();