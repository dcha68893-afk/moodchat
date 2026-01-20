const express = require('express');
const router = express.Router();
const sequelize = require('sequelize');
const asyncHandler = require('express-async-handler');
const {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, Chat, Message, Friend } = require('../models');

router.use(authenticate);

console.log('✅ Friends routes initialized');

router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        status,
        sort = 'recent',
        search,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id']
        }]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      const friendIds = user.friends.map(friend => friend.id);
      
      const where = { id: { [sequelize.Op.in]: friendIds } };

      if (status && status !== 'all') {
        where.online = status === 'online';
      }

      if (search && search.trim()) {
        const searchRegex = `%${search}%`;
        where[sequelize.Op.or] = [
          { username: { [sequelize.Op.iLike]: searchRegex } },
          { displayName: { [sequelize.Op.iLike]: searchRegex } }
        ];
      }

      let order = [];
      switch (sort) {
        case 'name':
          order = [['username', 'ASC']];
          break;
        case 'online':
          order = [['online', 'DESC'], ['username', 'ASC']];
          break;
        case 'recent':
        default:
          order = [['lastActive', 'DESC'], ['username', 'ASC']];
          break;
      }

      const { count, rows: friends } = await User.findAndCountAll({
        where,
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'lastActive', 'bio'],
        order,
        offset,
        limit: parseInt(limit)
      });

      const friendsWithMetadata = await Promise.all(
        friends.map(async friend => {
          const friendObj = friend.toJSON();
          const friendship = await Friend.findOne({
            where: {
              [sequelize.Op.or]: [
                { userId: req.user.id, friendId: friend.id },
                { userId: friend.id, friendId: req.user.id }
              ]
            }
          });
          
          friendObj.friendshipSince = friendship ? friendship.createdAt : new Date();
          
          const currentUser = await User.findByPk(req.user.id, {
            include: [{
              model: User,
              as: 'blockedUsers',
              attributes: ['id']
            }]
          });
          
          friendObj.isBlocked = currentUser.blockedUsers.some(bu => bu.id === friend.id);
          
          return friendObj;
        })
      );

      res.status(200).json({
        status: 'success',
        data: {
          friends: friendsWithMetadata,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching friends:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friends'
      });
    }
  })
);

router.get(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { friendId } = req.params;

      const [user, friend] = await Promise.all([
        User.findByPk(req.user.id),
        User.findByPk(friendId, {
          attributes: { exclude: ['password', 'email', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil', 'socketIds'] },
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id', 'username', 'avatar', 'online', 'status']
          }]
        })
      ]);

      if (!user || !friend) {
        throw new NotFoundError('User or friend not found');
      }

      const isFriend = await Friend.findOne({
        where: {
          [sequelize.Op.or]: [
            { userId: req.user.id, friendId: friend.id },
            { userId: friend.id, friendId: req.user.id }
          ]
        }
      });

      if (!isFriend) {
        throw new ValidationError('This user is not in your friends list');
      }

      const mutualFriends = await User.findAll({
        where: {
          id: {
            [sequelize.Op.in]: friend.friends
              .filter(friendUser => 
                user.friends.some(userFriend => userFriend.id === friendUser.id)
              )
              .map(f => f.id)
          }
        },
        attributes: ['id', 'username', 'avatar', 'online', 'status']
      });

      const recentInteractions = await getRecentInteractions(req.user.id, friendId);
      const sharedGroups = await getSharedGroups(req.user.id, friendId);

      const friendship = await Friend.findOne({
        where: {
          [sequelize.Op.or]: [
            { userId: req.user.id, friendId: friend.id },
            { userId: friend.id, friendId: req.user.id }
          ]
        }
      });

      const currentUser = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      const friendData = {
        ...friend.toJSON(),
        isBlocked: currentUser.blockedUsers.some(bu => bu.id === friend.id),
        friendshipSince: friendship ? friendship.createdAt : null,
        mutualFriends,
        recentInteractions,
        sharedGroups,
      };

      res.status(200).json({
        status: 'success',
        data: { friend: friendData },
      });
    } catch (error) {
      console.error('Error fetching friend details:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend details'
      });
    }
  })
);

router.delete(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { friendId } = req.params;

      const [user, friend] = await Promise.all([
        User.findByPk(req.user.id),
        User.findByPk(friendId)
      ]);

      if (!user || !friend) {
        throw new NotFoundError('User or friend not found');
      }

      const friendship = await Friend.findOne({
        where: {
          [sequelize.Op.or]: [
            { userId: req.user.id, friendId: friend.id },
            { userId: friend.id, friendId: req.user.id }
          ]
        }
      });

      if (!friendship) {
        throw new ValidationError('This user is not in your friends list');
      }

      await friendship.destroy();

      await user.removeFriend(friend.id);
      await friend.removeFriend(user.id);

      await user.removeFriendRequest(friend.id);
      await friend.removeFriendRequest(user.id);

      if (req.io && friend.socketIds && friend.socketIds.length > 0) {
        friend.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('friend:removed', {
            byUserId: user.id,
            byUsername: user.username,
            timestamp: new Date(),
          });
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Friend removed successfully',
      });
    } catch (error) {
      console.error('Error removing friend:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove friend'
      });
    }
  })
);

router.post(
  '/:userId/block',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      if (userId === req.user.id) {
        throw new ValidationError('Cannot block yourself');
      }

      const [user, userToBlock] = await Promise.all([
        User.findByPk(req.user.id),
        User.findByPk(userId)
      ]);

      if (!user || !userToBlock) {
        throw new NotFoundError('User not found');
      }

      const alreadyBlocked = await user.hasBlockedUser(userToBlock.id);
      if (alreadyBlocked) {
        throw new ConflictError('User is already blocked');
      }

      await user.addBlockedUser(userToBlock.id);

      const friendship = await Friend.findOne({
        where: {
          [sequelize.Op.or]: [
            { userId: req.user.id, friendId: userToBlock.id },
            { userId: userToBlock.id, friendId: req.user.id }
          ]
        }
      });

      if (friendship) {
        await friendship.destroy();
        await user.removeFriend(userToBlock.id);
        await userToBlock.removeFriend(user.id);

        if (req.io && userToBlock.socketIds && userToBlock.socketIds.length > 0) {
          userToBlock.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('friend:removed', {
              byUserId: user.id,
              byUsername: user.username,
              timestamp: new Date(),
              reason: 'blocked',
            });
          });
        }
      }

      await user.removeFriendRequest(userToBlock.id);
      await userToBlock.removeFriendRequest(user.id);

      if (req.io && userToBlock.socketIds && userToBlock.socketIds.length > 0) {
        userToBlock.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('user:blocked', {
            blockedByUserId: user.id,
            blockedByUsername: user.username,
            timestamp: new Date(),
          });
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'User blocked successfully',
      });
    } catch (error) {
      console.error('Error blocking user:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to block user'
      });
    }
  })
);

router.post(
  '/:userId/unblock',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      const user = await User.findByPk(req.user.id);
      const isBlocked = await user.hasBlockedUser(userId);

      if (!isBlocked) {
        throw new ValidationError('User is not blocked');
      }

      await user.removeBlockedUser(userId);

      res.status(200).json({
        status: 'success',
        message: 'User unblocked successfully',
      });
    } catch (error) {
      console.error('Error unblocking user:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to unblock user'
      });
    }
  })
);

router.get(
  '/blocked/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
          through: { attributes: [] }
        }]
      });

      res.status(200).json({
        status: 'success',
        data: { blockedUsers: user.blockedUsers || [] },
      });
    } catch (error) {
      console.error('Error fetching blocked users:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch blocked users'
      });
    }
  })
);

router.get(
  '/search/new',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { query, page = 1, limit = 20, excludeFriends = true } = req.query;

      if (!query || query.trim().length < 2) {
        throw new ValidationError('Search query must be at least 2 characters');
      }

      const offset = (parseInt(page) - 1) * parseInt(limit);
      const user = await User.findByPk(req.user.id, {
        include: [
          {
            model: User,
            as: 'friends',
            attributes: ['id']
          },
          {
            model: User,
            as: 'blockedUsers',
            attributes: ['id']
          }
        ]
      });

      const searchRegex = `%${query}%`;

      const where = {
        [sequelize.Op.and]: [
          { id: { [sequelize.Op.ne]: user.id } },
          {
            [sequelize.Op.or]: [
              { username: { [sequelize.Op.iLike]: searchRegex } },
              { displayName: { [sequelize.Op.iLike]: searchRegex } }
            ]
          }
        ]
      };

      if (excludeFriends === 'true' && user.friends.length > 0) {
        where.id = {
          ...where.id,
          [sequelize.Op.notIn]: user.friends.map(f => f.id)
        };
      }

      if (user.blockedUsers && user.blockedUsers.length > 0) {
        where.id = {
          ...where.id,
          [sequelize.Op.notIn]: [...(where.id[sequelize.Op.notIn] || []), ...user.blockedUsers.map(bu => bu.id)]
        };
      }

      const usersWhoBlockedMe = await User.findAll({
        where: {
          '$blockedUsers.id$': user.id
        },
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: [],
          through: { attributes: [] },
          required: true
        }],
        attributes: ['id']
      });

      if (usersWhoBlockedMe.length > 0) {
        where.id = {
          ...where.id,
          [sequelize.Op.notIn]: [...(where.id[sequelize.Op.notIn] || []), ...usersWhoBlockedMe.map(u => u.id)]
        };
      }

      const { count, rows: users } = await User.findAndCountAll({
        where,
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'lastActive', 'bio'],
        order: [['online', 'DESC'], ['username', 'ASC']],
        offset,
        limit: parseInt(limit)
      });

      const usersWithStatus = await Promise.all(
        users.map(async otherUser => {
          const isFriend = user.friends.some(friend => friend.id === otherUser.id);
          const hasSentRequest = await Friend.findOne({
            where: { userId: user.id, friendId: otherUser.id, status: 'pending' }
          });
          const hasReceivedRequest = await Friend.findOne({
            where: { userId: otherUser.id, friendId: user.id, status: 'pending' }
          });
          const isBlocked = user.blockedUsers.some(blocked => blocked.id === otherUser.id);

          return {
            ...otherUser.toJSON(),
            relationship: {
              isFriend,
              hasSentRequest: !!hasSentRequest,
              hasReceivedRequest: !!hasReceivedRequest,
              isBlocked,
            },
          };
        })
      );

      res.status(200).json({
        status: 'success',
        data: {
          users: usersWithStatus,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error searching users:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to search users'
      });
    }
  })
);

router.get(
  '/suggestions',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { limit = 10 } = req.query;

      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id']
        }]
      });

      const friendIds = user.friends.map(friend => friend.id);

      if (friendIds.length === 0) {
        const suggestions = await User.findAll({
          where: {
            id: {
              [sequelize.Op.ne]: user.id,
              [sequelize.Op.notIn]: user.blockedUsers || []
            }
          },
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'bio'],
          limit: parseInt(limit),
          order: [['createdAt', 'DESC']]
        });

        return res.status(200).json({
          status: 'success',
          data: { suggestions },
        });
      }

      const suggestions = await User.findAll({
        where: {
          id: {
            [sequelize.Op.ne]: user.id,
            [sequelize.Op.notIn]: [...friendIds, ...(user.blockedUsers || [])]
          },
          '$friends.id$': { [sequelize.Op.in]: friendIds }
        },
        include: [{
          model: User,
          as: 'friends',
          attributes: [],
          through: { attributes: [] },
          required: true
        }],
        attributes: [
          'id',
          'username',
          'avatar',
          'displayName',
          'online',
          'status',
          'bio',
          [
            sequelize.literal(`(
              SELECT COUNT(*)
              FROM "Friends" f1
              WHERE f1."userId" = "User".id
              AND f1."friendId" IN (${friendIds.map(id => `'${id}'`).join(',')})
            )`),
            'mutualCount'
          ]
        ],
        order: [
          [sequelize.literal('"mutualCount"'), 'DESC'],
          ['online', 'DESC'],
          ['createdAt', 'DESC']
        ],
        limit: parseInt(limit)
      });

      res.status(200).json({
        status: 'success',
        data: { suggestions },
      });
    } catch (error) {
      console.error('Error fetching friend suggestions:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend suggestions'
      });
    }
  })
);

router.get(
  '/export',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { format = 'json' } = req.query;

      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'username', 'displayName', 'email', 'avatar', 'online', 'status', 'lastActive', 'bio'],
          through: { attributes: [] }
        }]
      });

      const friendsData = user.friends.map(friend => ({
        username: friend.username,
        displayName: friend.displayName,
        email: friend.email,
        online: friend.online,
        status: friend.status,
        lastActive: friend.lastActive,
        bio: friend.bio,
      }));

      if (format === 'csv') {
        const fields = ['username', 'displayName', 'email', 'online', 'status', 'lastActive', 'bio'];
        const csv = [
          fields.join(','),
          ...friendsData.map(friend =>
            fields.map(field => `"${(friend[field] || '').toString().replace(/"/g, '""')}"`).join(',')
          ),
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=friends.csv');
        return res.send(csv);
      }

      res.status(200).json({
        status: 'success',
        data: {
          exportedAt: new Date(),
          count: friendsData.length,
          friends: friendsData,
        },
      });
    } catch (error) {
      console.error('Error exporting friends:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to export friends'
      });
    }
  })
);

router.post(
  '/bulk/categories',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { updates } = req.body;

      if (!Array.isArray(updates) || updates.length === 0) {
        throw new ValidationError('Updates array is required');
      }

      if (updates.length > 50) {
        throw new ValidationError('Cannot update more than 50 friends at once');
      }

      const user = await User.findByPk(req.user.id);
      const results = {
        success: [],
        failed: [],
      };

      for (const update of updates) {
        const { friendId, category } = update;

        const friendship = await Friend.findOne({
          where: {
            [sequelize.Op.or]: [
              { userId: req.user.id, friendId },
              { userId: friendId, friendId: req.user.id }
            ]
          }
        });

        if (!friendship) {
          results.failed.push({ friendId, error: 'Not a friend' });
          continue;
        }

        friendship.category = category;
        await friendship.save();
        results.success.push(friendId);
      }

      res.status(200).json({
        status: 'success',
        data: results,
      });
    } catch (error) {
      console.error('Error updating friend categories:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update friend categories'
      });
    }
  })
);

router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'online', 'lastActive']
        }]
      });

      const onlineCount = user.friends.filter(friend => friend.online).length;
      
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const recentActiveCount = user.friends.filter(friend => 
        friend.lastActive > sevenDaysAgo
      ).length;

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentFriends = await Friend.findAll({
        where: {
          [sequelize.Op.or]: [
            { userId: req.user.id },
            { friendId: req.user.id }
          ],
          createdAt: { [sequelize.Op.gte]: thirtyDaysAgo }
        },
        include: [{
          model: User,
          as: 'friend',
          attributes: ['id', 'createdAt']
        }],
        attributes: [
          [sequelize.fn('DATE', sequelize.col('Friend.createdAt')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('Friend.id')), 'count']
        ],
        group: [sequelize.fn('DATE', sequelize.col('Friend.createdAt'))],
        order: [[sequelize.fn('DATE', sequelize.col('Friend.createdAt')), 'ASC']]
      });

      res.status(200).json({
        status: 'success',
        data: {
          total: user.friends.length,
          online: onlineCount,
          offline: user.friends.length - onlineCount,
          recentlyActive: recentActiveCount,
          newLast30Days: recentFriends.reduce((sum, day) => sum + parseInt(day.dataValues.count), 0),
          additionTrend: recentFriends.map(r => ({
            _id: r.dataValues.date,
            count: parseInt(r.dataValues.count)
          })),
        },
      });
    } catch (error) {
      console.error('Error fetching friend statistics:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend statistics'
      });
    }
  })
);

const getRecentInteractions = async (userId, friendId) => {
  try {
    const messages = await Message.findAll({
      where: {
        [sequelize.Op.or]: [
          { senderId: userId, '$chat.participants.id$': friendId },
          { senderId: friendId, '$chat.participants.id$': userId }
        ]
      },
      include: [{
        model: Chat,
        as: 'chat',
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      }],
      order: [['createdAt', 'DESC']],
      limit: 10
    });

    const calls = await Call.findAll({
      where: {
        [sequelize.Op.or]: [
          { callerId: userId, '$participants.id$': friendId },
          { callerId: friendId, '$participants.id$': userId }
        ]
      },
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id'],
        through: { attributes: [] }
      }],
      order: [['startedAt', 'DESC']],
      limit: 10
    });

    return {
      messageCount: messages.length,
      lastMessage: messages[0] || null,
      calls: calls.map(call => call.toJSON()),
    };
  } catch (error) {
    console.error('Error getting recent interactions:', error);
    return {
      messageCount: 0,
      lastMessage: null,
      calls: [],
    };
  }
};

const getSharedGroups = async (userId, friendId) => {
  try {
    const sharedGroups = await Chat.findAll({
      where: {
        chatType: 'group',
        '$participants.id$': { [sequelize.Op.contains]: [userId, friendId] }
      },
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id'],
        through: { attributes: [] }
      }],
      attributes: ['id', 'chatName', 'avatar']
    });

    return sharedGroups;
  } catch (error) {
    console.error('Error getting shared groups:', error);
    return [];
  }
};

module.exports = router;