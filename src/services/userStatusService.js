const { Op } = require('sequelize');
const db = require('../models');
const getUserStatus = () => db.UserStatus || (db.getUserStatus && db.getUserStatus()) || null;
const getUser = () => db.User || db.models?.Users || null;
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
      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Find or create user status
      let userStatus = await getUserStatus().findOne({ where: { userId } });
      
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
      await userStatus;

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
        getUser().findByPk(userId),
        getUser().findByPk(requesterId)
      ]);

      if (!user || !requester) {
        throw new NotFoundError('User not found');
      }

      // Get user status
      let userStatus = await getUserStatus().findOne({ where: { userId } });

      if (!userStatus) {
        // Create default status if not exists
        userStatus = new UserStatus({
          userId: user._id,
          status: 'offline',
          isOnline: false,
          lastSeen: new Date()
        });
        await userStatus.save();
        await userStatus;
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
      const userStatuses = await getUserStatus().findAll({
        where: { userId: { [Op.in]: userIds } }
      });

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
          const user = await getUser().findByPk(userId);
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
        if (startDate) query.timestamp_gte = startDate;
        if (endDate) query.timestamp_lte = endDate;
      }
      
      if (status) {
        query.status = status;
      }

      const [history, total] = await Promise.all([
        [],
        [],
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

      let userStatus = await getUserStatus().findOne({ where: { userId } });
      
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
      await userStatus;

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