const friendService = require('../services/friendService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// Resolve Socket.IO without hard-coupling to server.js.
// Works when the app sets `global.io = io` in server.js.
function getIO() {
    if (global.io) return global.io;
    try { return require('../socket').io || require('../realtime').io || null; } catch (_) { return null; }
}

class FriendController {
  async sendFriendRequest(req, res, next) {
    try {
      const userId = req.user.id;
      const { receiverId, notes } = req.body;

      if (userId === receiverId) {
        throw new AppError('Cannot send friend request to yourself', 400);
      }

      const friendRequest = await friendService.sendFriendRequest(userId, receiverId, notes);

      res.status(201).json({
        success: true,
        message: 'Friend request sent successfully',
        data: {
          friendRequest: friendRequest
        }
      });

      // Emit real-time notification to the receiver AFTER responding (non-blocking)
      try {
        const io = getIO();
        if (io) {
          io.to(`user:${receiverId}`).emit('friend:request', {
            id:             friendRequest.id,
            requesterId:    userId,
            receiverId:     receiverId,
            status:         'pending',
            createdAt:      friendRequest.createdAt,
            senderName:     req.user.displayName || req.user.username || '',
            senderUsername: req.user.username    || '',
            senderAvatar:   req.user.avatar      || null,
            user: {
              id:          req.user.id,
              username:    req.user.username    || '',
              displayName: req.user.displayName || req.user.username || '',
              avatar:      req.user.avatar      || null,
            },
          });
        }
      } catch (emitErr) {
        logger.warn('sendFriendRequest: realtime emit failed (non-fatal):', emitErr.message);
      }
    } catch (error) {
      logger.error('Send friend request controller error:', error);
      next(error);
    }
  }

  async respondToFriendRequest(req, res, next) {
    try {
      const userId = req.user.id;
      const { requestId, action } = req.body;

      const friendRequest = await friendService.respondToFriendRequest(requestId, userId, action);

      res.json({
        success: true,
        message: `Friend request ${action}ed successfully`,
        data: {
          friendRequest: friendRequest
        }
      });

      // Emit real-time notification AFTER responding (non-blocking)
      try {
        const io = getIO();
        if (io) {
          const originalRequesterId = friendRequest.requesterId;
          if (action === 'accept') {
            const accepterInfo = {
              id:          req.user.id,
              username:    req.user.username    || '',
              displayName: req.user.displayName || req.user.username || '',
              avatar:      req.user.avatar      || null,
            };
            // Notify the original sender — their request was accepted
            io.to(`user:${originalRequesterId}`).emit('friend:accepted', {
              requestId:  requestId,
              friendId:   userId,
              user:       accepterInfo,
              acceptedAt: new Date().toISOString(),
            });
            // Notify the accepter too (multi-tab sync)
            io.to(`user:${userId}`).emit('friend:accepted', {
              requestId:  requestId,
              friendId:   originalRequesterId,
              acceptedAt: new Date().toISOString(),
            });
          } else if (action === 'reject') {
            io.to(`user:${originalRequesterId}`).emit('friend:rejected', {
              requestId: requestId,
              friendId:  userId,
            });
          }
        }
      } catch (emitErr) {
        logger.warn('respondToFriendRequest: realtime emit failed (non-fatal):', emitErr.message);
      }
    } catch (error) {
      logger.error('Respond to friend request controller error:', error);
      next(error);
    }
  }

  async getFriends(req, res, next) {
    try {
      const userId = req.user.id;
      const { status = 'accepted' } = req.query;

      const friends = await friendService.getFriends(userId, status);

      res.json({
        success: true,
        data: {
          friends: friends,
          count: friends.length
        }
      });
    } catch (error) {
      logger.error('Get friends controller error:', error);
      next(error);
    }
  }

  async getPendingRequests(req, res, next) {
    try {
      const userId = req.user.id;

      const requests = await friendService.getPendingRequests(userId);

      res.json({
        success: true,
        data: {
          requests: requests,
          count: requests.length
        }
      });
    } catch (error) {
      logger.error('Get pending requests controller error:', error);
      next(error);
    }
  }

  async getSentRequests(req, res, next) {
    try {
      const userId = req.user.id;

      const requests = await friendService.getSentRequests(userId);

      res.json({
        success: true,
        data: {
          requests: requests,
          count: requests.length
        }
      });
    } catch (error) {
      logger.error('Get sent requests controller error:', error);
      next(error);
    }
  }

  async getBlockedUsers(req, res, next) {
    try {
      const userId = req.user.id;

      const blockedUsers = await friendService.getBlockedUsers(userId);

      res.json({
        success: true,
        data: {
          blockedUsers: blockedUsers,
          count: blockedUsers.length
        }
      });
    } catch (error) {
      logger.error('Get blocked users controller error:', error);
      next(error);
    }
  }

  async unfriend(req, res, next) {
    try {
      const userId = req.user.id;
      const { friendId } = req.params;

      await friendService.unfriend(userId, parseInt(friendId));

      res.json({
        success: true,
        message: 'Friend removed successfully'
      });
    } catch (error) {
      logger.error('Unfriend controller error:', error);
      next(error);
    }
  }

  async blockUser(req, res, next) {
    try {
      const userId = req.user.id;
      const { targetId } = req.params;

      if (userId === parseInt(targetId)) {
        throw new AppError('Cannot block yourself', 400);
      }

      await friendService.blockUser(userId, parseInt(targetId));

      res.json({
        success: true,
        message: 'User blocked successfully'
      });
    } catch (error) {
      logger.error('Block user controller error:', error);
      next(error);
    }
  }

  async unblockUser(req, res, next) {
    try {
      const userId = req.user.id;
      const { targetId } = req.params;

      await friendService.unblockUser(userId, parseInt(targetId));

      res.json({
        success: true,
        message: 'User unblocked successfully'
      });
    } catch (error) {
      logger.error('Unblock user controller error:', error);
      next(error);
    }
  }

  async checkFriendship(req, res, next) {
    try {
      const userId = req.user.id;
      const { targetId } = req.params;

      const areFriends = await friendService.areFriends(userId, parseInt(targetId));
      const isBlocked = await friendService.isBlocked(userId, parseInt(targetId));

      res.json({
        success: true,
        data: {
          areFriends: areFriends,
          isBlocked: isBlocked
        }
      });
    } catch (error) {
      logger.error('Check friendship controller error:', error);
      next(error);
    }
  }

  async getFriendsCount(req, res, next) {
    try {
      const userId = req.user.id;

      const count = await friendService.getFriendsCount(userId);

      res.json({
        success: true,
        data: {
          count: count
        }
      });
    } catch (error) {
      logger.error('Get friends count controller error:', error);
      next(error);
    }
  }

  async getMutualFriends(req, res, next) {
    try {
      const userId = req.user.id;
      const { targetId } = req.params;

      const mutualFriends = await friendService.getMutualFriends(userId, parseInt(targetId));

      res.json({
        success: true,
        data: {
          mutualFriends: mutualFriends,
          count: mutualFriends.length
        }
      });
    } catch (error) {
      logger.error('Get mutual friends controller error:', error);
      next(error);
    }
  }

  /**
   * Get nearby users based on geolocation or fallback to online users
   * GET /api/friends/nearby?lat=xxx&lng=xxx&radius=5000
   */
  async getNearbyUsers(req, res, next) {
    try {
      const userId = req.user.id;
      const { lat, lng, radius = 5000 } = req.query;

      const result = await friendService.getNearbyUsers(userId, { lat, lng, radius });

      res.json({
        success: true,
        data: {
          users: result.users,
          count: result.count,
          mode: result.mode
        }
      });
    } catch (error) {
      logger.error('Get nearby users controller error:', error);
      next(error);
    }
  }
}

module.exports = new FriendController();