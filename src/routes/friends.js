const express = require('express');
const router = express.Router();

// ===== SAFE MODEL IMPORT =====
let db, User, Friend, Chat, Message, Call;
try {
  db = require('../models');
  User = db.User || db.Users;
  Friend = db.Friend || db.Friends;
  Chat = db.Chat || db.Chats;
  Message = db.Message || db.Messages;
  Call = db.Call || db.Calls;
  console.log('[Friends Route] Models loaded - User:', !!User, 'Friend:', !!Friend);
} catch (error) {
  console.error('[Friends Route] Error loading models:', error.message);
  db = null;
}

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const asyncHandler = require('express-async-handler');
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Use the unified authentication middleware
router.use(authenticateToken);

// ===== SAFE MODEL CHECK MIDDLEWARE =====
const ensureModels = (req, res, next) => {
  if (!User) {
    console.error('[Friends Route] User model not available');
    return res.status(503).json({
      status: 'error',
      message: 'Service temporarily unavailable',
      code: 'MODEL_UNAVAILABLE'
    });
  }
  next();
};

router.use(ensureModels);

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

// ===== GET FRIENDS LIST (SAFE) =====
router.get(
  '/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      
      if (!Friend) {
        return res.status(200).json({
          success: true,
          friends: []
        });
      }
      
      const userId = auth.userId;
      
      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: userId, status: 'accepted' },
              { friendId: userId, status: 'accepted' }
            ]
          },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive']
            },
            {
              model: User,
              as: 'friend',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive']
            }
          ]
        });
        
        const friends = (friendships || []).map(f => {
          if (f.userId === userId) {
            return f.friend;
          }
          return f.user;
        }).filter(f => f);
        
        return res.json({
          success: true,
          friends: friends || []
        });
      } catch (dbError) {
        console.log('[Friends Route] Friend table may not exist:', dbError.message);
        return res.json({
          success: true,
          friends: []
        });
      }
    } catch (error) {
      console.error('Error in friends list endpoint:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friends list'
      });
    }
  })
);

// ===== PING ENDPOINT =====
router.get(
  '/ping',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      return res.json({ ok: true, route: "friends", timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Ping error:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }
  })
);

// ===== GET ALL FRIENDS =====
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { friends: [], pagination: { total: 0, page: 1, limit: 50, pages: 0 } }
        });
      }

      const {
        page = 1,
        limit = 50,
        status,
        sort = 'recent',
        search,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: userId, status: 'accepted' },
              { friendId: userId, status: 'accepted' }
            ]
          }
        });
        
        const friendIds = friendships.map(f => f.userId === userId ? f.friendId : f.userId);
        
        if (friendIds.length === 0) {
          return res.status(200).json({
            status: 'success',
            data: { friends: [], pagination: { total: 0, page: parseInt(page), limit: parseInt(limit), pages: 0 } }
          });
        }
        
        const where = { id: { [Op.in]: friendIds } };

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
            order = [['username', 'ASC']];
            break;
          case 'recent':
          default:
            order = [['username', 'ASC']];
            break;
        }

        const { count, rows: friends } = await User.findAndCountAll({
          where,
          attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio'],
          order,
          offset,
          limit: parseInt(limit)
        });

        return res.status(200).json({
          status: 'success',
          data: {
            friends: friends || [],
            pagination: {
              total: count || 0,
              page: parseInt(page),
              limit: parseInt(limit),
              pages: count ? Math.ceil(count / parseInt(limit)) : 0,
            },
          },
        });
      } catch (dbError) {
        console.log('[Friends Route] Friend table may not exist:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { friends: [], pagination: { total: 0, page: 1, limit: 50, pages: 0 } }
        });
      }
    } catch (error) {
      console.error('Error fetching friends:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friends'
      });
    }
  })
);

// ===== GET INCOMING FRIEND REQUESTS =====
router.get(
  '/incoming',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      
      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { requests: [] }
        });
      }

      try {
        const requests = await Friend.findAll({
          where: {
            friendId: auth.userId,
            status: 'pending'
          },
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'avatar', 'displayName']
          }]
        });

        const formattedRequests = requests.map(req => ({
          id: req.id,
          user: req.user,
          status: req.status,
          createdAt: req.createdAt
        }));

        return res.status(200).json({
          status: 'success',
          data: { requests: formattedRequests || [] }
        });
      } catch (dbError) {
        console.log('[Friends Route] Friend table may not exist:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { requests: [] }
        });
      }
    } catch (error) {
      console.error('Error fetching incoming friend requests:', error.message);
      return res.status(200).json({
        status: 'success',
        data: { requests: [] }
      });
    }
  })
);

// ===== GET SENT FRIEND REQUESTS =====
router.get(
  '/sent',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      
      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { requests: [] }
        });
      }

      try {
        const requests = await Friend.findAll({
          where: {
            userId: auth.userId,
            status: 'pending'
          },
          include: [{
            model: User,
            as: 'friend',
            attributes: ['id', 'username', 'avatar', 'displayName']
          }]
        });

        const formattedRequests = requests.map(req => ({
          id: req.id,
          user: req.friend,
          status: req.status,
          createdAt: req.createdAt
        }));

        return res.status(200).json({
          status: 'success',
          data: { requests: formattedRequests || [] }
        });
      } catch (dbError) {
        console.log('[Friends Route] Friend table may not exist:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { requests: [] }
        });
      }
    } catch (error) {
      console.error('Error fetching sent friend requests:', error.message);
      return res.status(200).json({
        status: 'success',
        data: { requests: [] }
      });
    }
  })
);

// ===== GET PINNED FRIENDS =====
router.get(
  '/pinned',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      
      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { friends: [] }
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: auth.userId, status: 'accepted' },
              { friendId: auth.userId, status: 'accepted' }
            ],
            isPinned: true
          },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio']
            },
            {
              model: User,
              as: 'friend',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio']
            }
          ]
        });

        const friends = friendships.map(f => {
          if (f.userId === auth.userId) return f.friend;
          return f.user;
        }).filter(f => f);

        return res.status(200).json({
          status: 'success',
          data: { friends: friends || [] }
        });
      } catch (dbError) {
        console.log('[Friends Route] Pinned friends query error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { friends: [] }
        });
      }
    } catch (error) {
      console.error('Error fetching pinned friends:', error.message);
      return res.status(200).json({
        status: 'success',
        data: { friends: [] }
      });
    }
  })
);

// ===== GET MUTED FRIENDS =====
router.get(
  '/muted',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      
      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { friends: [] }
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: auth.userId, status: 'accepted' },
              { friendId: auth.userId, status: 'accepted' }
            ],
            isMuted: true
          },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio']
            },
            {
              model: User,
              as: 'friend',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio']
            }
          ]
        });

        const friends = friendships.map(f => {
          if (f.userId === auth.userId) return f.friend;
          return f.user;
        }).filter(f => f);

        return res.status(200).json({
          status: 'success',
          data: { friends: friends || [] }
        });
      } catch (dbError) {
        console.log('[Friends Route] Muted friends query error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { friends: [] }
        });
      }
    } catch (error) {
      console.error('Error fetching muted friends:', error.message);
      return res.status(200).json({
        status: 'success',
        data: { friends: [] }
      });
    }
  })
);

// ===== GET CONTACTS SYNCED =====
router.get(
  '/synced',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      
      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { synced: false, contacts: [] }
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: auth.userId, status: 'accepted' },
              { friendId: auth.userId, status: 'accepted' }
            ]
          },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio']
            },
            {
              model: User,
              as: 'friend',
              attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio']
            }
          ]
        });

        const contacts = friendships.map(f => {
          if (f.userId === auth.userId) return f.friend;
          return f.user;
        }).filter(f => f);

        return res.status(200).json({
          status: 'success',
          data: { synced: true, contacts: contacts || [] }
        });
      } catch (dbError) {
        console.log('[Friends Route] Synced contacts query error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { synced: false, contacts: [] }
        });
      }
    } catch (error) {
      console.error('Error syncing contacts:', error.message);
      return res.status(200).json({
        status: 'success',
        data: { synced: false, contacts: [] }
      });
    }
  })
);

// ===== GET FRIEND DETAILS =====
router.get(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      const { friendId } = req.params;
      
      const specialStrings = ['pinned', 'muted', 'list', 'ping', 'stats', 'suggestions', 'export', 'blocked', 'search', 'incoming', 'sent', 'synced'];
      if (specialStrings.includes(friendId)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid friend ID'
        });
      }

      if (!friendId) {
        return res.status(400).json({
          status: 'error',
          message: 'Friend ID is required'
        });
      }

      const [user, friend] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(friendId, {
          attributes: { exclude: ['password', 'email', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil', 'socketIds'] }
        })
      ]);

      if (!user || !friend) {
        return res.status(404).json({
          status: 'error',
          message: 'User or friend not found'
        });
      }

      let isFriend = false;
      if (Friend) {
        try {
          const friendship = await Friend.findOne({
            where: {
              [Op.or]: [
                { userId: userId, friendId: friend.id },
                { userId: friend.id, friendId: userId }
              ],
              status: 'accepted'
            }
          });
          isFriend = !!friendship;
        } catch (dbError) {
          console.log('[Friends Route] Friend check error:', dbError.message);
          isFriend = false;
        }
      }

      if (!isFriend) {
        return res.status(400).json({
          status: 'error',
          message: 'This user is not in your friends list'
        });
      }

      const friendData = {
        ...(friend.toJSON ? friend.toJSON() : friend),
        isBlocked: false,
      };

      return res.status(200).json({
        status: 'success',
        data: { friend: friendData },
      });
    } catch (error) {
      console.error('Error fetching friend details:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend details'
      });
    }
  })
);

// ===== REMOVE FRIEND =====
router.delete(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!Friend) {
        return res.status(503).json({
          status: 'error',
          message: 'Friend service temporarily unavailable'
        });
      }

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

      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: userId, friendId: friend.id },
              { userId: friend.id, friendId: userId }
            ],
            status: 'accepted'
          }
        });

        if (friendships.length === 0) {
          return res.status(400).json({
            status: 'error',
            message: 'This user is not in your friends list'
          });
        }

        await Promise.all(friendships.map(f => f.destroy()));
      } catch (dbError) {
        console.log('[Friends Route] Remove friend error:', dbError.message);
        return res.status(400).json({
          status: 'error',
          message: 'Friend relationship not found'
        });
      }

      return res.status(200).json({
        status: 'success',
        message: 'Friend removed successfully',
      });
    } catch (error) {
      console.error('Error removing friend:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to remove friend'
      });
    }
  })
);

// ===== GET FRIEND STATISTICS =====
router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { total: 0, online: 0, offline: 0, recentlyActive: 0 }
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [Op.or]: [
              { userId: userId, status: 'accepted' },
              { friendId: userId, status: 'accepted' }
            ]
          }
        });
        
        const friendIds = friendships.map(f => f.userId === userId ? f.friendId : f.userId);
        
        const friends = await User.findAll({
          where: { id: { [Op.in]: friendIds } },
          attributes: ['id', 'lastActive']
        });

        return res.status(200).json({
          status: 'success',
          data: {
            total: friendIds.length,
            online: 0,
            offline: friendIds.length,
            recentlyActive: friends.filter(f => f.lastActive).length,
          },
        });
      } catch (dbError) {
        console.log('[Friends Route] Stats query error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { total: 0, online: 0, offline: 0, recentlyActive: 0 }
        });
      }
    } catch (error) {
      console.error('Error fetching friend statistics:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend statistics'
      });
    }
  })
);

// ===== GET SUGGESTIONS =====
router.get(
  '/suggestions',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      const { limit = 10 } = req.query;

      let excludedIds = [userId];
      
      if (Friend) {
        try {
          const friendships = await Friend.findAll({
            where: {
              [Op.or]: [
                { userId: userId },
                { friendId: userId }
              ]
            }
          });
          const friendIds = friendships.map(f => f.userId === userId ? f.friendId : f.userId);
          excludedIds = [...excludedIds, ...friendIds];
        } catch (dbError) {
          console.log('[Friends Route] Suggestions friend query error:', dbError.message);
        }
      }

      const suggestions = await User.findAll({
        where: {
          id: {
            [Op.notIn]: excludedIds
          }
        },
        attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'bio'],
        limit: parseInt(limit),
        order: [['createdAt', 'DESC']]
      });

      return res.status(200).json({
        status: 'success',
        data: { suggestions: suggestions || [] },
      });
    } catch (error) {
      console.error('Error fetching friend suggestions:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend suggestions'
      });
    }
  })
);

// ===== SEARCH NEW USERS =====
router.get(
  '/search/new',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      const { query, page = 1, limit = 20 } = req.query;

      if (!query || query.trim().length < 2) {
        return res.status(400).json({
          status: 'error',
          message: 'Search query must be at least 2 characters'
        });
      }

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let excludedIds = [userId];
      
      if (Friend) {
        try {
          const friendships = await Friend.findAll({
            where: {
              [Op.or]: [
                { userId: userId },
                { friendId: userId }
              ]
            }
          });
          const friendIds = friendships.map(f => f.userId === userId ? f.friendId : f.userId);
          excludedIds = [...excludedIds, ...friendIds];
        } catch (dbError) {
          console.log('[Friends Route] Search friend query error:', dbError.message);
        }
      }

      const searchRegex = `%${query}%`;

      const { count, rows: users } = await User.findAndCountAll({
        where: {
          id: { [Op.notIn]: excludedIds },
          [Op.or]: [
            { username: { [Op.iLike]: searchRegex } },
            { displayName: { [Op.iLike]: searchRegex } }
          ]
        },
        attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio'],
        order: [['username', 'ASC']],
        offset,
        limit: parseInt(limit)
      });

      return res.status(200).json({
        status: 'success',
        data: {
          users: users || [],
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
      return res.status(500).json({
        status: 'error',
        message: 'Failed to search users'
      });
    }
  })
);

// ===== EXPORT FRIENDS =====
router.get(
  '/export',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      const { format = 'json' } = req.query;

      let friendsData = [];

      if (Friend) {
        try {
          const friendships = await Friend.findAll({
            where: {
              [Op.or]: [
                { userId: userId, status: 'accepted' },
                { friendId: userId, status: 'accepted' }
              ]
            },
            include: [
              { model: User, as: 'user', attributes: ['id', 'username', 'displayName', 'avatar', 'status', 'lastActive', 'bio'] },
              { model: User, as: 'friend', attributes: ['id', 'username', 'displayName', 'avatar', 'status', 'lastActive', 'bio'] }
            ]
          });

          friendsData = friendships.map(f => {
            const friend = f.userId === userId ? f.friend : f.user;
            return {
              username: friend?.username,
              displayName: friend?.displayName,
              status: friend?.status,
              lastActive: friend?.lastActive,
              bio: friend?.bio,
            };
          }).filter(f => f.username);
        } catch (dbError) {
          console.log('[Friends Route] Export query error:', dbError.message);
        }
      }

      if (format === 'csv') {
        const fields = ['username', 'displayName', 'status', 'lastActive', 'bio'];
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

      return res.status(200).json({
        status: 'success',
        data: {
          exportedAt: new Date(),
          count: friendsData.length,
          friends: friendsData,
        },
      });
    } catch (error) {
      console.error('Error exporting friends:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to export friends'
      });
    }
  })
);

module.exports = router;