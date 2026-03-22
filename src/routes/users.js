const express = require('express');
const router = express.Router();
const sequelize = require('sequelize');
const asyncHandler = require('express-async-handler');
const {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// ===== SAFE MODEL IMPORT =====
let User, Friend;
try {
  const db = require('../models');
  User = db.User || db.Users;
  Friend = db.Friend || db.Friends;
  console.log('[Users Route] Models loaded - User:', !!User, 'Friend:', !!Friend);
} catch (error) {
  console.error('[Users Route] Error loading models:', error.message);
}

// ===== ERROR HANDLING =====
const ConflictError = class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
};

// ===== SAFE MODEL CHECK MIDDLEWARE =====
const ensureModels = (req, res, next) => {
  if (!User) {
    console.error('[Users Route] User model not available');
    return res.status(503).json({
      status: 'error',
      message: 'Service temporarily unavailable',
      code: 'MODEL_UNAVAILABLE'
    });
  }
  next();
};

router.use(authMiddleware);
router.use(ensureModels);

console.log('✅ Users routes initialized');

// ===== GET ALL USERS =====
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { limit = 50, page = 1 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { id: { [sequelize.Op.ne]: req.user.id } };

      const { count, rows: users } = await User.findAndCountAll({
        where,
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil', 'socketIds']
        },
        offset,
        limit: parseInt(limit),
        order: [['username', 'ASC']]
      });

      return res.status(200).json({
        status: 'success',
        data: { users: users || [], pagination: { total: count || 0, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil((count || 0) / parseInt(limit)) } }
      });
    } catch (error) {
      console.error('Error fetching users:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch users'
      });
    }
  })
);

// ===== GET ALL USERS (ALIAS for /all) =====
router.get(
  '/all',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { limit = 50, page = 1 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { id: { [sequelize.Op.ne]: req.user.id } };

      const { count, rows: users } = await User.findAndCountAll({
        where,
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil', 'socketIds']
        },
        offset,
        limit: parseInt(limit),
        order: [['username', 'ASC']]
      });

      return res.status(200).json({
        status: 'success',
        data: { 
          users: users || [], 
          pagination: { 
            total: count || 0, 
            page: parseInt(page), 
            limit: parseInt(limit), 
            pages: Math.ceil((count || 0) / parseInt(limit)) 
          } 
        }
      });
    } catch (error) {
      console.error('Error fetching all users:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch users'
      });
    }
  })
);

// ===== GET CURRENT USER PROFILE =====
router.get(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil']
        }
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      return res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (error) {
      console.error('Error fetching user profile:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user profile'
      });
    }
  })
);

// ===== UPDATE CURRENT USER PROFILE =====
router.patch(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const allowedUpdates = [
        'username',
        'avatar',
        'bio',
        'status',
        'displayName',
        'emailNotifications',
        'pushNotifications',
      ];
      const updates = {};

      Object.keys(req.body).forEach(key => {
        if (allowedUpdates.includes(key)) {
          updates[key] = req.body[key];
        }
      });

      if (updates.username) {
        updates.username = updates.username.toLowerCase();
        const existingUser = await User.findOne({
          where: {
            username: updates.username,
            id: { [sequelize.Op.ne]: req.user.id }
          }
        });
        if (existingUser) {
          return res.status(409).json({
            status: 'error',
            message: 'Username already taken'
          });
        }
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      await user.update(updates);

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil']
        }
      });

      return res.status(200).json({
        status: 'success',
        message: 'Profile updated successfully',
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error updating user profile:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to update user profile'
      });
    }
  })
);

// ===== UPDATE USER PRESENCE =====
router.post(
  '/presence',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { status } = req.body;

      const validStatuses = ['online', 'away', 'busy', 'offline'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          status: 'error',
          message: `Status must be one of: ${validStatuses.join(', ')}`
        });
      }

      const updateData = {
        status,
        statusLastChanged: new Date(),
        lastActive: new Date()
      };

      const user = await User.findByPk(req.user.id);
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      await user.update(updateData);

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'status', 'lastActive']
      });

      return res.status(200).json({
        status: 'success',
        message: 'Presence updated',
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error updating presence:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to update presence'
      });
    }
  })
);

// ===== GET USER BY ID OR USERNAME =====
router.get(
  '/:identifier',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { identifier } = req.params;
      
      const specialStrings = ['pinned', 'muted', 'all', 'me', 'friends', 'search', 'blocked', 'stats', 'suggestions', 'export'];
      if (specialStrings.includes(identifier)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid user identifier',
          code: 'INVALID_IDENTIFIER'
        });
      }

      let where;
      if (/^[0-9a-fA-F-]{36}$/.test(identifier)) {
        where = { id: identifier };
      } else {
        where = { username: identifier.toLowerCase() };
      }

      const user = await User.findOne({
        where,
        attributes: { 
          exclude: ['password', 'email', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil', 'socketIds']
        }
      });

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      let friendshipStatus = 'none';
      if (req.user && user.id !== req.user.id && Friend) {
        try {
          const isFriend = await Friend.findOne({
            where: {
              [sequelize.Op.or]: [
                { userId: req.user.id, friendId: user.id },
                { userId: user.id, friendId: req.user.id }
              ],
              status: 'accepted'
            }
          });
          friendshipStatus = isFriend ? 'friends' : 'none';
        } catch (dbError) {
          console.log('[Users Route] Friend check error:', dbError.message);
        }
      }

      const userResponse = user.toJSON ? user.toJSON() : user;
      userResponse.friendshipStatus = friendshipStatus;

      return res.status(200).json({
        status: 'success',
        data: { user: userResponse },
      });
    } catch (error) {
      console.error('Error fetching user:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user'
      });
    }
  })
);

// ===== SEARCH USERS =====
router.get(
  '/search/:query',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { query } = req.params;
      const { limit = 20, page = 1 } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { count, rows: users } = await User.findAndCountAll({
        where: {
          [sequelize.Op.or]: [
            { username: { [sequelize.Op.iLike]: `%${query}%` } },
            { displayName: { [sequelize.Op.iLike]: `%${query}%` } }
          ],
          id: { [sequelize.Op.ne]: req.user.id }
        },
        attributes: ['id', 'username', 'avatar', 'displayName', 'status', 'lastActive', 'bio'],
        offset,
        limit: parseInt(limit),
        order: [['username', 'ASC']]
      });

      return res.status(200).json({
        status: 'success',
        data: {
          users: users || [],
          pagination: {
            total: count || 0,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil((count || 0) / parseInt(limit)),
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

// ===== GET USER'S FRIENDS =====
router.get(
  '/me/friends',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.id;

      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { friends: [] }
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [sequelize.Op.or]: [
              { userId: userId, status: 'accepted' },
              { friendId: userId, status: 'accepted' }
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

        const friends = friendships.map(f => {
          if (f.userId === userId) return f.friend;
          return f.user;
        }).filter(f => f);

        return res.status(200).json({
          status: 'success',
          data: { friends: friends || [] },
        });
      } catch (dbError) {
        console.log('[Users Route] Friends query error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { friends: [] }
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

// ===== GET PENDING FRIEND REQUESTS =====
router.get(
  '/me/friend-requests',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.id;

      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { friendRequests: [] }
        });
      }

      try {
        const friendRequests = await Friend.findAll({
          where: {
            friendId: userId,
            status: 'pending'
          },
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'avatar', 'displayName']
          }]
        });

        const requestsData = friendRequests.map(fr => fr.user).filter(u => u);

        return res.status(200).json({
          status: 'success',
          data: { friendRequests: requestsData || [] },
        });
      } catch (dbError) {
        console.log('[Users Route] Friend requests query error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { friendRequests: [] }
        });
      }
    } catch (error) {
      console.error('Error fetching friend requests:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend requests'
      });
    }
  })
);

// ===== SEND FRIEND REQUEST =====
router.post(
  '/:userId/friend-request',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      if (!Friend) {
        return res.status(503).json({
          status: 'error',
          message: 'Friend service temporarily unavailable'
        });
      }

      if (userId === req.user.id) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot send friend request to yourself'
        });
      }

      const [targetUser, currentUser] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(req.user.id)
      ]);

      if (!targetUser) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      try {
        const existingFriendship = await Friend.findOne({
          where: {
            [sequelize.Op.or]: [
              { userId: req.user.id, friendId: userId },
              { userId: userId, friendId: req.user.id }
            ]
          }
        });

        if (existingFriendship) {
          if (existingFriendship.status === 'accepted') {
            return res.status(409).json({
              status: 'error',
              message: 'Already friends with this user'
            });
          } else if (existingFriendship.status === 'pending') {
            if (existingFriendship.userId === req.user.id) {
              return res.status(409).json({
                status: 'error',
                message: 'Friend request already sent'
              });
            } else {
              return res.status(409).json({
                status: 'error',
                message: 'This user has already sent you a friend request'
              });
            }
          }
        }

        await Friend.create({
          userId: req.user.id,
          friendId: userId,
          status: 'pending'
        });
      } catch (dbError) {
        console.log('[Users Route] Friend request creation error:', dbError.message);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to send friend request'
        });
      }

      return res.status(200).json({
        status: 'success',
        message: 'Friend request sent',
      });
    } catch (error) {
      console.error('Error sending friend request:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to send friend request'
      });
    }
  })
);

// ===== ACCEPT FRIEND REQUEST =====
router.post(
  '/:userId/friend-request/accept',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      if (!Friend) {
        return res.status(503).json({
          status: 'error',
          message: 'Friend service temporarily unavailable'
        });
      }

      const [targetUser, currentUser] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(req.user.id)
      ]);

      if (!targetUser) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      try {
        const friendRequest = await Friend.findOne({
          where: {
            userId: userId,
            friendId: req.user.id,
            status: 'pending'
          }
        });

        if (!friendRequest) {
          return res.status(400).json({
            status: 'error',
            message: 'No friend request from this user'
          });
        }

        await friendRequest.update({ status: 'accepted' });

        await Friend.create({
          userId: req.user.id,
          friendId: userId,
          status: 'accepted'
        });
      } catch (dbError) {
        console.log('[Users Route] Accept friend request error:', dbError.message);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to accept friend request'
        });
      }

      return res.status(200).json({
        status: 'success',
        message: 'Friend request accepted',
      });
    } catch (error) {
      console.error('Error accepting friend request:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to accept friend request'
      });
    }
  })
);

// ===== REJECT FRIEND REQUEST =====
router.post(
  '/:userId/friend-request/reject',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      if (!Friend) {
        return res.status(503).json({
          status: 'error',
          message: 'Friend service temporarily unavailable'
        });
      }

      try {
        const friendRequest = await Friend.findOne({
          where: {
            userId: userId,
            friendId: req.user.id,
            status: 'pending'
          }
        });

        if (!friendRequest) {
          return res.status(400).json({
            status: 'error',
            message: 'No friend request from this user'
          });
        }

        await friendRequest.destroy();
      } catch (dbError) {
        console.log('[Users Route] Reject friend request error:', dbError.message);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to reject friend request'
        });
      }

      return res.status(200).json({
        status: 'success',
        message: 'Friend request rejected',
      });
    } catch (error) {
      console.error('Error rejecting friend request:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to reject friend request'
      });
    }
  })
);

// ===== REMOVE FRIEND =====
router.delete(
  '/:userId/friend',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      if (!Friend) {
        return res.status(503).json({
          status: 'error',
          message: 'Friend service temporarily unavailable'
        });
      }

      const [targetUser, currentUser] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(req.user.id)
      ]);

      if (!targetUser) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [sequelize.Op.or]: [
              { userId: req.user.id, friendId: userId },
              { userId: userId, friendId: req.user.id }
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
        console.log('[Users Route] Remove friend error:', dbError.message);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to remove friend'
        });
      }

      return res.status(200).json({
        status: 'success',
        message: 'Friend removed',
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

// ===== GET ONLINE FRIENDS COUNT =====
router.get(
  '/me/friends/online-count',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.id;

      if (!Friend) {
        return res.status(200).json({
          status: 'success',
          data: { onlineCount: 0 }
        });
      }

      try {
        const friendships = await Friend.findAll({
          where: {
            [sequelize.Op.or]: [
              { userId: userId, status: 'accepted' },
              { friendId: userId, status: 'accepted' }
            ]
          }
        });

        const friendIds = friendships.map(f => f.userId === userId ? f.friendId : f.userId);

        return res.status(200).json({
          status: 'success',
          data: { onlineCount: 0 }
        });
      } catch (dbError) {
        console.log('[Users Route] Online count error:', dbError.message);
        return res.status(200).json({
          status: 'success',
          data: { onlineCount: 0 }
        });
      }
    } catch (error) {
      console.error('Error fetching online friends count:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch online friends count'
      });
    }
  })
);

// ===== REGISTER SOCKET ID =====
router.post(
  '/socket/:socketId',
  asyncHandler(async (req, res) => {
    try {
      const { socketId } = req.params;

      const user = await User.findByPk(req.user.id);
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const socketIds = user.socketIds || [];
      if (!socketIds.includes(socketId)) {
        socketIds.push(socketId);
      }

      await user.update({
        socketIds: socketIds,
        lastActive: new Date()
      });

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'status']
      });

      return res.status(200).json({
        status: 'success',
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error adding socket ID:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to add socket ID'
      });
    }
  })
);

// ===== REMOVE SOCKET ID =====
router.delete(
  '/socket/:socketId',
  asyncHandler(async (req, res) => {
    try {
      const { socketId } = req.params;

      const user = await User.findByPk(req.user.id);
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const socketIds = user.socketIds || [];
      const updatedSocketIds = socketIds.filter(id => id !== socketId);

      await user.update({ socketIds: updatedSocketIds });

      return res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (error) {
      console.error('Error removing socket ID:', error.message);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to remove socket ID'
      });
    }
  })
);

module.exports = router;