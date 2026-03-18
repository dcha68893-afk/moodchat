const express = require('express');
const router = express.Router();

// Import database models
const db = require('../models');
const User = db.User || db.Users;
const Chat = db.Chat;
const Message = db.Message;
const Friend = db.Friend;
const Call = db.Call;

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const asyncHandler = require('express-async-handler');
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Use the unified authentication middleware
router.use(authenticateToken);

console.log('✅ Friends routes initialized');

// Helper function to check authentication
const checkAuth = (req, res) => {
  if (!req.user || (!req.user.userId && !req.user.id)) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
  const userId = req.user.userId || req.user.id;
  return { userId };
};

// Helper function to check database models
const checkModels = (res) => {
  if (!db || !User || !Friend) {
    return res.status(503).json({
      status: 'error',
      message: 'Database service not available'
    });
  }
  return true;
};

// GET /friends/list - safe response
router.get(
  '/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        friends: []
      });
    } catch (error) {
      console.error('Error in friends list endpoint:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friends list'
      });
    }
  })
);

// GET /friends/ping - debug endpoint
router.get(
  '/ping',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({ ok: true, route: "friends" });
    } catch (error) {
      console.error('Ping error:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  })
);

// GET /friends - get all friends
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const {
        page = 1,
        limit = 50,
        status,
        sort = 'recent',
        search,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id']
        }]
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const friendIds = (user.friends || []).map(friend => friend.id);
      
      const where = { id: { [Op.in]: friendIds } };

      if (status && status !== 'all') {
        where.online = status === 'online';
      }

      if (search && search.trim()) {
        const searchRegex = `%${search}%`;
        where[Op.or] = [
          { username: { [Op.iLike]: searchRegex } },
          { displayName: { [Op.iLike]: searchRegex } }
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
        (friends || []).map(async friend => {
          const friendObj = friend.toJSON ? friend.toJSON() : friend;
          const friendship = await Friend.findOne({
            where: {
              [Op.or]: [
                { userId: userId, friendId: friend.id },
                { userId: friend.id, friendId: userId }
              ]
            }
          });
          
          friendObj.friendshipSince = friendship ? friendship.createdAt : new Date();
          
          const currentUser = await User.findByPk(userId, {
            include: [{
              model: User,
              as: 'blockedUsers',
              attributes: ['id']
            }]
          });
          
          friendObj.isBlocked = currentUser && currentUser.blockedUsers ? 
            currentUser.blockedUsers.some(bu => bu.id === friend.id) : false;
          
          return friendObj;
        })
      );

      res.status(200).json({
        status: 'success',
        data: {
          friends: friendsWithMetadata,
          pagination: {
            total: count || 0,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: count ? Math.ceil(count / parseInt(limit)) : 0,
          },
        },
      });
    } catch (error) {
      console.error('Error fetching friends:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friends'
      });
    }
  })
);

// GET /friends/:friendId - get friend details
router.get(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { friendId } = req.params;

      if (!friendId) {
        return res.status(400).json({
          status: 'error',
          message: 'Friend ID is required'
        });
      }

      const [user, friend] = await Promise.all([
        User.findByPk(userId),
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
        return res.status(404).json({
          status: 'error',
          message: 'User or friend not found'
        });
      }

      const isFriend = await Friend.findOne({
        where: {
          [Op.or]: [
            { userId: userId, friendId: friend.id },
            { userId: friend.id, friendId: userId }
          ]
        }
      });

      if (!isFriend) {
        return res.status(400).json({
          status: 'error',
          message: 'This user is not in your friends list'
        });
      }

      const mutualFriends = await User.findAll({
        where: {
          id: {
            [Op.in]: (friend.friends || [])
              .filter(friendUser => 
                (user.friends || []).some(userFriend => userFriend.id === friendUser.id)
              )
              .map(f => f.id)
          }
        },
        attributes: ['id', 'username', 'avatar', 'online', 'status']
      });

      const recentInteractions = await getRecentInteractions(userId, friendId);
      const sharedGroups = await getSharedGroups(userId, friendId);

      const friendship = await Friend.findOne({
        where: {
          [Op.or]: [
            { userId: userId, friendId: friend.id },
            { userId: friend.id, friendId: userId }
          ]
        }
      });

      const currentUser = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      const friendData = {
        ...(friend.toJSON ? friend.toJSON() : friend),
        isBlocked: currentUser && currentUser.blockedUsers ? 
          currentUser.blockedUsers.some(bu => bu.id === friend.id) : false,
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
      console.error('Error fetching friend details:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend details'
      });
    }
  })
);

// DELETE /friends/:friendId - remove friend
router.delete(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { friendId } = req.params;

      if (!friendId) {
        return res.status(400).json({
          status: 'error',
          message: 'Friend ID is required'
        });
      }

      const [user, friend] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(friendId)
      ]);

      if (!user || !friend) {
        return res.status(404).json({
          status: 'error',
          message: 'User or friend not found'
        });
      }

      const friendship = await Friend.findOne({
        where: {
          [Op.or]: [
            { userId: userId, friendId: friend.id },
            { userId: friend.id, friendId: userId }
          ]
        }
      });

      if (!friendship) {
        return res.status(400).json({
          status: 'error',
          message: 'This user is not in your friends list'
        });
      }

      await friendship.destroy();

      if (user.removeFriend) await user.removeFriend(friend.id);
      if (friend.removeFriend) await friend.removeFriend(user.id);

      if (user.removeFriendRequest) await user.removeFriendRequest(friend.id);
      if (friend.removeFriendRequest) await friend.removeFriendRequest(user.id);

      if (req.io && friend.socketIds && Array.isArray(friend.socketIds) && friend.socketIds.length > 0) {
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
      console.error('Error removing friend:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove friend'
      });
    }
  })
);

// POST /friends/:userId/block - block user
router.post(
  '/:userId/block',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { userId: targetUserId } = req.params;

      if (!targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'User ID is required'
        });
      }

      if (targetUserId === userId) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot block yourself'
        });
      }

      const [user, userToBlock] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(targetUserId)
      ]);

      if (!user || !userToBlock) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      if (user.hasBlockedUser) {
        const alreadyBlocked = await user.hasBlockedUser(userToBlock.id);
        if (alreadyBlocked) {
          return res.status(409).json({
            status: 'error',
            message: 'User is already blocked'
          });
        }

        await user.addBlockedUser(userToBlock.id);
      } else {
        // Fallback if association methods not available
        return res.status(500).json({
          status: 'error',
          message: 'Block functionality not available'
        });
      }

      const friendship = await Friend.findOne({
        where: {
          [Op.or]: [
            { userId: userId, friendId: userToBlock.id },
            { userId: userToBlock.id, friendId: userId }
          ]
        }
      });

      if (friendship) {
        await friendship.destroy();
        if (user.removeFriend) await user.removeFriend(userToBlock.id);
        if (userToBlock.removeFriend) await userToBlock.removeFriend(user.id);

        if (req.io && userToBlock.socketIds && Array.isArray(userToBlock.socketIds) && userToBlock.socketIds.length > 0) {
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

      if (user.removeFriendRequest) await user.removeFriendRequest(userToBlock.id);
      if (userToBlock.removeFriendRequest) await userToBlock.removeFriendRequest(user.id);

      if (req.io && userToBlock.socketIds && Array.isArray(userToBlock.socketIds) && userToBlock.socketIds.length > 0) {
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
      console.error('Error blocking user:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to block user'
      });
    }
  })
);

// POST /friends/:userId/unblock - unblock user
router.post(
  '/:userId/unblock',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { userId: targetUserId } = req.params;

      if (!targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'User ID is required'
        });
      }

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      if (user.hasBlockedUser) {
        const isBlocked = await user.hasBlockedUser(targetUserId);
        if (!isBlocked) {
          return res.status(400).json({
            status: 'error',
            message: 'User is not blocked'
          });
        }

        await user.removeBlockedUser(targetUserId);
      } else {
        return res.status(500).json({
          status: 'error',
          message: 'Unblock functionality not available'
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'User unblocked successfully',
      });
    } catch (error) {
      console.error('Error unblocking user:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to unblock user'
      });
    }
  })
);

// GET /friends/blocked/list - get blocked users
router.get(
  '/blocked/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
          through: { attributes: [] }
        }]
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      res.status(200).json({
        status: 'success',
        data: { blockedUsers: user.blockedUsers || [] },
      });
    } catch (error) {
      console.error('Error fetching blocked users:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch blocked users'
      });
    }
  })
);

// GET /friends/search/new - search for new users
router.get(
  '/search/new',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { query, page = 1, limit = 20, excludeFriends = true } = req.query;

      if (!query || query.trim().length < 2) {
        return res.status(400).json({
          status: 'error',
          message: 'Search query must be at least 2 characters'
        });
      }

      const offset = (parseInt(page) - 1) * parseInt(limit);
      const user = await User.findByPk(userId, {
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

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const searchRegex = `%${query}%`;

      const where = {
        [Op.and]: [
          { id: { [Op.ne]: user.id } },
          {
            [Op.or]: [
              { username: { [Op.iLike]: searchRegex } },
              { displayName: { [Op.iLike]: searchRegex } }
            ]
          }
        ]
      };

      const friendIds = (user.friends || []).map(f => f.id);
      const blockedIds = (user.blockedUsers || []).map(bu => bu.id);

      let excludedIds = [];
      if (excludeFriends === 'true' && friendIds.length > 0) {
        excludedIds = [...excludedIds, ...friendIds];
      }

      if (blockedIds.length > 0) {
        excludedIds = [...excludedIds, ...blockedIds];
      }

      if (excludedIds.length > 0) {
        where.id = {
          ...where.id,
          [Op.notIn]: excludedIds
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
        const currentExcluded = where.id && where.id[Op.notIn] ? where.id[Op.notIn] : [];
        where.id = {
          ...where.id,
          [Op.notIn]: [...currentExcluded, ...usersWhoBlockedMe.map(u => u.id)]
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
        (users || []).map(async otherUser => {
          const isFriend = (user.friends || []).some(friend => friend.id === otherUser.id);
          const hasSentRequest = await Friend.findOne({
            where: { userId: user.id, friendId: otherUser.id, status: 'pending' }
          });
          const hasReceivedRequest = await Friend.findOne({
            where: { userId: otherUser.id, friendId: user.id, status: 'pending' }
          });
          const isBlocked = (user.blockedUsers || []).some(blocked => blocked.id === otherUser.id);

          return {
            ...(otherUser.toJSON ? otherUser.toJSON() : otherUser),
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
            total: count || 0,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: count ? Math.ceil(count / parseInt(limit)) : 0,
          },
        },
      });
    } catch (error) {
      console.error('Error searching users:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to search users'
      });
    }
  })
);

// GET /friends/suggestions - get friend suggestions
router.get(
  '/suggestions',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { limit = 10 } = req.query;

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id']
        }]
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const friendIds = (user.friends || []).map(friend => friend.id);
      const blockedIds = (user.blockedUsers || []).map(bu => bu.id);

      if (friendIds.length === 0) {
        const suggestions = await User.findAll({
          where: {
            id: {
              [Op.ne]: user.id,
              [Op.notIn]: blockedIds
            }
          },
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'bio'],
          limit: parseInt(limit),
          order: [['createdAt', 'DESC']]
        });

        return res.status(200).json({
          status: 'success',
          data: { suggestions: suggestions || [] },
        });
      }

      const suggestions = await User.findAll({
        where: {
          id: {
            [Op.ne]: user.id,
            [Op.notIn]: [...friendIds, ...blockedIds]
          },
          '$friends.id$': { [Op.in]: friendIds }
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
            Sequelize.literal(`(
              SELECT COUNT(*)
              FROM "Friends" f1
              WHERE f1."userId" = "User".id
              AND f1."friendId" IN (${friendIds.map(id => `'${id}'`).join(',')})
            )`),
            'mutualCount'
          ]
        ],
        order: [
          [Sequelize.literal('"mutualCount"'), 'DESC'],
          ['online', 'DESC'],
          ['createdAt', 'DESC']
        ],
        limit: parseInt(limit)
      });

      res.status(200).json({
        status: 'success',
        data: { suggestions: suggestions || [] },
      });
    } catch (error) {
      console.error('Error fetching friend suggestions:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend suggestions'
      });
    }
  })
);

// GET /friends/export - export friends
router.get(
  '/export',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { format = 'json' } = req.query;

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'username', 'displayName', 'email', 'avatar', 'online', 'status', 'lastActive', 'bio'],
          through: { attributes: [] }
        }]
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const friendsData = (user.friends || []).map(friend => ({
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
      console.error('Error exporting friends:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to export friends'
      });
    }
  })
);

// POST /friends/bulk/categories - bulk update categories
router.post(
  '/bulk/categories',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { updates } = req.body;

      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'Updates array is required'
        });
      }

      if (updates.length > 50) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot update more than 50 friends at once'
        });
      }

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const results = {
        success: [],
        failed: [],
      };

      for (const update of updates) {
        const { friendId, category } = update;

        const friendship = await Friend.findOne({
          where: {
            [Op.or]: [
              { userId: userId, friendId },
              { userId: friendId, friendId: userId }
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
      console.error('Error updating friend categories:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update friend categories'
      });
    }
  })
);

// GET /friends/stats - get friend statistics
router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'online', 'lastActive']
        }]
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const onlineCount = (user.friends || []).filter(friend => friend.online).length;
      
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const recentActiveCount = (user.friends || []).filter(friend => 
        friend.lastActive && new Date(friend.lastActive) > sevenDaysAgo
      ).length;

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentFriends = await Friend.findAll({
        where: {
          [Op.or]: [
            { userId: userId },
            { friendId: userId }
          ],
          createdAt: { [Op.gte]: thirtyDaysAgo }
        },
        include: [{
          model: User,
          as: 'friend',
          attributes: ['id', 'createdAt']
        }],
        attributes: [
          [Sequelize.fn('DATE', Sequelize.col('Friend.createdAt')), 'date'],
          [Sequelize.fn('COUNT', Sequelize.col('Friend.id')), 'count']
        ],
        group: [Sequelize.fn('DATE', Sequelize.col('Friend.createdAt'))],
        order: [[Sequelize.fn('DATE', Sequelize.col('Friend.createdAt')), 'ASC']],
        raw: true
      });

      res.status(200).json({
        status: 'success',
        data: {
          total: (user.friends || []).length,
          online: onlineCount,
          offline: (user.friends || []).length - onlineCount,
          recentlyActive: recentActiveCount,
          newLast30Days: (recentFriends || []).reduce((sum, day) => sum + parseInt(day.count || 0), 0),
          additionTrend: (recentFriends || []).map(r => ({
            _id: r.date,
            count: parseInt(r.count || 0)
          })),
        },
      });
    } catch (error) {
      console.error('Error fetching friend statistics:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend statistics'
      });
    }
  })
);

// Helper function for recent interactions
const getRecentInteractions = async (userId, friendId) => {
  try {
    if (!db || !Message || !Call) {
      return {
        messageCount: 0,
        lastMessage: null,
        calls: [],
      };
    }

    const messages = await Message.findAll({
      where: {
        [Op.or]: [
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
        [Op.or]: [
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
      messageCount: (messages || []).length,
      lastMessage: messages && messages[0] ? messages[0] : null,
      calls: (calls || []).map(call => call.toJSON ? call.toJSON() : call),
    };
  } catch (error) {
    console.error('Error getting recent interactions:', error.message);
    return {
      messageCount: 0,
      lastMessage: null,
      calls: [],
    };
  }
};

// Helper function for shared groups
const getSharedGroups = async (userId, friendId) => {
  try {
    if (!db || !Chat) {
      return [];
    }

    const sharedGroups = await Chat.findAll({
      where: {
        chatType: 'group',
        '$participants.id$': { [Op.contains]: [userId, friendId] }
      },
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id'],
        through: { attributes: [] }
      }],
      attributes: ['id', 'chatName', 'avatar']
    });

    return sharedGroups || [];
  } catch (error) {
    console.error('Error getting shared groups:', error.message);
    return [];
  }
};

module.exports = router;