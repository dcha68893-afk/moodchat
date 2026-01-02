const mongoose = require('mongoose');
const UserStatus = require('../models/UserStatus');
const User = require('../models/User');
const { ServerError, ValidationError, NotFoundError } = require('../utils/errors');
const {
  STATUS_EXPIRY_MINUTES = 5,
  MAX_STATUS_LENGTH = 100,
  STATUS_TYPES = 'online,away,busy,offline,custom',
} = process.env;

// Parse status types from environment variable
const VALID_STATUS_TYPES = STATUS_TYPES.split(',');

/**
 * Status Service
 * Handles user presence and status management
 */
class StatusService {
  /**
   * Update user status and presence
   * @param {string} userId - User ID
   * @param {string} statusType - Type of status (online, away, busy, offline, custom)
   * @param {string} customStatus - Custom status message (optional)
   * @returns {Promise<Object>} Updated status
   */
  async updateStatus(userId, statusType, customStatus = null) {
    try {
      if (!userId || !statusType) {
        throw new ValidationError('User ID and status type are required');
      }

      // Validate status type
      if (!VALID_STATUS_TYPES.includes(statusType)) {
        throw new ValidationError(`Status type must be one of: ${VALID_STATUS_TYPES.join(', ')}`);
      }

      // Validate custom status length
      if (customStatus && customStatus.length > parseInt(MAX_STATUS_LENGTH)) {
        throw new ValidationError(`Custom status cannot exceed ${MAX_STATUS_LENGTH} characters`);
      }

      // Calculate expiry time
      const expiryMinutes = parseInt(STATUS_EXPIRY_MINUTES);
      const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

      // Find or create user status
      let userStatus = await UserStatus.findOne({ userId: new mongoose.Types.ObjectId(userId) });

      if (!userStatus) {
        userStatus = new UserStatus({
          userId: new mongoose.Types.ObjectId(userId),
          status: statusType,
          customStatus: statusType === 'custom' ? customStatus : null,
          lastSeen: new Date(),
          expiresAt: statusType === 'offline' ? null : expiresAt,
        });
      } else {
        // Update existing status
        userStatus.status = statusType;
        userStatus.customStatus = statusType === 'custom' ? customStatus : null;
        userStatus.lastSeen = new Date();
        userStatus.expiresAt = statusType === 'offline' ? null : expiresAt;
      }

      await userStatus.save();

      // Populate user details for response
      await userStatus.populate({
        path: 'userId',
        select: '_id username email profilePicture',
      });

      return this._formatStatusResponse(userStatus);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error updating status:', error);
      throw new ServerError('Failed to update status');
    }
  }

  /**
   * Get status for specific users
   * @param {string} requesterId - User ID making the request
   * @param {Array<string>} userIds - Array of user IDs to get status for
   * @returns {Promise<Array>} Status information for requested users
   */
  async getUsersStatus(requesterId, userIds) {
    try {
      if (!requesterId || !userIds || !Array.isArray(userIds)) {
        throw new ValidationError('Requester ID and user IDs array are required');
      }

      // Limit number of users to prevent abuse
      if (userIds.length > 100) {
        throw new ValidationError('Cannot fetch status for more than 100 users at once');
      }

      // Convert to ObjectIds
      const userObjectIds = userIds.map(id => new mongoose.Types.ObjectId(id));

      // Clean expired statuses first
      await this._cleanExpiredStatuses();

      // Fetch statuses
      const statuses = await UserStatus.find({
        userId: { $in: userObjectIds },
      }).populate({
        path: 'userId',
        select: '_id username email profilePicture',
      });

      // Create a map for quick lookup
      const statusMap = new Map();
      statuses.forEach(status => {
        statusMap.set(status.userId._id.toString(), this._formatStatusResponse(status));
      });

      // For users without status records, create default offline status
      const result = [];
      for (const userId of userIds) {
        if (statusMap.has(userId)) {
          result.push(statusMap.get(userId));
        } else {
          // Create default offline status
          const user = await User.findById(userId).select('_id username email profilePicture');
          if (user) {
            result.push({
              userId: user._id,
              user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                profilePicture: user.profilePicture,
              },
              status: 'offline',
              customStatus: null,
              lastSeen: null,
              isOnline: false,
            });
          }
        }
      }

      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching users status:', error);
      throw new ServerError('Failed to fetch users status');
    }
  }

  /**
   * Get online friends/contacts status
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Online contacts with their status
   */
  async getOnlineContacts(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Clean expired statuses first
      await this._cleanExpiredStatuses();

      // Get user's contacts/friends (implementation depends on your contact system)
      // This is a placeholder - adjust based on your application's contact/friend system
      const user = await User.findById(userId).select('contacts friends');

      let contactIds = [];

      // Adjust based on your data model
      if (user.contacts && user.contacts.length > 0) {
        contactIds = user.contacts;
      } else if (user.friends && user.friends.length > 0) {
        contactIds = user.friends;
      }

      if (contactIds.length === 0) {
        return [];
      }

      // Fetch online statuses for contacts
      const onlineStatuses = await UserStatus.find({
        userId: { $in: contactIds },
        status: { $ne: 'offline' },
        expiresAt: { $gt: new Date() },
      }).populate({
        path: 'userId',
        select: '_id username email profilePicture',
      });

      return onlineStatuses.map(status => this._formatStatusResponse(status));
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching online contacts:', error);
      throw new ServerError('Failed to fetch online contacts');
    }
  }

  /**
   * Update last seen timestamp
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Updated status
   */
  async updateLastSeen(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const userStatus = await UserStatus.findOne({ userId: new mongoose.Types.ObjectId(userId) });

      if (!userStatus) {
        // Create a new status record if none exists
        return await this.updateStatus(userId, 'online');
      }

      // Update last seen and extend expiry if not offline
      userStatus.lastSeen = new Date();
      if (userStatus.status !== 'offline') {
        const expiryMinutes = parseInt(STATUS_EXPIRY_MINUTES);
        userStatus.expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
      }

      await userStatus.save();

      await userStatus.populate({
        path: 'userId',
        select: '_id username email profilePicture',
      });

      return this._formatStatusResponse(userStatus);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error updating last seen:', error);
      throw new ServerError('Failed to update last seen');
    }
  }

  /**
   * Set user as offline
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Updated status
   */
  async setOffline(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const userStatus = await UserStatus.findOne({ userId: new mongoose.Types.ObjectId(userId) });

      if (!userStatus) {
        // Create offline status if none exists
        const newStatus = new UserStatus({
          userId: new mongoose.Types.ObjectId(userId),
          status: 'offline',
          lastSeen: new Date(),
          expiresAt: null,
        });

        await newStatus.save();
        await newStatus.populate({
          path: 'userId',
          select: '_id username email profilePicture',
        });

        return this._formatStatusResponse(newStatus);
      }

      // Update to offline status
      userStatus.status = 'offline';
      userStatus.customStatus = null;
      userStatus.lastSeen = new Date();
      userStatus.expiresAt = null;

      await userStatus.save();

      await userStatus.populate({
        path: 'userId',
        select: '_id username email profilePicture',
      });

      return this._formatStatusResponse(userStatus);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error setting offline status:', error);
      throw new ServerError('Failed to set offline status');
    }
  }

  /**
   * Get user's current status
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User status
   */
  async getUserStatus(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Clean expired statuses first
      await this._cleanExpiredStatuses();

      const userStatus = await UserStatus.findOne({
        userId: new mongoose.Types.ObjectId(userId),
      }).populate({
        path: 'userId',
        select: '_id username email profilePicture',
      });

      if (!userStatus) {
        // Return default offline status
        const user = await User.findById(userId).select('_id username email profilePicture');
        if (!user) {
          throw new NotFoundError('User not found');
        }

        return {
          userId: user._id,
          user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            profilePicture: user.profilePicture,
          },
          status: 'offline',
          customStatus: null,
          lastSeen: null,
          isOnline: false,
        };
      }

      // Check if status is expired
      if (userStatus.expiresAt && userStatus.expiresAt < new Date()) {
        userStatus.status = 'offline';
        userStatus.customStatus = null;
        userStatus.expiresAt = null;
        await userStatus.save();
      }

      return this._formatStatusResponse(userStatus);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error getting user status:', error);
      throw new ServerError('Failed to get user status');
    }
  }

  /**
   * Clean up expired statuses
   * @private
   */
  async _cleanExpiredStatuses() {
    try {
      const result = await UserStatus.updateMany(
        {
          expiresAt: { $lt: new Date(), $ne: null },
        },
        {
          $set: {
            status: 'offline',
            customStatus: null,
            expiresAt: null,
          },
        }
      );

      if (result.modifiedCount > 0) {
        console.log(`Cleaned ${result.modifiedCount} expired statuses`);
      }
    } catch (error) {
      console.error('Error cleaning expired statuses:', error);
      // Don't throw, this is a maintenance operation
    }
  }

  /**
   * Format status response
   * @private
   * @param {Object} userStatus - UserStatus document
   * @returns {Object} Formatted status response
   */
  _formatStatusResponse(userStatus) {
    const isOnline =
      userStatus.status !== 'offline' &&
      (!userStatus.expiresAt || userStatus.expiresAt > new Date());

    return {
      userId: userStatus.userId._id,
      user: {
        _id: userStatus.userId._id,
        username: userStatus.userId.username,
        email: userStatus.userId.email,
        profilePicture: userStatus.userId.profilePicture,
      },
      status: userStatus.status,
      customStatus: userStatus.customStatus,
      lastSeen: userStatus.lastSeen,
      expiresAt: userStatus.expiresAt,
      isOnline,
    };
  }

  /**
   * Get all online users (for admin/stats purposes)
   * @param {number} limit - Maximum number of results
   * @returns {Promise<Array>} Online users with status
   */
  async getAllOnlineUsers(limit = 100) {
    try {
      // Clean expired statuses first
      await this._cleanExpiredStatuses();

      const onlineUsers = await UserStatus.find({
        status: { $ne: 'offline' },
        expiresAt: { $gt: new Date() },
      })
        .limit(parseInt(limit))
        .populate({
          path: 'userId',
          select: '_id username email profilePicture',
        })
        .sort({ lastSeen: -1 });

      return onlineUsers.map(status => this._formatStatusResponse(status));
    } catch (error) {
      console.error('Error fetching all online users:', error);
      throw new ServerError('Failed to fetch online users');
    }
  }
}

module.exports = new StatusService();
