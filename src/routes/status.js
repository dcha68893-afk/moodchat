const express = require('express');
const router = express.Router();
const sequelize = require('sequelize');
const {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, Status } = require('../models');

router.use(authMiddleware);

console.log('✅ Status routes initialized');

router.get(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'statusExpiresAt', 'lastActive']
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      if (user.statusExpiresAt && user.statusExpiresAt < new Date()) {
        await user.update({
          status: 'offline',
          statusText: '',
          statusEmoji: '',
          statusExpiresAt: null
        });
      }

      res.status(200).json({
        status: 'success',
        data: {
          user: {
            id: user.id,
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
    } catch (error) {
      console.error('Error fetching user status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user status'
      });
    }
  })
);

router.put(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { status, statusText, statusEmoji, expiresIn } = req.body;

      const validStatuses = ['online', 'away', 'busy', 'offline'];
      if (status && !validStatuses.includes(status)) {
        throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
      }

      let statusExpiresAt = null;
      if (expiresIn) {
        const expiresInMinutes = parseInt(expiresIn);
        if (isNaN(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 1440) {
          throw new ValidationError('Expires in must be between 1 and 1440 minutes');
        }
        statusExpiresAt = new Date(Date.now() + expiresInMinutes * 60000);
      }

      const updates = {};
      if (status !== undefined) updates.status = status;
      if (statusText !== undefined) updates.statusText = statusText;
      if (statusEmoji !== undefined) updates.statusEmoji = statusEmoji;
      if (expiresIn !== undefined) updates.statusExpiresAt = statusExpiresAt;

      if (status === 'online') {
        updates.lastActive = new Date();
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update(updates);

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'statusExpiresAt', 'lastActive']
      });

      if (req.io) {
        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id']
          }]
        });

        if (currentUser.friends && currentUser.friends.length > 0) {
          const onlineFriends = await User.findAll({
            where: {
              id: currentUser.friends.map(f => f.id),
              online: true
            },
            attributes: ['id', 'socketIds']
          });

          onlineFriends.forEach(friend => {
            if (friend.socketIds && friend.socketIds.length > 0) {
              friend.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('status:updated', {
                  userId: updatedUser.id,
                  username: updatedUser.username,
                  avatar: updatedUser.avatar,
                  status: updatedUser.status,
                  statusText: updatedUser.statusText,
                  statusEmoji: updatedUser.statusEmoji,
                  statusExpiresAt: updatedUser.statusExpiresAt,
                  lastActive: updatedUser.lastActive,
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
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error updating status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update status'
      });
    }
  })
);

router.get(
  '/friends',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        status,
        onlineOnly = false,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'statusExpiresAt', 'lastActive'],
          through: { attributes: [] }
        }]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      let friends = user.friends;

      if (status) {
        friends = friends.filter(friend => friend.status === status);
      }

      if (onlineOnly === 'true') {
        friends = friends.filter(friend => friend.online);
      }

      const total = friends.length;
      const paginatedFriends = friends.slice(offset, offset + parseInt(limit));

      const now = new Date();
      const friendsWithValidStatus = paginatedFriends.map(friend => {
        const friendObj = friend.toJSON();

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
    } catch (error) {
      console.error('Error fetching friends statuses:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friends statuses'
      });
    }
  })
);

router.get(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20, startDate, endDate } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { userId: req.user.id };

      if (startDate) {
        where.createdAt = { ...where.createdAt, [sequelize.Op.gte]: new Date(startDate) };
      }

      if (endDate) {
        where.createdAt = { ...where.createdAt, [sequelize.Op.lte]: new Date(endDate) };
      }

      const { count, rows: statusHistory } = await Status.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        offset,
        limit: parseInt(limit)
      });

      res.status(200).json({
        status: 'success',
        data: {
          history: statusHistory,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching status history:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch status history'
      });
    }
  })
);

router.post(
  '/custom',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { text, emoji, expiresIn } = req.body;

      if (!text || text.trim().length === 0) {
        throw new ValidationError('Status text is required');
      }

      if (text.length > 100) {
        throw new ValidationError('Status text must be less than 100 characters');
      }

      let expiresAt = null;
      if (expiresIn) {
        const expiresInMinutes = parseInt(expiresIn);
        if (isNaN(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 10080) {
          throw new ValidationError('Expires in must be between 1 and 10080 minutes (1 week)');
        }
        expiresAt = new Date(Date.now() + expiresInMinutes * 60000);
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update({
        status: 'custom',
        statusText: text.trim(),
        statusEmoji: emoji || '',
        statusExpiresAt: expiresAt,
      });

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'statusExpiresAt', 'lastActive']
      });

      await Status.create({
        userId: req.user.id,
        status: 'custom',
        statusText: text.trim(),
        statusEmoji: emoji || '',
        expiresAt: expiresAt,
      });

      if (req.io) {
        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id']
          }]
        });

        if (currentUser.friends && currentUser.friends.length > 0) {
          const onlineFriends = await User.findAll({
            where: {
              id: currentUser.friends.map(f => f.id),
              online: true
            },
            attributes: ['id', 'socketIds']
          });

          onlineFriends.forEach(friend => {
            if (friend.socketIds && friend.socketIds.length > 0) {
              friend.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('status:updated', {
                  userId: updatedUser.id,
                  username: updatedUser.username,
                  avatar: updatedUser.avatar,
                  status: updatedUser.status,
                  statusText: updatedUser.statusText,
                  statusEmoji: updatedUser.statusEmoji,
                  statusExpiresAt: updatedUser.statusExpiresAt,
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
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error setting custom status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to set custom status'
      });
    }
  })
);

router.delete(
  '/custom',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update({
        status: 'online',
        statusText: '',
        statusEmoji: '',
        statusExpiresAt: null,
      });

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'statusExpiresAt', 'lastActive']
      });

      await Status.create({
        userId: req.user.id,
        status: 'online',
        statusText: '',
        statusEmoji: '',
        expiresAt: null,
      });

      if (req.io) {
        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id']
          }]
        });

        if (currentUser.friends && currentUser.friends.length > 0) {
          const onlineFriends = await User.findAll({
            where: {
              id: currentUser.friends.map(f => f.id),
              online: true
            },
            attributes: ['id', 'socketIds']
          });

          onlineFriends.forEach(friend => {
            if (friend.socketIds && friend.socketIds.length > 0) {
              friend.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('status:updated', {
                  userId: updatedUser.id,
                  username: updatedUser.username,
                  avatar: updatedUser.avatar,
                  status: updatedUser.status,
                  statusText: updatedUser.statusText,
                  statusEmoji: updatedUser.statusEmoji,
                  statusExpiresAt: updatedUser.statusExpiresAt,
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
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error clearing custom status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to clear custom status'
      });
    }
  })
);

router.get(
  '/presence',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userIds } = req.query;

      if (!userIds) {
        throw new ValidationError('User IDs are required');
      }

      const ids = Array.isArray(userIds) ? userIds : [userIds];
      const validIds = ids.filter(id => /^[0-9a-fA-F-]{36}$/.test(id));

      if (validIds.length === 0) {
        throw new ValidationError('No valid user IDs provided');
      }

      const users = await User.findAll({
        where: { id: validIds },
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'statusExpiresAt', 'lastActive']
      });

      const now = new Date();
      const usersWithValidStatus = users.map(user => {
        const userObj = user.toJSON();

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
    } catch (error) {
      console.error('Error fetching presence data:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch presence data'
      });
    }
  })
);

router.post(
  '/active',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update({
        lastActive: new Date(),
      });

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'lastActive']
      });

      if (!updatedUser.online) {
        await updatedUser.update({ online: true });

        if (req.io) {
          const currentUser = await User.findByPk(req.user.id, {
            include: [{
              model: User,
              as: 'friends',
              attributes: ['id']
            }]
          });

          if (currentUser.friends && currentUser.friends.length > 0) {
            const onlineFriends = await User.findAll({
              where: {
                id: currentUser.friends.map(f => f.id),
                online: true
              },
              attributes: ['id', 'socketIds']
            });

            onlineFriends.forEach(friend => {
              if (friend.socketIds && friend.socketIds.length > 0) {
                friend.socketIds.forEach(socketId => {
                  req.io.to(socketId).emit('status:online', {
                    userId: updatedUser.id,
                    username: updatedUser.username,
                    avatar: updatedUser.avatar,
                    status: updatedUser.status,
                    lastActive: updatedUser.lastActive,
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
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error setting user as active:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to set user as active'
      });
    }
  })
);

router.post(
  '/idle',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { idleTime = 5 } = req.body;

      const idleMinutes = parseInt(idleTime);
      if (isNaN(idleMinutes) || idleMinutes < 1) {
        throw new ValidationError('Idle time must be at least 1 minute');
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update({
        status: 'away',
        statusExpiresAt: null,
      });

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'statusText', 'statusEmoji', 'lastActive']
      });

      await Status.create({
        userId: req.user.id,
        status: 'away',
        statusText: 'Idle',
        idleTime: idleMinutes,
      });

      if (req.io) {
        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id']
          }]
        });

        if (currentUser.friends && currentUser.friends.length > 0) {
          const onlineFriends = await User.findAll({
            where: {
              id: currentUser.friends.map(f => f.id),
              online: true
            },
            attributes: ['id', 'socketIds']
          });

          onlineFriends.forEach(friend => {
            if (friend.socketIds && friend.socketIds.length > 0) {
              friend.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('status:updated', {
                  userId: updatedUser.id,
                  username: updatedUser.username,
                  avatar: updatedUser.avatar,
                  status: updatedUser.status,
                  statusText: updatedUser.statusText,
                  lastActive: updatedUser.lastActive,
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
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error setting user as idle:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to set user as idle'
      });
    }
  })
);

router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { period = '7d' } = req.query;

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

      const statusStats = await Status.findAll({
        where: {
          userId: req.user.id,
          createdAt: { [sequelize.Op.gte]: startDate }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('createdAt')), 'date'],
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [
            sequelize.fn('SUM',
              sequelize.literal("CASE WHEN expiresAt > createdAt THEN EXTRACT(EPOCH FROM (expiresAt - createdAt))/60 ELSE 0 END")
            ),
            'totalDuration'
          ]
        ],
        group: [sequelize.fn('DATE', sequelize.col('createdAt')), 'status'],
        order: [[sequelize.fn('DATE', sequelize.col('createdAt')), 'ASC'], ['status', 'ASC']],
        raw: true
      });

      const mostUsedStatuses = await Status.findAll({
        where: {
          userId: req.user.id,
          createdAt: { [sequelize.Op.gte]: startDate }
        },
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [
            sequelize.fn('AVG',
              sequelize.literal("CASE WHEN expiresAt > createdAt THEN EXTRACT(EPOCH FROM (expiresAt - createdAt))/60 ELSE 0 END")
            ),
            'avgDuration'
          ]
        ],
        group: ['status'],
        order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
        raw: true
      });

      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'status', 'online'],
          through: { attributes: [] }
        }]
      });

      const friendStatuses = {};
      user.friends.forEach(friend => {
        friendStatuses[friend.status] = (friendStatuses[friend.status] || 0) + 1;
      });

      res.status(200).json({
        status: 'success',
        data: {
          period,
          totalStatusChanges: statusStats.reduce((sum, stat) => sum + parseInt(stat.count), 0),
          dailyStats: statusStats.map(stat => ({
            _id: { status: stat.status, date: stat.date },
            count: parseInt(stat.count),
            totalDuration: parseFloat(stat.totalDuration) || 0
          })),
          mostUsedStatuses: mostUsedStatuses.map(stat => ({
            _id: stat.status,
            count: parseInt(stat.count),
            avgDuration: parseFloat(stat.avgDuration) || 0
          })),
          friendStatusDistribution: friendStatuses,
          onlineFriends: user.friends.filter(f => f.online).length,
          totalFriends: user.friends.length,
        },
      });
    } catch (error) {
      console.error('Error fetching status statistics:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch status statistics'
      });
    }
  })
);

router.post(
  '/schedule',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { status, statusText, statusEmoji, scheduleAt } = req.body;

      if (!scheduleAt) {
        throw new ValidationError('Schedule time is required');
      }

      const scheduleTime = new Date(scheduleAt);
      if (isNaN(scheduleTime.getTime()) || scheduleTime <= new Date()) {
        throw new ValidationError('Schedule time must be a future date');
      }

      const validStatuses = ['online', 'away', 'busy', 'offline', 'custom'];
      if (status && !validStatuses.includes(status)) {
        throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
      }

      if (status === 'custom' && (!statusText || statusText.trim().length === 0)) {
        throw new ValidationError('Status text is required for custom status');
      }

      const scheduledStatus = await Status.create({
        userId: req.user.id,
        status: status || 'custom',
        statusText: statusText?.trim(),
        statusEmoji: statusEmoji || '',
        isScheduled: true,
        scheduledAt: scheduleTime,
        expiresAt: null,
      });

      res.status(201).json({
        status: 'success',
        message: 'Status scheduled successfully',
        data: { scheduledStatus },
      });
    } catch (error) {
      console.error('Error scheduling status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to schedule status'
      });
    }
  })
);

router.get(
  '/scheduled',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { count, rows: scheduledStatuses } = await Status.findAndCountAll({
        where: {
          userId: req.user.id,
          isScheduled: true,
          scheduledAt: { [sequelize.Op.gt]: new Date() }
        },
        order: [['scheduledAt', 'ASC']],
        offset,
        limit: parseInt(limit)
      });

      res.status(200).json({
        status: 'success',
        data: {
          scheduledStatuses,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching scheduled statuses:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch scheduled statuses'
      });
    }
  })
);

router.delete(
  '/scheduled/:statusId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { statusId } = req.params;

      const scheduledStatus = await Status.findOne({
        where: {
          id: statusId,
          userId: req.user.id,
          isScheduled: true
        }
      });

      if (!scheduledStatus) {
        throw new NotFoundError('Scheduled status not found');
      }

      await scheduledStatus.destroy();

      res.status(200).json({
        status: 'success',
        message: 'Scheduled status cancelled',
      });
    } catch (error) {
      console.error('Error cancelling scheduled status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to cancel scheduled status'
      });
    }
  })
);

module.exports = router;