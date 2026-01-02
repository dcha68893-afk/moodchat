const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Import middleware and utilities
const {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const User = require('../models/User');
const Status = require('../models/User');

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get user's current status
 */
router.get(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select(
      'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive'
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if status has expired
    if (user.statusExpiresAt && user.statusExpiresAt < new Date()) {
      user.status = 'offline';
      user.statusText = '';
      user.statusEmoji = '';
      user.statusExpiresAt = null;
      await user.save();
    }

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: user._id,
          username: user.username,
          avatar: user.avatar,
          displayName: user.displayName,
          online: user.online,
          status: user.status,
          statusText: user.statusText,
          statusEmoji: user.statusEmoji,
          statusExpiresAt: user.statusExpiresAt,
          lastActive: user.lastActive,
        },
      },
    });
  })
);

/**
 * Update user status
 */
router.put(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { status, statusText, statusEmoji, expiresIn } = req.body;

    // Validate status
    const validStatuses = ['online', 'away', 'busy', 'offline'];
    if (status && !validStatuses.includes(status)) {
      throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
    }

    // Validate expiresIn (in minutes)
    let statusExpiresAt = null;
    if (expiresIn) {
      const expiresInMinutes = parseInt(expiresIn);
      if (isNaN(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 1440) {
        throw new ValidationError('Expires in must be between 1 and 1440 minutes');
      }
      statusExpiresAt = new Date(Date.now() + expiresInMinutes * 60000);
    }

    // Update user status
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (statusText !== undefined) updates.statusText = statusText;
    if (statusEmoji !== undefined) updates.statusEmoji = statusEmoji;
    if (expiresIn !== undefined) updates.statusExpiresAt = statusExpiresAt;

    // Update lastActive if status is online
    if (status === 'online') {
      updates.lastActive = new Date();
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select(
      'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive'
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Broadcast status update to friends via WebSocket
    if (req.io) {
      // Get user's friends
      const currentUser = await User.findById(req.user.id).select('friends');

      if (currentUser.friends && currentUser.friends.length > 0) {
        // Find online friends
        const onlineFriends = await User.find({
          _id: { $in: currentUser.friends },
          online: true,
        }).select('socketIds');

        // Send status update to each online friend
        onlineFriends.forEach(friend => {
          if (friend.socketIds && friend.socketIds.length > 0) {
            friend.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('status:updated', {
                userId: user._id,
                username: user.username,
                avatar: user.avatar,
                status: user.status,
                statusText: user.statusText,
                statusEmoji: user.statusEmoji,
                statusExpiresAt: user.statusExpiresAt,
                lastActive: user.lastActive,
                timestamp: new Date(),
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Status updated successfully',
      data: { user },
    });
  })
);

/**
 * Get friends' statuses
 */
router.get(
  '/friends',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 50,
      status, // Filter by status
      onlineOnly = false,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get user with friends
    const user = await User.findById(req.user.id).populate({
      path: 'friends',
      select:
        'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive',
      options: {
        sort: { online: -1, lastActive: -1 },
      },
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Filter friends
    let friends = user.friends;

    if (status) {
      friends = friends.filter(friend => friend.status === status);
    }

    if (onlineOnly === 'true') {
      friends = friends.filter(friend => friend.online);
    }

    // Apply pagination
    const total = friends.length;
    const paginatedFriends = friends.slice(skip, skip + parseInt(limit));

    // Check for expired statuses
    const now = new Date();
    const friendsWithValidStatus = paginatedFriends.map(friend => {
      const friendObj = friend.toObject();

      // Check if status has expired
      if (friendObj.statusExpiresAt && friendObj.statusExpiresAt < now) {
        friendObj.status = 'offline';
        friendObj.statusText = '';
        friendObj.statusEmoji = '';
        friendObj.statusExpiresAt = null;
      }

      return friendObj;
    });

    res.status(200).json({
      status: 'success',
      data: {
        friends: friendsWithValidStatus,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  })
);

/**
 * Get user's status history
 */
router.get(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, startDate, endDate } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build query
    const query = { user: req.user.id };

    if (startDate) {
      query.createdAt = { ...query.createdAt, $gte: new Date(startDate) };
    }

    if (endDate) {
      query.createdAt = { ...query.createdAt, $lte: new Date(endDate) };
    }

    // Get status history
    const [statusHistory, total] = await Promise.all([
      Status.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Status.countDocuments(query),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        history: statusHistory,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  })
);

/**
 * Set custom status
 */
router.post(
  '/custom',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { text, emoji, expiresIn } = req.body;

    if (!text || text.trim().length === 0) {
      throw new ValidationError('Status text is required');
    }

    if (text.length > 100) {
      throw new ValidationError('Status text must be less than 100 characters');
    }

    // Validate expiresIn (in minutes)
    let expiresAt = null;
    if (expiresIn) {
      const expiresInMinutes = parseInt(expiresIn);
      if (isNaN(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 10080) {
        throw new ValidationError('Expires in must be between 1 and 10080 minutes (1 week)');
      }
      expiresAt = new Date(Date.now() + expiresInMinutes * 60000);
    }

    // Update user status
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        status: 'custom',
        statusText: text.trim(),
        statusEmoji: emoji || '',
        statusExpiresAt: expiresAt,
      },
      { new: true }
    ).select(
      'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive'
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Log status change
    await Status.create({
      user: req.user.id,
      status: 'custom',
      statusText: text.trim(),
      statusEmoji: emoji || '',
      expiresAt: expiresAt,
    });

    // Broadcast status update to friends
    if (req.io) {
      const currentUser = await User.findById(req.user.id).select('friends');

      if (currentUser.friends && currentUser.friends.length > 0) {
        const onlineFriends = await User.find({
          _id: { $in: currentUser.friends },
          online: true,
        }).select('socketIds');

        onlineFriends.forEach(friend => {
          if (friend.socketIds && friend.socketIds.length > 0) {
            friend.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('status:updated', {
                userId: user._id,
                username: user.username,
                avatar: user.avatar,
                status: user.status,
                statusText: user.statusText,
                statusEmoji: user.statusEmoji,
                statusExpiresAt: user.statusExpiresAt,
                timestamp: new Date(),
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Custom status set successfully',
      data: { user },
    });
  })
);

/**
 * Clear custom status
 */
router.delete(
  '/custom',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        status: 'online',
        statusText: '',
        statusEmoji: '',
        statusExpiresAt: null,
      },
      { new: true }
    ).select(
      'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive'
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Log status change
    await Status.create({
      user: req.user.id,
      status: 'online',
      statusText: '',
      statusEmoji: '',
      expiresAt: null,
    });

    // Broadcast status update
    if (req.io) {
      const currentUser = await User.findById(req.user.id).select('friends');

      if (currentUser.friends && currentUser.friends.length > 0) {
        const onlineFriends = await User.find({
          _id: { $in: currentUser.friends },
          online: true,
        }).select('socketIds');

        onlineFriends.forEach(friend => {
          if (friend.socketIds && friend.socketIds.length > 0) {
            friend.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('status:updated', {
                userId: user._id,
                username: user.username,
                avatar: user.avatar,
                status: user.status,
                statusText: user.statusText,
                statusEmoji: user.statusEmoji,
                statusExpiresAt: user.statusExpiresAt,
                timestamp: new Date(),
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Custom status cleared',
      data: { user },
    });
  })
);

/**
 * Get user's presence data (for presence indicators)
 */
router.get(
  '/presence',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userIds } = req.query;

    if (!userIds) {
      throw new ValidationError('User IDs are required');
    }

    const ids = Array.isArray(userIds) ? userIds : [userIds];

    // Validate IDs
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      throw new ValidationError('No valid user IDs provided');
    }

    // Get users' presence data
    const users = await User.find({
      _id: { $in: validIds },
    }).select(
      'username avatar displayName online status statusText statusEmoji statusExpiresAt lastActive'
    );

    // Check for expired statuses
    const now = new Date();
    const usersWithValidStatus = users.map(user => {
      const userObj = user.toObject();

      if (userObj.statusExpiresAt && userObj.statusExpiresAt < now) {
        userObj.status = 'offline';
        userObj.statusText = '';
        userObj.statusEmoji = '';
        userObj.statusExpiresAt = null;
      }

      return userObj;
    });

    res.status(200).json({
      status: 'success',
      data: {
        users: usersWithValidStatus,
      },
    });
  })
);

/**
 * Set user as active (update lastActive timestamp)
 */
router.post(
  '/active',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        lastActive: new Date(),
      },
      { new: true }
    ).select('username avatar displayName online status lastActive');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Only broadcast if status changed to online
    if (!user.online) {
      user.online = true;
      await user.save();

      // Broadcast online status to friends
      if (req.io) {
        const currentUser = await User.findById(req.user.id).select('friends');

        if (currentUser.friends && currentUser.friends.length > 0) {
          const onlineFriends = await User.find({
            _id: { $in: currentUser.friends },
            online: true,
          }).select('socketIds');

          onlineFriends.forEach(friend => {
            if (friend.socketIds && friend.socketIds.length > 0) {
              friend.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('status:online', {
                  userId: user._id,
                  username: user.username,
                  avatar: user.avatar,
                  status: user.status,
                  lastActive: user.lastActive,
                  timestamp: new Date(),
                });
              });
            }
          });
        }
      }
    }

    res.status(200).json({
      status: 'success',
      data: { user },
    });
  })
);

/**
 * Set user as idle/away
 */
router.post(
  '/idle',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { idleTime = 5 } = req.body; // minutes

    const idleMinutes = parseInt(idleTime);
    if (isNaN(idleMinutes) || idleMinutes < 1) {
      throw new ValidationError('Idle time must be at least 1 minute');
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        status: 'away',
        statusExpiresAt: null,
      },
      { new: true }
    ).select('username avatar displayName online status statusText statusEmoji lastActive');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Log status change
    await Status.create({
      user: req.user.id,
      status: 'away',
      statusText: 'Idle',
      idleTime: idleMinutes,
    });

    // Broadcast status update
    if (req.io) {
      const currentUser = await User.findById(req.user.id).select('friends');

      if (currentUser.friends && currentUser.friends.length > 0) {
        const onlineFriends = await User.find({
          _id: { $in: currentUser.friends },
          online: true,
        }).select('socketIds');

        onlineFriends.forEach(friend => {
          if (friend.socketIds && friend.socketIds.length > 0) {
            friend.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('status:updated', {
                userId: user._id,
                username: user.username,
                avatar: user.avatar,
                status: user.status,
                statusText: user.statusText,
                lastActive: user.lastActive,
                timestamp: new Date(),
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Status set to idle',
      data: { user },
    });
  })
);

/**
 * Get status statistics
 */
router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { period = '7d' } = req.query;

    // Calculate date range
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

    // Get status change statistics
    const statusStats = await Status.aggregate([
      {
        $match: {
          user: mongoose.Types.ObjectId(req.user.id),
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            status: '$status',
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          },
          count: { $sum: 1 },
          totalDuration: {
            $sum: {
              $cond: [
                { $gt: ['$expiresAt', '$createdAt'] },
                { $divide: [{ $subtract: ['$expiresAt', '$createdAt'] }, 60000] },
                0,
              ],
            },
          },
        },
      },
      {
        $sort: { '_id.date': 1, '_id.status': 1 },
      },
    ]);

    // Get most used statuses
    const mostUsedStatuses = await Status.aggregate([
      {
        $match: {
          user: mongoose.Types.ObjectId(req.user.id),
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgDuration: {
            $avg: {
              $cond: [
                { $gt: ['$expiresAt', '$createdAt'] },
                { $divide: [{ $subtract: ['$expiresAt', '$createdAt'] }, 60000] },
                0,
              ],
            },
          },
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    // Get current status distribution among friends
    const user = await User.findById(req.user.id).populate({
      path: 'friends',
      select: 'status online',
    });

    const friendStatuses = {};
    user.friends.forEach(friend => {
      friendStatuses[friend.status] = (friendStatuses[friend.status] || 0) + 1;
    });

    res.status(200).json({
      status: 'success',
      data: {
        period,
        totalStatusChanges: statusStats.reduce((sum, stat) => sum + stat.count, 0),
        dailyStats: statusStats,
        mostUsedStatuses,
        friendStatusDistribution: friendStatuses,
        onlineFriends: user.friends.filter(f => f.online).length,
        totalFriends: user.friends.length,
      },
    });
  })
);

/**
 * Schedule status change
 */
router.post(
  '/schedule',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { status, statusText, statusEmoji, scheduleAt } = req.body;

    // Validate required fields
    if (!scheduleAt) {
      throw new ValidationError('Schedule time is required');
    }

    const scheduleTime = new Date(scheduleAt);
    if (isNaN(scheduleTime.getTime()) || scheduleTime <= new Date()) {
      throw new ValidationError('Schedule time must be a future date');
    }

    // Validate status
    const validStatuses = ['online', 'away', 'busy', 'offline', 'custom'];
    if (status && !validStatuses.includes(status)) {
      throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
    }

    // For custom status, text is required
    if (status === 'custom' && (!statusText || statusText.trim().length === 0)) {
      throw new ValidationError('Status text is required for custom status');
    }

    // Create scheduled status
    const scheduledStatus = await Status.create({
      user: req.user.id,
      status: status || 'custom',
      statusText: statusText?.trim(),
      statusEmoji: statusEmoji || '',
      isScheduled: true,
      scheduledAt: scheduleTime,
      expiresAt: null, // Can be set when status becomes active
    });

    res.status(201).json({
      status: 'success',
      message: 'Status scheduled successfully',
      data: { scheduledStatus },
    });
  })
);

/**
 * Get scheduled statuses
 */
router.get(
  '/scheduled',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [scheduledStatuses, total] = await Promise.all([
      Status.find({
        user: req.user.id,
        isScheduled: true,
        scheduledAt: { $gt: new Date() },
      })
        .sort({ scheduledAt: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Status.countDocuments({
        user: req.user.id,
        isScheduled: true,
        scheduledAt: { $gt: new Date() },
      }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        scheduledStatuses,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  })
);

/**
 * Cancel scheduled status
 */
router.delete(
  '/scheduled/:statusId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { statusId } = req.params;

    const scheduledStatus = await Status.findOneAndDelete({
      _id: statusId,
      user: req.user.id,
      isScheduled: true,
    });

    if (!scheduledStatus) {
      throw new NotFoundError('Scheduled status not found');
    }

    res.status(200).json({
      status: 'success',
      message: 'Scheduled status cancelled',
    });
  })
);

module.exports = router;
