const friendService = require('../services/friendService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

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
          friendRequest,
        },
      });
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
          friendRequest,
        },
      });
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
          friends,
          count: friends.length,
        },
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
          requests,
          count: requests.length,
        },
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
          requests,
          count: requests.length,
        },
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
          blockedUsers,
          count: blockedUsers.length,
        },
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
        message: 'Friend removed successfully',
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
        message: 'User blocked successfully',
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
        message: 'User unblocked successfully',
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
          areFriends,
          isBlocked,
        },
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
          count,
        },
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
          mutualFriends,
          count: mutualFriends.length,
        },
      });
    } catch (error) {
      logger.error('Get mutual friends controller error:', error);
      next(error);
    }
  }
}

module.exports = new FriendController();
