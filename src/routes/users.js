const ConflictError = class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
};

const router = require('express').Router();
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
const { User, Friend } = require('../models');
const userController = require('../controllers/userController');

router.use(authMiddleware);

console.log('✅ Users routes initialized');

router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { limit = 50, page = 1, online } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { id: { [sequelize.Op.ne]: req.user.id } };
      
      if (online !== undefined) {
        where.online = online === 'true';
      }

      const { count, rows: users } = await User.findAndCountAll({
        where,
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil', 'socketIds']
        },
        offset,
        limit: parseInt(limit),
        order: [['online', 'DESC'], ['username', 'ASC']]
      });

      const response = userController.getAllUsers(users, count, parseInt(page), parseInt(limit));
      
      res.status(200).json(response);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch users'
      });
    }
  })
);

router.get(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil']
        },
        include: [
          {
            model: User,
            as: 'friends',
            attributes: ['id', 'username', 'avatar', 'online', 'lastActive', 'status'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'friendRequests',
            attributes: ['id', 'username', 'avatar'],
            through: { 
              as: 'friendRequestData',
              attributes: ['status', 'createdAt']
            },
            where: { '$friendRequestData.status$': 'pending' }
          }
        ]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (error) {
      console.error('Error fetching user profile:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user profile'
      });
    }
  })
);

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
          throw new ConflictError('Username already taken');
        }
      }

      if (updates.email) {
        updates.email = updates.email.toLowerCase();
        const existingUser = await User.findOne({
          where: {
            email: updates.email,
            id: { [sequelize.Op.ne]: req.user.id }
          }
        });
        if (existingUser) {
          throw new ConflictError('Email already taken');
        }
      }

      if (updates.status) {
        updates.statusLastChanged = new Date();
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update(updates);

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: { 
          exclude: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'loginAttempts', 'lockedUntil']
        }
      });

      if (req.io && req.userSocketIds && req.userSocketIds.length > 0) {
        req.userSocketIds.forEach(socketId => {
          req.io.to(socketId).emit('profile:updated', {
            user: {
              id: updatedUser.id,
              username: updatedUser.username,
              avatar: updatedUser.avatar,
              bio: updatedUser.bio,
              status: updatedUser.status,
              displayName: updatedUser.displayName,
            },
          });
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Profile updated successfully',
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error updating user profile:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update user profile'
      });
    }
  })
);

router.post(
  '/presence',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { status } = req.body;

      const validStatuses = ['online', 'away', 'busy', 'offline'];
      if (!validStatuses.includes(status)) {
        throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
      }

      const updateData = {
        status,
        statusLastChanged: new Date(),
      };

      if (status === 'online') {
        updateData.lastActive = new Date();
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await user.update(updateData);

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'status', 'lastActive']
      });

      if (req.io) {
        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id'],
            through: { attributes: [] }
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
                req.io.to(socketId).emit('presence:update', {
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

      res.status(200).json({
        status: 'success',
        message: 'Presence updated',
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error updating presence:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update presence'
      });
    }
  })
);

router.get(
  '/:identifier',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { identifier } = req.params;

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
        },
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'username', 'avatar', 'online', 'status', 'lastActive'],
          through: { attributes: [] }
        }]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      let friendshipStatus = 'none';
      if (req.user && user.id !== req.user.id) {
        const currentUser = await User.findByPk(req.user.id);

        const isFriend = await Friend.findOne({
          where: {
            [sequelize.Op.or]: [
              { userId: req.user.id, friendId: user.id },
              { userId: user.id, friendId: req.user.id }
            ],
            status: 'accepted'
          }
        });

        if (isFriend) {
          friendshipStatus = 'friends';
        } else {
          const receivedRequest = await Friend.findOne({
            where: {
              userId: req.user.id,
              friendId: user.id,
              status: 'pending'
            }
          });

          if (receivedRequest) {
            friendshipStatus = 'request_received';
          } else {
            const sentRequest = await Friend.findOne({
              where: {
                userId: user.id,
                friendId: req.user.id,
                status: 'pending'
              }
            });

            if (sentRequest) {
              friendshipStatus = 'request_sent';
            }
          }
        }
      }

      const userResponse = user.toJSON();
      userResponse.friendshipStatus = friendshipStatus;

      res.status(200).json({
        status: 'success',
        data: { user: userResponse },
      });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user'
      });
    }
  })
);

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
        attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'lastActive', 'bio'],
        offset,
        limit: parseInt(limit),
        order: [['online', 'DESC'], ['username', 'ASC']]
      });

      res.status(200).json({
        status: 'success',
        data: {
          users,
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
  '/me/friends',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { status } = req.query;

      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'lastActive', 'bio'],
          through: { attributes: [] },
          where: status ? { online: status === 'online' } : undefined,
          required: false
        }]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      res.status(200).json({
        status: 'success',
        data: { friends: user.friends },
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
  '/me/friend-requests',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friendRequests',
          attributes: ['id', 'username', 'avatar', 'displayName'],
          through: { 
            as: 'friendRequestData',
            attributes: ['status', 'createdAt']
          },
          where: { '$friendRequestData.status$': 'pending' }
        }]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      res.status(200).json({
        status: 'success',
        data: { friendRequests: user.friendRequests },
      });
    } catch (error) {
      console.error('Error fetching friend requests:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch friend requests'
      });
    }
  })
);

router.post(
  '/:userId/friend-request',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      if (userId === req.user.id) {
        throw new ValidationError('Cannot send friend request to yourself');
      }

      const [targetUser, currentUser] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(req.user.id)
      ]);

      if (!targetUser) {
        throw new NotFoundError('User not found');
      }

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
          throw new ConflictError('Already friends with this user');
        } else if (existingFriendship.status === 'pending') {
          if (existingFriendship.userId === req.user.id) {
            throw new ConflictError('Friend request already sent');
          } else {
            throw new ConflictError('This user has already sent you a friend request');
          }
        }
      }

      await Friend.create({
        userId: req.user.id,
        friendId: userId,
        status: 'pending'
      });

      if (req.io && targetUser.socketIds && targetUser.socketIds.length > 0) {
        targetUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('friend:request-received', {
            from: {
              id: currentUser.id,
              username: currentUser.username,
              avatar: currentUser.avatar,
              displayName: currentUser.displayName,
            },
            timestamp: new Date(),
          });
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Friend request sent',
      });
    } catch (error) {
      console.error('Error sending friend request:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to send friend request'
      });
    }
  })
);

router.post(
  '/:userId/friend-request/accept',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      const [targetUser, currentUser] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(req.user.id)
      ]);

      if (!targetUser) {
        throw new NotFoundError('User not found');
      }

      const friendRequest = await Friend.findOne({
        where: {
          userId: userId,
          friendId: req.user.id,
          status: 'pending'
        }
      });

      if (!friendRequest) {
        throw new ValidationError('No friend request from this user');
      }

      await friendRequest.update({ status: 'accepted' });

      await Friend.create({
        userId: req.user.id,
        friendId: userId,
        status: 'accepted'
      });

      if (req.io) {
        if (targetUser.socketIds && targetUser.socketIds.length > 0) {
          targetUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('friend:request-accepted', {
              by: {
                id: currentUser.id,
                username: currentUser.username,
                avatar: currentUser.avatar,
              },
              timestamp: new Date(),
            });
          });
        }

        if (currentUser.socketIds && currentUser.socketIds.length > 0) {
          currentUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('friend:added', {
              user: {
                id: targetUser.id,
                username: targetUser.username,
                avatar: targetUser.avatar,
                online: targetUser.online,
                status: targetUser.status,
              },
              timestamp: new Date(),
            });
          });
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Friend request accepted',
      });
    } catch (error) {
      console.error('Error accepting friend request:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to accept friend request'
      });
    }
  })
);

router.post(
  '/:userId/friend-request/reject',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      const friendRequest = await Friend.findOne({
        where: {
          userId: userId,
          friendId: req.user.id,
          status: 'pending'
        }
      });

      if (!friendRequest) {
        throw new ValidationError('No friend request from this user');
      }

      await friendRequest.destroy();

      res.status(200).json({
        status: 'success',
        message: 'Friend request rejected',
      });
    } catch (error) {
      console.error('Error rejecting friend request:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to reject friend request'
      });
    }
  })
);

router.delete(
  '/:userId/friend',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { userId } = req.params;

      const [targetUser, currentUser] = await Promise.all([
        User.findByPk(userId),
        User.findByPk(req.user.id)
      ]);

      if (!targetUser) {
        throw new NotFoundError('User not found');
      }

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
        throw new ValidationError('This user is not in your friends list');
      }

      await Promise.all(friendships.map(f => f.destroy()));

      if (req.io && targetUser.socketIds && targetUser.socketIds.length > 0) {
        targetUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('friend:removed', {
            by: {
              id: currentUser.id,
              username: currentUser.username,
            },
            timestamp: new Date(),
          });
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Friend removed',
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

router.get(
  '/me/friends/online-count',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'friends',
          attributes: ['id'],
          through: { attributes: [] },
          where: { online: true }
        }]
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      res.status(200).json({
        status: 'success',
        data: { onlineCount: user.friends.length },
      });
    } catch (error) {
      console.error('Error fetching online friends count:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch online friends count'
      });
    }
  })
);

router.post(
  '/socket/:socketId',
  asyncHandler(async (req, res) => {
    try {
      const { socketId } = req.params;

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const socketIds = user.socketIds || [];
      if (!socketIds.includes(socketId)) {
        socketIds.push(socketId);
      }

      await user.update({
        socketIds: socketIds,
        online: true,
        lastActive: new Date()
      });

      const updatedUser = await User.findByPk(req.user.id, {
        attributes: ['id', 'username', 'avatar', 'online', 'status']
      });

      if (req.io) {
        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id'],
            through: { attributes: [] }
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
                req.io.to(socketId).emit('presence:online', {
                  userId: updatedUser.id,
                  username: updatedUser.username,
                  avatar: updatedUser.avatar,
                  status: updatedUser.status,
                  timestamp: new Date(),
                });
              });
            }
          });
        }
      }

      res.status(200).json({
        status: 'success',
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error('Error adding socket ID:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to add socket ID'
      });
    }
  })
);

router.delete(
  '/socket/:socketId',
  asyncHandler(async (req, res) => {
    try {
      const { socketId } = req.params;

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const socketIds = user.socketIds || [];
      const updatedSocketIds = socketIds.filter(id => id !== socketId);

      await user.update({ socketIds: updatedSocketIds });

      if (updatedSocketIds.length === 0) {
        await user.update({
          online: false,
          status: 'offline',
          statusLastChanged: new Date()
        });

        if (req.io) {
          const currentUser = await User.findByPk(req.user.id, {
            include: [{
              model: User,
              as: 'friends',
              attributes: ['id'],
              through: { attributes: [] }
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
                  req.io.to(socketId).emit('presence:offline', {
                    userId: user.id,
                    username: user.username,
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
    } catch (error) {
      console.error('Error removing socket ID:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove socket ID'
      });
    }
  })
);

module.exports = router;