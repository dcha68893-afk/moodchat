const ConflictError = class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
};

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

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get current user profile
 */
router.get(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id)
      .select('-password -resetPasswordToken -resetPasswordExpires -loginAttempts -lockedUntil')
      .populate('friends', 'username avatar online lastActive status')
      .populate('friendRequests', 'username avatar');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    res.status(200).json({
      status: 'success',
      data: { user },
    });
  })
);

/**
 * Update current user profile
 */
router.patch(
  '/me',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
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

    // Filter only allowed fields
    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key)) {
        updates[key] = req.body[key];
      }
    });

    // Handle username uniqueness if being updated
    if (updates.username) {
      updates.username = updates.username.toLowerCase();
      const existingUser = await User.findOne({
        username: updates.username,
        _id: { $ne: req.user.id },
      });
      if (existingUser) {
        throw new ConflictError('Username already taken');
      }
    }

    // Handle email uniqueness if being updated
    if (updates.email) {
      updates.email = updates.email.toLowerCase();
      const existingUser = await User.findOne({
        email: updates.email,
        _id: { $ne: req.user.id },
      });
      if (existingUser) {
        throw new ConflictError('Email already taken');
      }
    }

    // Update status timestamp if status is being updated
    if (updates.status) {
      updates.statusLastChanged = new Date();
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select('-password -resetPasswordToken -resetPasswordExpires -loginAttempts -lockedUntil');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Emit profile update event to connected sockets
    if (req.io && req.userSocketIds && req.userSocketIds.length > 0) {
      req.userSocketIds.forEach(socketId => {
        req.io.to(socketId).emit('profile:updated', {
          user: {
            id: user._id,
            username: user.username,
            avatar: user.avatar,
            bio: user.bio,
            status: user.status,
            displayName: user.displayName,
          },
        });
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Profile updated successfully',
      data: { user },
    });
  })
);

/**
 * Update user presence status
 */
router.post(
  '/presence',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const validStatuses = ['online', 'away', 'busy', 'offline'];
    if (!validStatuses.includes(status)) {
      throw new ValidationError(`Status must be one of: ${validStatuses.join(', ')}`);
    }

    const updateData = {
      status,
      statusLastChanged: new Date(),
    };

    // Update lastActive if status is online
    if (status === 'online') {
      updateData.lastActive = new Date();
    }

    const user = await User.findByIdAndUpdate(req.user.id, updateData, { new: true }).select(
      'username avatar status lastActive'
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Broadcast presence update to friends
    if (req.io) {
      // Get user's friends
      const currentUser = await User.findById(req.user.id).select('friends');

      if (currentUser.friends && currentUser.friends.length > 0) {
        // Find online friends
        const onlineFriends = await User.find({
          _id: { $in: currentUser.friends },
          online: true,
        }).select('socketIds');

        // Send presence update to each online friend
        onlineFriends.forEach(friend => {
          if (friend.socketIds && friend.socketIds.length > 0) {
            friend.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('presence:update', {
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

    res.status(200).json({
      status: 'success',
      message: 'Presence updated',
      data: { user },
    });
  })
);

/**
 * Get user by ID or username
 */
router.get(
  '/:identifier',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { identifier } = req.params;

    let query;
    if (mongoose.Types.ObjectId.isValid(identifier)) {
      query = { _id: identifier };
    } else {
      query = { username: identifier.toLowerCase() };
    }

    const user = await User.findOne(query)
      .select(
        '-password -email -resetPasswordToken -resetPasswordExpires -loginAttempts -lockedUntil -socketIds'
      )
      .populate('friends', 'username avatar online status lastActive');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check friendship status if requesting user is authenticated
    let friendshipStatus = 'none';
    if (req.user && user._id.toString() !== req.user.id) {
      const currentUser = await User.findById(req.user.id);

      if (currentUser.friends.includes(user._id)) {
        friendshipStatus = 'friends';
      } else if (currentUser.friendRequests.includes(user._id)) {
        friendshipStatus = 'request_received';
      } else if (user.friendRequests.includes(currentUser._id)) {
        friendshipStatus = 'request_sent';
      }
    }

    const userResponse = user.toObject();
    userResponse.friendshipStatus = friendshipStatus;

    res.status(200).json({
      status: 'success',
      data: { user: userResponse },
    });
  })
);

/**
 * Search users by username or display name
 */
router.get(
  '/search/:query',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { query } = req.params;
    const { limit = 20, page = 1 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Search for users (case-insensitive, partial match)
    const users = await User.find({
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { displayName: { $regex: query, $options: 'i' } },
      ],
      _id: { $ne: req.user.id }, // Exclude current user
    })
      .select('username avatar displayName online status lastActive bio')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ online: -1, username: 1 });

    const total = await User.countDocuments({
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { displayName: { $regex: query, $options: 'i' } },
      ],
      _id: { $ne: req.user.id },
    });

    res.status(200).json({
      status: 'success',
      data: {
        users,
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
 * Get user's friends list
 */
router.get(
  '/me/friends',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { status } = req.query; // Optional: filter by online status

    const user = await User.findById(req.user.id).populate({
      path: 'friends',
      select: 'username avatar displayName online status lastActive bio',
      match: status ? { online: status === 'online' } : {},
      options: { sort: { online: -1, username: 1 } },
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    res.status(200).json({
      status: 'success',
      data: { friends: user.friends },
    });
  })
);

/**
 * Get user's friend requests
 */
router.get(
  '/me/friend-requests',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).populate(
      'friendRequests',
      'username avatar displayName'
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    res.status(200).json({
      status: 'success',
      data: { friendRequests: user.friendRequests },
    });
  })
);

/**
 * Send friend request
 */
router.post(
  '/:userId/friend-request',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (userId === req.user.id) {
      throw new ValidationError('Cannot send friend request to yourself');
    }

    const [targetUser, currentUser] = await Promise.all([
      User.findById(userId),
      User.findById(req.user.id),
    ]);

    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    // Check if already friends
    if (currentUser.friends.includes(targetUser._id)) {
      throw new ConflictError('Already friends with this user');
    }

    // Check if request already sent
    if (targetUser.friendRequests.includes(currentUser._id)) {
      throw new ConflictError('Friend request already sent');
    }

    // Check if request already received
    if (currentUser.friendRequests.includes(targetUser._id)) {
      throw new ConflictError('This user has already sent you a friend request');
    }

    // Add to target user's friend requests
    targetUser.friendRequests.push(currentUser._id);
    await targetUser.save();

    // Send notification via WebSocket if target is online
    if (req.io && targetUser.socketIds && targetUser.socketIds.length > 0) {
      targetUser.socketIds.forEach(socketId => {
        req.io.to(socketId).emit('friend:request-received', {
          from: {
            id: currentUser._id,
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
  })
);

/**
 * Accept friend request
 */
router.post(
  '/:userId/friend-request/accept',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const [targetUser, currentUser] = await Promise.all([
      User.findById(userId),
      User.findById(req.user.id),
    ]);

    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    // Check if request exists
    if (!currentUser.friendRequests.includes(targetUser._id)) {
      throw new ValidationError('No friend request from this user');
    }

    // Remove from friend requests
    currentUser.friendRequests = currentUser.friendRequests.filter(
      id => id.toString() !== targetUser._id.toString()
    );

    // Add to friends list for both users
    if (!currentUser.friends.includes(targetUser._id)) {
      currentUser.friends.push(targetUser._id);
    }

    if (!targetUser.friends.includes(currentUser._id)) {
      targetUser.friends.push(currentUser._id);
    }

    await Promise.all([currentUser.save(), targetUser.save()]);

    // Send notifications via WebSocket
    if (req.io) {
      // Notify the user who sent the request
      if (targetUser.socketIds && targetUser.socketIds.length > 0) {
        targetUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('friend:request-accepted', {
            by: {
              id: currentUser._id,
              username: currentUser.username,
              avatar: currentUser.avatar,
            },
            timestamp: new Date(),
          });
        });
      }

      // Notify the user who accepted the request
      if (currentUser.socketIds && currentUser.socketIds.length > 0) {
        currentUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('friend:added', {
            user: {
              id: targetUser._id,
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
  })
);

/**
 * Reject friend request
 */
router.post(
  '/:userId/friend-request/reject',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const currentUser = await User.findById(req.user.id);

    // Remove from friend requests
    currentUser.friendRequests = currentUser.friendRequests.filter(id => id.toString() !== userId);

    await currentUser.save();

    res.status(200).json({
      status: 'success',
      message: 'Friend request rejected',
    });
  })
);

/**
 * Remove friend
 */
router.delete(
  '/:userId/friend',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const [targetUser, currentUser] = await Promise.all([
      User.findById(userId),
      User.findById(req.user.id),
    ]);

    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    // Remove from friends list for both users
    currentUser.friends = currentUser.friends.filter(
      id => id.toString() !== targetUser._id.toString()
    );

    targetUser.friends = targetUser.friends.filter(
      id => id.toString() !== currentUser._id.toString()
    );

    await Promise.all([currentUser.save(), targetUser.save()]);

    // Send notification via WebSocket if target is online
    if (req.io && targetUser.socketIds && targetUser.socketIds.length > 0) {
      targetUser.socketIds.forEach(socketId => {
        req.io.to(socketId).emit('friend:removed', {
          by: {
            id: currentUser._id,
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
  })
);

/**
 * Get online friends count
 */
router.get(
  '/me/friends/online-count',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).populate({
      path: 'friends',
      match: { online: true },
      select: '_id',
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    res.status(200).json({
      status: 'success',
      data: { onlineCount: user.friends.length },
    });
  })
);

/**
 * Update user's socket ID (for WebSocket connection tracking)
 * This endpoint is called by the WebSocket server when a user connects
 */
router.post(
  '/socket/:socketId',
  asyncHandler(async (req, res) => {
    const { socketId } = req.params;

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $addToSet: { socketIds: socketId },
        $set: {
          online: true,
          lastActive: new Date(),
        },
      },
      { new: true }
    ).select('username avatar online status');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Notify friends about online status
    if (req.io) {
      const currentUser = await User.findById(req.user.id).select('friends');

      if (currentUser.friends && currentUser.friends.length > 0) {
        const onlineFriends = await User.find({
          _id: { $in: currentUser.friends },
          online: true,
        }).select('socketIds');

        onlineFriends.forEach(friend => {
          if (friend.socketIds && friend.socketIds.length > 0) {
            friend.socketIds.forEach(friendSocketId => {
              req.io.to(friendSocketId).emit('presence:online', {
                userId: user._id,
                username: user.username,
                avatar: user.avatar,
                status: user.status,
                timestamp: new Date(),
              });
            });
          }
        });
      }
    }

    res.status(200).json({
      status: 'success',
      data: { user },
    });
  })
);

/**
 * Remove user's socket ID (for WebSocket connection tracking)
 * This endpoint is called by the WebSocket server when a user disconnects
 */
router.delete(
  '/socket/:socketId',
  asyncHandler(async (req, res) => {
    const { socketId } = req.params;

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $pull: { socketIds: socketId },
      },
      { new: true }
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // If no more socket IDs, set user as offline
    if (user.socketIds.length === 0) {
      user.online = false;
      user.status = 'offline';
      user.statusLastChanged = new Date();
      await user.save();

      // Notify friends about offline status
      if (req.io) {
        const currentUser = await User.findById(req.user.id).select('friends');

        if (currentUser.friends && currentUser.friends.length > 0) {
          const onlineFriends = await User.find({
            _id: { $in: currentUser.friends },
            online: true,
          }).select('socketIds');

          onlineFriends.forEach(friend => {
            if (friend.socketIds && friend.socketIds.length > 0) {
              friend.socketIds.forEach(friendSocketId => {
                req.io.to(friendSocketId).emit('presence:offline', {
                  userId: user._id,
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
  })
);

module.exports = router;
