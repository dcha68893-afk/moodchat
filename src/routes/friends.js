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
  ConflictError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const User = require('../models/User');

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get all friends with pagination and filtering
 */
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 50,
      status, // 'online', 'offline', 'all'
      sort = 'recent', // 'recent', 'name', 'online'
      search,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const user = await User.findById(req.user.id).populate('friends');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Build query for filtering friends
    let friendQuery = { _id: { $in: user.friends } };

    // Filter by online status
    if (status && status !== 'all') {
      friendQuery.online = status === 'online';
    }

    // Search by username or displayName
    if (search && search.trim()) {
      const searchRegex = new RegExp(search, 'i');
      friendQuery.$or = [{ username: searchRegex }, { displayName: searchRegex }];
    }

    // Determine sort order
    let sortCriteria = {};
    switch (sort) {
      case 'name':
        sortCriteria = { username: 1 };
        break;
      case 'online':
        sortCriteria = { online: -1, username: 1 };
        break;
      case 'recent':
      default:
        sortCriteria = { lastActive: -1, username: 1 };
        break;
    }

    // Get friends with pagination
    const [friends, total] = await Promise.all([
      User.find(friendQuery)
        .select('username avatar displayName online status lastActive bio isBlocked')
        .sort(sortCriteria)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(friendQuery),
    ]);

    // Add friendship metadata
    const friendsWithMetadata = friends.map(friend => ({
      ...friend,
      friendshipSince: getFriendshipDate(user, friend._id),
      isBlocked: user.blockedUsers?.includes(friend._id) || false,
    }));

    res.status(200).json({
      status: 'success',
      data: {
        friends: friendsWithMetadata,
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
 * Get specific friend details
 */
router.get(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { friendId } = req.params;

    const [user, friend] = await Promise.all([
      User.findById(req.user.id),
      User.findById(friendId)
        .select(
          '-password -email -resetPasswordToken -resetPasswordExpires -loginAttempts -lockedUntil -socketIds'
        )
        .populate('friends', 'username avatar online status'),
    ]);

    if (!user || !friend) {
      throw new NotFoundError('User or friend not found');
    }

    // Check if they are actually friends
    if (!user.friends.includes(friend._id)) {
      throw new ValidationError('This user is not in your friends list');
    }

    // Get mutual friends
    const mutualFriends = await User.find({
      _id: {
        $in: friend.friends.filter(friendId =>
          user.friends.some(userFriendId => userFriendId.equals(friendId))
        ),
      },
    }).select('username avatar online status');

    // Get recent interactions (last 7 days)
    const recentInteractions = await getRecentInteractions(req.user.id, friendId);

    const friendData = {
      ...friend.toObject(),
      isBlocked: user.blockedUsers?.includes(friend._id) || false,
      friendshipSince: getFriendshipDate(user, friend._id),
      mutualFriends,
      recentInteractions,
      sharedGroups: await getSharedGroups(req.user.id, friendId),
    };

    res.status(200).json({
      status: 'success',
      data: { friend: friendData },
    });
  })
);

/**
 * Remove a friend
 */
router.delete(
  '/:friendId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { friendId } = req.params;

    const [user, friend] = await Promise.all([User.findById(req.user.id), User.findById(friendId)]);

    if (!user || !friend) {
      throw new NotFoundError('User or friend not found');
    }

    // Check if they are actually friends
    if (!user.friends.includes(friend._id)) {
      throw new ValidationError('This user is not in your friends list');
    }

    // Remove from both users' friends lists
    user.friends = user.friends.filter(id => !id.equals(friend._id));
    friend.friends = friend.friends.filter(id => !id.equals(user._id));

    // Remove from any pending friend requests
    user.friendRequests = user.friendRequests.filter(id => !id.equals(friend._id));
    friend.friendRequests = friend.friendRequests.filter(id => !id.equals(user._id));

    await Promise.all([user.save(), friend.save()]);

    // Send WebSocket notification if friend is online
    if (req.io && friend.socketIds && friend.socketIds.length > 0) {
      friend.socketIds.forEach(socketId => {
        req.io.to(socketId).emit('friend:removed', {
          byUserId: user._id,
          byUsername: user.username,
          timestamp: new Date(),
        });
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Friend removed successfully',
    });
  })
);

/**
 * Block a user (can be friend or non-friend)
 */
router.post(
  '/:userId/block',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (userId === req.user.id) {
      throw new ValidationError('Cannot block yourself');
    }

    const [user, userToBlock] = await Promise.all([
      User.findById(req.user.id),
      User.findById(userId),
    ]);

    if (!user || !userToBlock) {
      throw new NotFoundError('User not found');
    }

    // Check if already blocked
    if (user.blockedUsers && user.blockedUsers.includes(userToBlock._id)) {
      throw new ConflictError('User is already blocked');
    }

    // Add to blocked list
    if (!user.blockedUsers) user.blockedUsers = [];
    user.blockedUsers.push(userToBlock._id);

    // Remove from friends list if they were friends
    if (user.friends.includes(userToBlock._id)) {
      user.friends = user.friends.filter(id => !id.equals(userToBlock._id));
      userToBlock.friends = userToBlock.friends.filter(id => !id.equals(user._id));

      // Send WebSocket notification about unfriending due to blocking
      if (req.io && userToBlock.socketIds && userToBlock.socketIds.length > 0) {
        userToBlock.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('friend:removed', {
            byUserId: user._id,
            byUsername: user.username,
            timestamp: new Date(),
            reason: 'blocked',
          });
        });
      }
    }

    // Remove any pending friend requests in both directions
    user.friendRequests = user.friendRequests.filter(id => !id.equals(userToBlock._id));
    userToBlock.friendRequests = userToBlock.friendRequests.filter(id => !id.equals(user._id));

    await Promise.all([user.save(), userToBlock.save()]);

    // Send WebSocket notification about blocking
    if (req.io && userToBlock.socketIds && userToBlock.socketIds.length > 0) {
      userToBlock.socketIds.forEach(socketId => {
        req.io.to(socketId).emit('user:blocked', {
          blockedByUserId: user._id,
          blockedByUsername: user.username,
          timestamp: new Date(),
        });
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'User blocked successfully',
    });
  })
);

/**
 * Unblock a user
 */
router.post(
  '/:userId/unblock',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const user = await User.findById(req.user.id);

    if (!user.blockedUsers || !user.blockedUsers.includes(userId)) {
      throw new ValidationError('User is not blocked');
    }

    // Remove from blocked list
    user.blockedUsers = user.blockedUsers.filter(id => !id.equals(userId));
    await user.save();

    res.status(200).json({
      status: 'success',
      message: 'User unblocked successfully',
    });
  })
);

/**
 * Get blocked users list
 */
router.get(
  '/blocked/list',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).populate({
      path: 'blockedUsers',
      select: 'username avatar displayName online status',
      options: { sort: { username: 1 } },
    });

    if (!user.blockedUsers || user.blockedUsers.length === 0) {
      return res.status(200).json({
        status: 'success',
        data: { blockedUsers: [] },
      });
    }

    res.status(200).json({
      status: 'success',
      data: { blockedUsers: user.blockedUsers },
    });
  })
);

/**
 * Search for users to add as friends
 */
router.get(
  '/search/new',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { query, page = 1, limit = 20, excludeFriends = true } = req.query;

    if (!query || query.trim().length < 2) {
      throw new ValidationError('Search query must be at least 2 characters');
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const user = await User.findById(req.user.id);

    const searchRegex = new RegExp(query, 'i');

    // Build search query
    const searchQuery = {
      $or: [{ username: searchRegex }, { displayName: searchRegex }],
      _id: { $ne: user._id }, // Exclude self
    };

    // Exclude existing friends if requested
    if (excludeFriends === 'true' && user.friends.length > 0) {
      searchQuery._id.$nin = user.friends;
    }

    // Exclude blocked users
    if (user.blockedUsers && user.blockedUsers.length > 0) {
      searchQuery._id.$nin = [...(searchQuery._id.$nin || []), ...user.blockedUsers];
    }

    // Exclude users who have blocked the current user
    const usersWhoBlockedMe = await User.find({
      blockedUsers: user._id,
    }).select('_id');

    if (usersWhoBlockedMe.length > 0) {
      searchQuery._id.$nin = [
        ...(searchQuery._id.$nin || []),
        ...usersWhoBlockedMe.map(u => u._id),
      ];
    }

    const [users, total] = await Promise.all([
      User.find(searchQuery)
        .select('username avatar displayName online status lastActive bio')
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ online: -1, username: 1 })
        .lean(),
      User.countDocuments(searchQuery),
    ]);

    // Add relationship status for each user
    const usersWithStatus = users.map(otherUser => {
      const relationship = {
        isFriend: user.friends.some(friendId => friendId.equals(otherUser._id)),
        hasSentRequest: user.friendRequests.some(requestId => requestId.equals(otherUser._id)),
        hasReceivedRequest:
          otherUser.friendRequests?.some(requestId => requestId.equals(user._id)) || false,
        isBlocked: user.blockedUsers?.some(blockedId => blockedId.equals(otherUser._id)) || false,
      };

      return {
        ...otherUser,
        relationship,
      };
    });

    res.status(200).json({
      status: 'success',
      data: {
        users: usersWithStatus,
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
 * Get friend suggestions (users you may know)
 */
router.get(
  '/suggestions',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { limit = 10 } = req.query;

    const user = await User.findById(req.user.id).populate('friends');

    // Get friends of friends who are not already friends
    const friendIds = user.friends.map(friend => friend._id);

    if (friendIds.length === 0) {
      // If no friends, suggest popular users
      const suggestions = await User.find({
        _id: {
          $ne: user._id,
          $nin: [...(user.blockedUsers || [])],
        },
      })
        .select('username avatar displayName online status bio')
        .limit(parseInt(limit))
        .sort({ createdAt: -1 });

      return res.status(200).json({
        status: 'success',
        data: { suggestions },
      });
    }

    const suggestions = await User.aggregate([
      {
        $match: {
          _id: {
            $ne: user._id,
            $nin: [...friendIds, ...(user.blockedUsers || [])],
          },
          friends: { $in: friendIds },
        },
      },
      {
        $addFields: {
          mutualCount: {
            $size: {
              $setIntersection: ['$friends', friendIds],
            },
          },
        },
      },
      {
        $sort: {
          mutualCount: -1,
          online: -1,
          createdAt: -1,
        },
      },
      {
        $limit: parseInt(limit),
      },
      {
        $project: {
          username: 1,
          avatar: 1,
          displayName: 1,
          online: 1,
          status: 1,
          bio: 1,
          mutualCount: 1,
        },
      },
    ]);

    res.status(200).json({
      status: 'success',
      data: { suggestions },
    });
  })
);

/**
 * Export friends list
 */
router.get(
  '/export',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { format = 'json' } = req.query;

    const user = await User.findById(req.user.id).populate({
      path: 'friends',
      select: 'username displayName email avatar online status lastActive bio',
      options: { sort: { username: 1 } },
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
      // Convert to CSV
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

    // Default JSON format
    res.status(200).json({
      status: 'success',
      data: {
        exportedAt: new Date(),
        count: friendsData.length,
        friends: friendsData,
      },
    });
  })
);

/**
 * Bulk update friend categories/tags
 */
router.post(
  '/bulk/categories',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { updates } = req.body; // Array of { friendId, category }

    if (!Array.isArray(updates) || updates.length === 0) {
      throw new ValidationError('Updates array is required');
    }

    if (updates.length > 50) {
      throw new ValidationError('Cannot update more than 50 friends at once');
    }

    const user = await User.findById(req.user.id);
    const results = {
      success: [],
      failed: [],
    };

    // Update each friend's category
    for (const update of updates) {
      const { friendId, category } = update;

      // Validate friendId
      if (!mongoose.Types.ObjectId.isValid(friendId)) {
        results.failed.push({ friendId, error: 'Invalid friend ID' });
        continue;
      }

      // Check if user is actually friends with this person
      if (!user.friends.some(id => id.equals(friendId))) {
        results.failed.push({ friendId, error: 'Not a friend' });
        continue;
      }

      // Update friend category in user's friendCategories map
      if (!user.friendCategories) {
        user.friendCategories = new Map();
      }

      if (category) {
        user.friendCategories.set(friendId.toString(), category);
      } else {
        user.friendCategories.delete(friendId.toString());
      }

      results.success.push(friendId);
    }

    await user.save();

    res.status(200).json({
      status: 'success',
      data: results,
    });
  })
);

/**
 * Get friendship statistics
 */
router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).populate('friends');

    const onlineCount = user.friends.filter(friend => friend.online).length;
    const recentActiveCount = user.friends.filter(friend => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      return friend.lastActive > sevenDaysAgo;
    }).length;

    // Get friend addition trend (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentFriends = await User.aggregate([
      {
        $match: {
          _id: user._id,
        },
      },
      {
        $unwind: '$friends',
      },
      {
        $lookup: {
          from: 'users',
          localField: 'friends',
          foreignField: '_id',
          as: 'friendData',
        },
      },
      {
        $unwind: '$friendData',
      },
      {
        $match: {
          'friendData.createdAt': { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$friendData.createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        total: user.friends.length,
        online: onlineCount,
        offline: user.friends.length - onlineCount,
        recentlyActive: recentActiveCount,
        newLast30Days: recentFriends.reduce((sum, day) => sum + day.count, 0),
        additionTrend: recentFriends,
      },
    });
  })
);

// Helper functions
const getFriendshipDate = (user, friendId) => {
  // This would typically come from a separate friendship model
  // For now, return a mock date or implement based on your schema
  return new Date(); // Placeholder
};

const getRecentInteractions = async (userId, friendId) => {
  // Placeholder for actual message/activity queries
  // This would query your messages/activities collection
  return {
    messageCount: 0,
    lastMessage: null,
    calls: [],
  };
};

const getSharedGroups = async (userId, friendId) => {
  // Placeholder for group queries
  // This would query your groups collection
  return [];
};

module.exports = router;
