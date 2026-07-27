const userStatusService = require('../services/userStatusService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// PHASE15 FIX: Lazy-require WebSocketService to get real-time socket presence
// This ensures isOnline reflects the LIVE socket connection, not just what's in the DB.
// Without this, a user who just connected still shows as "offline" until the DB is updated.
let _wsService = null;
function getWS() {
  if (!_wsService) {
    try { _wsService = require('../services/webSocketService'); } catch(_) {}
  }
  return _wsService;
}

/**
 * PHASE15 FIX: enrichWithSocketPresence
 * Overrides isOnline/status on a userStatus object (or array of them)
 * with the authoritative live socket-map truth from WebSocketService.
 * Falls back gracefully when the socket service is unavailable.
 */
async function enrichWithSocketPresence(userStatusOrArray) {
  const ws = getWS();
  if (!ws || typeof ws.isUserOnline !== 'function') return userStatusOrArray;

  const enrichOne = async (us) => {
    if (!us || !us.userId) return us;
    try {
      const reallyOnline = await ws.isUserOnline(us.userId);
      // Only upgrade to online — never hide a user who explicitly set "invisible"
      if (us.status === 'invisible') return us;
      // Sync isOnline with socket reality; update status string if mismatch
      us.isOnline = reallyOnline;
      if (reallyOnline && us.status === 'offline') us.status = 'online';
      if (!reallyOnline && us.status === 'online') us.status = 'offline';
    } catch (_) {}
    return us;
  };

  if (Array.isArray(userStatusOrArray)) {
    return Promise.all(userStatusOrArray.map(enrichOne));
  }
  return enrichOne(userStatusOrArray);
}


class UserStatusController {
  /**
   * Update user status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateStatus(req, res, next) {
    try {
      const userId = req.user.id;
      const { status, customMessage, expiresAt, deviceInfo } = req.body;

      if (!status) {
        throw new AppError('Status is required', 400);
      }

      const validStatuses = ['online', 'away', 'busy', 'offline', 'invisible'];
      if (!validStatuses.includes(status)) {
        throw new AppError(`Invalid status. Valid values: ${validStatuses.join(', ')}`, 400);
      }

      const userStatus = await userStatusService.updateStatus(userId, {
        status,
        customMessage,
        expiresAt,
        deviceInfo
      });

      // FIX (presence privacy audit): this used to be req.io.emit(...) — a
      // GLOBAL broadcast to every connected socket in the app, with the
      // user's real status/isOnline value, no scoping to contacts and no
      // check of onlineStatusVisibility at all. That's a double bug: (1) it
      // leaked presence to people who aren't even contacts, and (2)
      // depending on timing it could race with the properly-scoped,
      // privacy-aware connect/disconnect broadcast in webSocketService.js,
      // which is exactly the kind of conflict that produces "sometimes says
      // online when offline and vice versa". Route this through the same
      // scoped + privacy-aware broadcaster instead.
      if (req.io) {
        try {
          const ws = require('../services/webSocketService');
          if (ws && typeof ws._broadcastPresenceToContacts === 'function') {
            await ws._broadcastPresenceToContacts(userId, 'status:updated', {
              userId,
              status: userStatus.status,
              customMessage: userStatus.customMessage,
              lastSeen: userStatus.lastSeen,
              isOnline: userStatus.isOnline,
              timestamp: new Date()
            });
          }
        } catch (_) {}
      }

      res.status(200).json({
        success: true,
        message: 'Status updated successfully',
        data: {
          userStatus
        }
      });
    } catch (error) {
      logger.error('Update status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to update status', 500));
      }
    }
  }

  /**
   * Get user status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getStatus(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Check if user has permission to view this status
      let userStatus = await userStatusService.getStatus(userId, currentUserId);

      // PHASE15 FIX: Override DB isOnline with live socket truth
      userStatus = await enrichWithSocketPresence(userStatus);

      res.status(200).json({
        success: true,
        message: 'User status retrieved successfully',
        data: {
          userStatus
        }
      });
    } catch (error) {
      logger.error('Get status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get user status', 500));
      }
    }
  }

  /**
   * Get multiple users' statuses
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getBulkStatus(req, res, next) {
    try {
      const currentUserId = req.user.id;
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new AppError('User IDs array is required', 400);
      }

      // Limit the number of users to prevent abuse
      if (userIds.length > 100) {
        throw new AppError('Maximum 100 users allowed per request', 400);
      }

      let statuses = await userStatusService.getBulkStatus(userIds, currentUserId);

      // PHASE15 FIX: Enrich every status entry with live socket presence truth
      statuses = await enrichWithSocketPresence(statuses);

      res.status(200).json({
        success: true,
        message: 'Bulk statuses retrieved successfully',
        data: {
          statuses,
          count: statuses.length
        }
      });
    } catch (error) {
      logger.error('Get bulk status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get bulk statuses', 500));
      }
    }
  }

  /**
   * Get user's status history
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getStatusHistory(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        startDate,
        endDate,
        status
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      // Users can only view their own history or if admin
      if (userId !== currentUserId.toString() && !req.user.isAdmin) {
        throw new AppError('Not authorized to view this user\'s status history', 403);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        status
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const history = await userStatusService.getStatusHistory(userId, options);

      res.status(200).json({
        success: true,
        message: 'Status history retrieved successfully',
        data: history
      });
    } catch (error) {
      logger.error('Get status history controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get status history', 500));
      }
    }
  }

  /**
   * Set custom status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async setCustomStatus(req, res, next) {
    try {
      const userId = req.user.id;
      const { customMessage, emoji, expiresAt } = req.body;

      if (!customMessage) {
        throw new AppError('Custom message is required', 400);
      }

      // Validate custom message length
      if (customMessage.length > 100) {
        throw new AppError('Custom message cannot exceed 100 characters', 400);
      }

      const userStatus = await userStatusService.setCustomStatus(userId, {
        customMessage,
        emoji,
        expiresAt
      });

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:custom:updated', {
          userId,
          customMessage: userStatus.customMessage,
          emoji: userStatus.emoji,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Custom status set successfully',
        data: {
          userStatus
        }
      });
    } catch (error) {
      logger.error('Set custom status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to set custom status', 500));
      }
    }
  }

  /**
   * Clear custom status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async clearCustomStatus(req, res, next) {
    try {
      const userId = req.user.id;

      const userStatus = await userStatusService.clearCustomStatus(userId);

      // Emit WebSocket event for real-time updates
      if (req.io) {
        req.io.emit('status:custom:cleared', {
          userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Custom status cleared successfully',
        data: {
          userStatus
        }
      });
    } catch (error) {
      logger.error('Clear custom status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to clear custom status', 500));
      }
    }
  }

  /**
   * Set auto-reply message
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async setAutoReply(req, res, next) {
    try {
      const userId = req.user.id;
      const { message, enabled = true, schedule } = req.body;

      if (!message && enabled) {
        throw new AppError('Auto-reply message is required when enabling', 400);
      }

      const autoReply = await userStatusService.setAutoReply(userId, {
        message,
        enabled,
        schedule
      });

      res.status(200).json({
        success: true,
        message: `Auto-reply ${enabled ? 'enabled' : 'disabled'} successfully`,
        data: {
          autoReply
        }
      });
    } catch (error) {
      logger.error('Set auto-reply controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to set auto-reply', 500));
      }
    }
  }

  /**
   * Get online users count
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getOnlineCount(req, res, next) {
    try {
      const count = await userStatusService.getOnlineUsersCount();

      res.status(200).json({
        success: true,
        message: 'Online users count retrieved successfully',
        data: {
          onlineCount: count,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error('Get online count controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get online users count', 500));
      }
    }
  }

  /**
   * Get users by status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getUsersByStatus(req, res, next) {
    try {
      const { status } = req.params;
      const { 
        page = 1, 
        limit = 50,
        includeInvisible = false
      } = req.query;

      const validStatuses = ['online', 'away', 'busy', 'offline', 'invisible'];
      if (!validStatuses.includes(status)) {
        throw new AppError(`Invalid status. Valid values: ${validStatuses.join(', ')}`, 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        includeInvisible: includeInvisible === 'true'
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await userStatusService.getUsersByStatus(status, options);

      res.status(200).json({
        success: true,
        message: `Users with status "${status}" retrieved successfully`,
        data: result
      });
    } catch (error) {
      logger.error('Get users by status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get users by status', 500));
      }
    }
  }

  /**
   * Set do not disturb schedule
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async setDoNotDisturbSchedule(req, res, next) {
    try {
      const userId = req.user.id;
      const { schedule, enabled = true, exceptions } = req.body;

      if (!schedule && enabled) {
        throw new AppError('Schedule is required when enabling Do Not Disturb', 400);
      }

      const dndStatus = await userStatusService.setDoNotDisturbSchedule(userId, {
        schedule,
        enabled,
        exceptions
      });

      res.status(200).json({
        success: true,
        message: `Do Not Disturb ${enabled ? 'enabled' : 'disabled'} successfully`,
        data: {
          doNotDisturb: dndStatus
        }
      });
    } catch (error) {
      logger.error('Set Do Not Disturb controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to set Do Not Disturb schedule', 500));
      }
    }
  }

  /**
   * Get do not disturb status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getDoNotDisturbStatus(req, res, next) {
    try {
      const userId = req.user.id;

      const dndStatus = await userStatusService.getDoNotDisturbStatus(userId);

      res.status(200).json({
        success: true,
        message: 'Do Not Disturb status retrieved successfully',
        data: {
          doNotDisturb: dndStatus,
          isActive: dndStatus.enabled && userStatusService.isDoNotDisturbActive(dndStatus)
        }
      });
    } catch (error) {
      logger.error('Get Do Not Disturb status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get Do Not Disturb status', 500));
      }
    }
  }

  /**
   * Handle status WebSocket events
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async handleStatusWebSocket(req, res, next) {
    try {
      const userId = req.user.id;
      const { action, data } = req.body;

      if (!action) {
        throw new AppError('Action is required', 400);
      }

      let result;
      switch (action) {
        case 'update':
          result = await userStatusService.updateStatus(userId, data);
          break;
        case 'setCustom':
          result = await userStatusService.setCustomStatus(userId, data);
          break;
        case 'clearCustom':
          result = await userStatusService.clearCustomStatus(userId);
          break;
        case 'heartbeat':
          result = await userStatusService.updateLastSeen(userId);
          break;
        default:
          throw new AppError(`Invalid action: ${action}`, 400);
      }

      // Broadcast status update to all connected clients
      if (req.io) {
        req.io.emit('status:ws:update', {
          userId,
          action,
          data: result,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: `Status action "${action}" completed via WebSocket`,
        data: {
          result,
          action
        }
      });
    } catch (error) {
      logger.error('Status WebSocket controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to handle status WebSocket event', 500));
      }
    }
  }
}

module.exports = new UserStatusController();