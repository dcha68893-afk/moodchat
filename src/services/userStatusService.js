const { Op } = require('sequelize');
const db = require('../models');
const getUserStatus = () => db.UserStatus || (db.getUserStatus && db.getUserStatus()) || null;
const getUser = () => db.User || db.models?.Users || null;
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');

// FIX (presence privacy audit): `User.privacySettings.onlineStatusVisibility`
// ('everyone' | 'friends' | 'nobody') is saved correctly by
// profileService.updatePrivacySettings / routes/settings.js, but until this
// fix NOTHING on the read side ever consulted it. The only privacy check
// anywhere in this file was for the literal status enum value 'invisible' —
// a completely separate, always-true-by-default boolean
// (UserStatus.showOnlineStatus) that nothing ever wrote to. That's why a
// friend's presence could look right or wrong depending on which code path
// served it: the actual saved "who can see my online status" setting was
// write-only and never enforced. This helper is the single place that now
// enforces it for every read path (single status, bulk status, and both
// WebSocket broadcast paths reuse the same rule).
async function getOnlineVisibilityRule(targetUser) {
    try {
        const raw = targetUser && targetUser.privacySettings && targetUser.privacySettings.onlineStatusVisibility;
        if (raw === 'friends' || raw === 'nobody' || raw === 'everyone') return raw;
        return 'everyone'; // default when unset, matches the field's documented default
    } catch (_) {
        return 'everyone';
    }
}

function maskPresence(formattedStatus) {
    return {
        userId: formattedStatus.userId,
        id: formattedStatus.id,
        username: formattedStatus.username,
        displayName: formattedStatus.displayName,
        avatar: formattedStatus.avatar,
        status: 'offline',
        isOnline: false,
        customMessage: formattedStatus.customMessage,
        lastSeen: null,
        isPrivacyMasked: true
    };
}

/**
 * Applies the target user's saved "who can see my online status" setting
 * before returning presence data to a requester. Always returns the true
 * status to the user themselves.
 */
async function applyOnlineVisibility(formattedStatus, targetUserId, requesterId, targetUser, friendIdSet) {
    if (String(targetUserId) === String(requesterId)) return formattedStatus;

    const rule = await getOnlineVisibilityRule(targetUser);
    if (rule === 'everyone') return formattedStatus;
    if (rule === 'nobody') return maskPresence(formattedStatus);

    // rule === 'friends'
    let isFriend;
    if (friendIdSet) {
        isFriend = friendIdSet.has(String(targetUserId));
    } else {
        const friendService = require('./friendService');
        isFriend = await friendService.areFriends(targetUserId, requesterId);
    }
    return isFriend ? formattedStatus : maskPresence(formattedStatus);
}

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

      const { status, customMessage, deviceInfo } = statusData;

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

      // FIX: this used to do `new UserStatus({...})` — UserStatus was never
      // imported/declared in this file, so that line would throw
      // "ReferenceError: UserStatus is not defined" the first time any user
      // without an existing row hit this path. Use the model's own .create().
      const UserStatusModel = getUserStatus();
      let userStatus = await UserStatusModel.findOne({ where: { userId } });
      if (!userStatus) {
        userStatus = await UserStatusModel.create({ userId, status: 'offline' });
      }

      // Update status fields — using the model's own instance methods where
      // they exist (they already handle lastSeen/socketIds correctly) rather
      // than reimplementing that logic here.
      if (status === 'online') {
        await userStatus.setOnline();
      } else if (status === 'offline') {
        await userStatus.setOffline();
      } else if (status === 'away') {
        await userStatus.setAway();
      } else if (status === 'busy') {
        await userStatus.setBusy();
      } else if (status === 'invisible') {
        await userStatus.setInvisible();
      }

      // FIX: the model's actual column for this is `customStatus`, not
      // `customMessage` — the old code wrote to a field that doesn't exist
      // on the model, so it silently never persisted.
      if (customMessage !== undefined) {
        userStatus.customStatus = customMessage;
      }

      // FIX: the model's actual column for this is `activeDevice`, not
      // `deviceInfo`.
      if (deviceInfo) {
        userStatus.activeDevice = deviceInfo;
      }

      if (customMessage !== undefined || deviceInfo) {
        await userStatus.save();
      }

      return this._formatUserStatus(userStatus, user);
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
      const UserStatusModel = getUserStatus();
      let userStatus = await UserStatusModel.findOne({ where: { userId } });

      if (!userStatus) {
        // FIX: `new UserStatus(...)` referenced an undeclared variable and
        // `user._id` was the Mongoose id field — Sequelize uses `user.id`.
        userStatus = await UserStatusModel.create({
          userId: user.id,
          status: 'offline',
          lastSeen: new Date()
        });
      }

      // Check privacy settings
      const formattedStatus = this._formatUserStatus(userStatus, user);
      
      // If user is invisible, only show to self
      if (formattedStatus.status === 'invisible' && String(userId) !== String(requesterId)) {
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

      // FIX (presence privacy audit): enforce the saved
      // onlineStatusVisibility setting — see applyOnlineVisibility above.
      return applyOnlineVisibility(formattedStatus, userId, requesterId, user);
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

      // FIX: this whole method assumed `status.userId` was a Mongoose-
      // populated User document (`status.userId._id.toString()`) — in this
      // Sequelize schema `userId` on a UserStatus row is just an integer FK,
      // so that line threw every time this endpoint was called (i.e. every
      // time a contact list tried to load initial online/offline dots for
      // more than one contact at once). Fetch both in parallel batch queries
      // and join them in memory instead.
      const [userStatuses, users] = await Promise.all([
        getUserStatus().findAll({ where: { userId: { [Op.in]: userIds } } }),
        getUser().findAll({ where: { id: { [Op.in]: userIds } } })
      ]);

      const userMap = new Map(users.map(u => [String(u.id), u]));
      const statusMap = new Map(userStatuses.map(s => [String(s.userId), s]));

      // FIX (presence privacy audit): fetch the requester's accepted friend
      // ids ONCE instead of one areFriends() query per contact, so the
      // 'friends'-only visibility rule doesn't turn a 100-contact list load
      // into 100 extra queries.
      let friendIdSet = null;
      try {
        const Friend = db.Friend || db.models?.Friend;
        if (Friend) {
          const rows = await Friend.findAll({
            where: {
              status: 'accepted',
              [Op.or]: [{ requesterId }, { receiverId: requesterId }]
            }
          });
          friendIdSet = new Set(rows.map(r => String(r.requesterId === requesterId || String(r.requesterId) === String(requesterId) ? r.receiverId : r.requesterId)));
        }
      } catch (_) { friendIdSet = null; }

      const results = [];
      for (const userId of userIds) {
        const user = userMap.get(String(userId));
        if (!user) continue; // unknown user id — skip rather than fail the whole batch

        let status = statusMap.get(String(userId));
        if (!status) {
          status = await getUserStatus().create({
            userId: user.id,
            status: 'offline',
            lastSeen: new Date()
          });
        }

        let formattedStatus = this._formatUserStatus(status, user);

        // Handle invisible status
        if (formattedStatus.status === 'invisible' && String(userId) !== String(requesterId)) {
          results.push({
            userId: formattedStatus.userId,
            username: formattedStatus.username,
            avatar: formattedStatus.avatar,
            status: 'offline',
            isOnline: false,
            lastSeen: formattedStatus.lastSeen,
            isInvisible: true
          });
          continue;
        }

        // FIX (presence privacy audit): enforce the saved
        // onlineStatusVisibility setting for this contact too.
        formattedStatus = await applyOnlineVisibility(formattedStatus, userId, requesterId, user, friendIdSet);
        results.push(formattedStatus);
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

      // NOTE: there is no status-history table in the current schema —
      // UserStatus stores only the current status per user (one row per
      // userId). This was previously a broken/merged stub that crashed on
      // require(). Returning an empty, correctly-paginated result here
      // restores the route to a working (if not yet feature-complete) state.
      // To implement real history, add a StatusHistory model/table and
      // record a row on every status change.
      void startDate; void endDate; void status; // reserved for future filtering

      return {
        history: [],
        pagination: {
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          total: 0,
          totalPages: 0
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
   * Get a user's Do Not Disturb settings.
   * NOTE: there is no doNotDisturb column on UserStatus in the current
   * schema. Returns the safe default shape until a column/table is added;
   * isDoNotDisturbActive() below already handles this shape correctly.
   * @param {string|number} userId - User ID
   * @returns {Promise<Object>} DND status object
   */
  async getDoNotDisturbStatus(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const userStatus = await getUserStatus().findOne({ where: { userId } });

      return (userStatus && userStatus.doNotDisturb) || {
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

      const UserStatusModel = getUserStatus();
      let userStatus = await UserStatusModel.findOne({ where: { userId } });

      if (!userStatus) {
        userStatus = await UserStatusModel.create({ userId, status: 'online', lastSeen: new Date() });
      } else if (userStatus.status === 'offline') {
        // Coming back from offline counts as an online transition.
        await userStatus.setOnline();
      } else {
        await userStatus.updateLastSeen();
      }

      const user = await getUser().findByPk(userId);
      return this._formatUserStatus(userStatus, user);
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
   * @param {Object} userStatus - UserStatus row (Sequelize instance)
   * @param {Object} [user] - The associated User row, if already fetched —
   *   userId on UserStatus is just an integer FK, not a populated object,
   *   so display fields (username/avatar/etc.) have to come from here.
   * @returns {Object} Formatted user status
   */
  _formatUserStatus(userStatus, user) {
    const displayName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username : undefined;
    return {
      id: userStatus.id,
      userId: userStatus.userId,
      username: user?.username,
      displayName,
      avatar: user?.avatar,
      email: user?.email,
      status: userStatus.status,
      customMessage: userStatus.customStatus,
      isOnline: typeof userStatus.isOnline === 'function' ? userStatus.isOnline() : userStatus.status === 'online',
      lastSeen: userStatus.lastSeen,
      lastUpdated: userStatus.updatedAt,
      deviceInfo: userStatus.activeDevice
    };
  }
}

module.exports = new UserStatusService();