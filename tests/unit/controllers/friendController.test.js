const friendController = require('../../../src/controllers/friendController');
const friendService = require('../../../src/services/friendService');
const { validationResult } = require('express-validator');

jest.mock('../../../src/services/friendService');
jest.mock('express-validator');

describe('Friend Controller', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      user: { id: '123' },
      params: {},
      body: {},
      query: {},
      io: {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn()
      }
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
    validationResult.mockReturnValue({
      isEmpty: jest.fn().mockReturnValue(true),
      array: jest.fn().mockReturnValue([])
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getFriends', () => {
    it('should get friends list successfully', async () => {
      const friends = [
        { id: '456', username: 'friend1', status: 'online' },
        { id: '789', username: 'friend2', status: 'offline' }
      ];

      req.query = { page: '1', limit: '20' };
      friendService.getFriendsList.mockResolvedValue({
        friends,
        total: 2,
        page: 1,
        limit: 20
      });

      await friendController.getFriends(req, res, next);

      expect(friendService.getFriendsList).toHaveBeenCalledWith('123', {
        page: 1,
        limit: 20
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          friends,
          pagination: {
            page: 1,
            limit: 20,
            total: 2,
            hasMore: false
          }
        }
      });
    });

    it('should handle service error', async () => {
      friendService.getFriendsList.mockRejectedValue(new Error('Database error'));

      await friendController.getFriends(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getFriendRequests', () => {
    it('should get friend requests successfully', async () => {
      const requests = [
        { id: 'req1', fromUser: { id: '456', username: 'user1' } },
        { id: 'req2', fromUser: { id: '789', username: 'user2' } }
      ];

      friendService.getFriendRequests.mockResolvedValue({
        requests,
        total: 2
      });

      await friendController.getFriendRequests(req, res, next);

      expect(friendService.getFriendRequests).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: requests
      });
    });
  });

  describe('sendFriendRequest', () => {
    it('should send friend request successfully', async () => {
      const mockRequest = {
        id: 'req123',
        fromUserId: '123',
        toUserId: '456',
        status: 'pending'
      };

      req.params = { userId: '456' };
      friendService.sendFriendRequest.mockResolvedValue(mockRequest);

      await friendController.sendFriendRequest(req, res, next);

      expect(friendService.sendFriendRequest).toHaveBeenCalledWith('123', '456');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('456');
        expect(req.io.emit).toHaveBeenCalledWith('friend_request', expect.any(Object));
      }
      
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockRequest,
        message: 'Friend request sent'
      });
    });

    it('should handle self-friend request', async () => {
      req.params = { userId: '123' }; // Same as req.user.id

      await friendController.sendFriendRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot send friend request to yourself'
      });
    });

    it('should handle duplicate request', async () => {
      const error = new Error('Friend request already exists');
      error.code = 'DUPLICATE_REQUEST';

      friendService.sendFriendRequest.mockRejectedValue(error);

      await friendController.sendFriendRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Friend request already exists',
        code: 'DUPLICATE_REQUEST'
      });
    });

    it('should handle user not found', async () => {
      const error = new Error('User not found');
      error.code = 'USER_NOT_FOUND';

      friendService.sendFriendRequest.mockRejectedValue(error);

      await friendController.sendFriendRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    });
  });

  describe('acceptFriendRequest', () => {
    it('should accept friend request successfully', async () => {
      const mockFriendship = {
        id: 'friendship123',
        user1Id: '123',
        user2Id: '456',
        status: 'accepted'
      };

      req.params = { requestId: 'req123' };
      friendService.acceptFriendRequest.mockResolvedValue(mockFriendship);

      await friendController.acceptFriendRequest(req, res, next);

      expect(friendService.acceptFriendRequest).toHaveBeenCalledWith('req123', '123');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('456');
        expect(req.io.emit).toHaveBeenCalledWith('friend_accepted', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockFriendship,
        message: 'Friend request accepted'
      });
    });

    it('should handle request not found', async () => {
      const error = new Error('Friend request not found');
      friendService.acceptFriendRequest.mockRejectedValue(error);

      await friendController.acceptFriendRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Friend request not found'
      });
    });

    it('should handle unauthorized acceptance', async () => {
      const error = new Error('Not authorized to accept this request');
      friendService.acceptFriendRequest.mockRejectedValue(error);

      await friendController.acceptFriendRequest(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('rejectFriendRequest', () => {
    it('should reject friend request successfully', async () => {
      const mockRequest = {
        id: 'req123',
        fromUserId: '456',
        toUserId: '123',
        status: 'rejected'
      };

      req.params = { requestId: 'req123' };
      friendService.rejectFriendRequest.mockResolvedValue(mockRequest);

      await friendController.rejectFriendRequest(req, res, next);

      expect(friendService.rejectFriendRequest).toHaveBeenCalledWith('req123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockRequest,
        message: 'Friend request rejected'
      });
    });
  });

  describe('cancelFriendRequest', () => {
    it('should cancel friend request successfully', async () => {
      req.params = { requestId: 'req123' };
      friendService.cancelFriendRequest.mockResolvedValue();

      await friendController.cancelFriendRequest(req, res, next);

      expect(friendService.cancelFriendRequest).toHaveBeenCalledWith('req123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Friend request cancelled'
      });
    });
  });

  describe('removeFriend', () => {
    it('should remove friend successfully', async () => {
      req.params = { userId: '456' };
      friendService.removeFriend.mockResolvedValue();

      await friendController.removeFriend(req, res, next);

      expect(friendService.removeFriend).toHaveBeenCalledWith('123', '456');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('456');
        expect(req.io.emit).toHaveBeenCalledWith('friend_removed', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Friend removed successfully'
      });
    });

    it('should handle non-friend removal', async () => {
      const error = new Error('Users are not friends');
      friendService.removeFriend.mockRejectedValue(error);

      await friendController.removeFriend(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Users are not friends'
      });
    });
  });

  describe('getFriendSuggestions', () => {
    it('should get friend suggestions successfully', async () => {
      const suggestions = [
        { id: '789', username: 'suggestion1', mutualFriends: 3 },
        { id: '012', username: 'suggestion2', mutualFriends: 2 }
      ];

      req.query = { limit: '10' };
      friendService.getFriendSuggestions.mockResolvedValue(suggestions);

      await friendController.getFriendSuggestions(req, res, next);

      expect(friendService.getFriendSuggestions).toHaveBeenCalledWith('123', { limit: 10 });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: suggestions
      });
    });
  });

  describe('getMutualFriends', () => {
    it('should get mutual friends successfully', async () => {
      const mutualFriends = [
        { id: '789', username: 'mutual1' },
        { id: '012', username: 'mutual2' }
      ];

      req.params = { userId: '456' };
      friendService.getMutualFriends.mockResolvedValue(mutualFriends);

      await friendController.getMutualFriends(req, res, next);

      expect(friendService.getMutualFriends).toHaveBeenCalledWith('123', '456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mutualFriends
      });
    });
  });

  describe('toggleFavorite', () => {
    it('should toggle favorite status successfully', async () => {
      const updatedFriend = {
        id: '456',
        username: 'friend1',
        isFavorite: true
      };

      req.params = { userId: '456' };
      req.body = { favorite: true };
      friendService.toggleFavorite.mockResolvedValue(updatedFriend);

      await friendController.toggleFavorite(req, res, next);

      expect(friendService.toggleFavorite).toHaveBeenCalledWith('123', '456', true);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedFriend,
        message: 'Friend marked as favorite'
      });
    });
  });

  describe('getBlockedUsers', () => {
    it('should get blocked users list', async () => {
      const blockedUsers = [
        { id: '456', username: 'blocked1' },
        { id: '789', username: 'blocked2' }
      ];

      friendService.getBlockedUsers.mockResolvedValue(blockedUsers);

      await friendController.getBlockedUsers(req, res, next);

      expect(friendService.getBlockedUsers).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: blockedUsers
      });
    });
  });

  describe('blockUser', () => {
    it('should block user successfully', async () => {
      req.params = { userId: '456' };
      req.body = { reason: 'Spam' };
      friendService.blockUser.mockResolvedValue();

      await friendController.blockUser(req, res, next);

      expect(friendService.blockUser).toHaveBeenCalledWith('123', '456', 'Spam');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'User blocked successfully'
      });
    });

    it('should handle self-block', async () => {
      req.params = { userId: '123' };

      await friendController.blockUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot block yourself'
      });
    });
  });

  describe('unblockUser', () => {
    it('should unblock user successfully', async () => {
      req.params = { userId: '456' };
      friendService.unblockUser.mockResolvedValue();

      await friendController.unblockUser(req, res, next);

      expect(friendService.unblockUser).toHaveBeenCalledWith('123', '456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'User unblocked successfully'
      });
    });
  });

  describe('getOnlineFriends', () => {
    it('should get online friends successfully', async () => {
      const onlineFriends = [
        { id: '456', username: 'friend1', status: 'online' },
        { id: '789', username: 'friend2', status: 'online' }
      ];

      friendService.getOnlineFriends.mockResolvedValue(onlineFriends);

      await friendController.getOnlineFriends(req, res, next);

      expect(friendService.getOnlineFriends).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: onlineFriends
      });
    });
  });

  describe('searchFriends', () => {
    it('should search friends successfully', async () => {
      const searchResults = [
        { id: '456', username: 'friend1' },
        { id: '789', username: 'friend2' }
      ];

      req.query = { query: 'friend', page: '1', limit: '10' };
      friendService.searchFriends.mockResolvedValue({
        results: searchResults,
        total: 2,
        page: 1,
        limit: 10
      });

      await friendController.searchFriends(req, res, next);

      expect(friendService.searchFriends).toHaveBeenCalledWith('123', 'friend', {
        page: 1,
        limit: 10
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          results: searchResults,
          pagination: {
            page: 1,
            limit: 10,
            total: 2,
            hasMore: false
          }
        }
      });
    });

    it('should handle empty search query', async () => {
      req.query = { query: '' };

      await friendController.searchFriends(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Search query is required'
      });
    });
  });
});