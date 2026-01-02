import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import friendService from '../../../src/services/friendService';
import User from '../../../src/models/User';
import FriendRequest from '../../../src/models/FriendRequest';
import Notification from '../../../src/models/Notification';
import redisClient from '../../../src/config/redis';
import mongoose from 'mongoose';

jest.mock('../../../src/models/User');
jest.mock('../../../src/models/FriendRequest');
jest.mock('../../../src/models/Notification');
jest.mock('../../../src/config/redis');

describe('Friend Service', () => {
  let mockUser;
  let mockFriend;
  let mockFriendRequest;
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
      friends: ['507f1f77bcf86cd799439012'],
      friendRequests: [],
      save: jest.fn().mockResolvedValue(true),
    };

    mockFriend = {
      _id: '507f1f77bcf86cd799439012',
      username: 'user2',
      friends: ['507f1f77bcf86cd799439011'],
      friendRequests: [],
      save: jest.fn().mockResolvedValue(true),
    };

    mockFriendRequest = {
      _id: '507f1f77bcf86cd799439013',
      from: '507f1f77bcf86cd799439011',
      to: '507f1f77bcf86cd799439012',
      status: 'pending',
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };

    mongoose.startSession.mockResolvedValue(mockSession);
  });

  describe('sendFriendRequest', () => {
    it('should send friend request successfully', async () => {
      const fromUserId = '507f1f77bcf86cd799439011';
      const toUserId = '507f1f77bcf86cd799439012';

      User.findById.mockImplementation((id) => {
        if (id === fromUserId) return Promise.resolve(mockUser);
        if (id === toUserId) return Promise.resolve(mockFriend);
      });

      FriendRequest.findOne.mockResolvedValue(null);
      FriendRequest.create.mockResolvedValue(mockFriendRequest);
      Notification.create.mockResolvedValue({});

      const result = await friendService.sendFriendRequest(fromUserId, toUserId);

      expect(User.findById).toHaveBeenCalledTimes(2);
      expect(FriendRequest.findOne).toHaveBeenCalledWith({
        $or: [
          { from: fromUserId, to: toUserId },
          { from: toUserId, to: fromUserId },
        ],
      });
      expect(FriendRequest.create).toHaveBeenCalled();
      expect(Notification.create).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if users are already friends', async () => {
      const fromUserId = '507f1f77bcf86cd799439011';
      const toUserId = '507f1f77bcf86cd799439012';

      mockUser.friends.push(toUserId);

      User.findById.mockImplementation((id) => {
        if (id === fromUserId) return Promise.resolve(mockUser);
        if (id === toUserId) return Promise.resolve(mockFriend);
      });

      const result = await friendService.sendFriendRequest(fromUserId, toUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already friends');
    });

    it('should fail if request already exists', async () => {
      const fromUserId = '507f1f77bcf86cd799439011';
      const toUserId = '507f1f77bcf86cd799439012';

      User.findById.mockImplementation((id) => {
        if (id === fromUserId) return Promise.resolve(mockUser);
        if (id === toUserId) return Promise.resolve(mockFriend);
      });

      FriendRequest.findOne.mockResolvedValue(mockFriendRequest);

      const result = await friendService.sendFriendRequest(fromUserId, toUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('acceptFriendRequest', () => {
    it('should accept friend request successfully', async () => {
      const requestId = '507f1f77bcf86cd799439013';
      const userId = '507f1f77bcf86cd799439012';

      FriendRequest.findById.mockResolvedValue(mockFriendRequest);
      User.findById.mockImplementation((id) => {
        if (id === mockFriendRequest.from) return Promise.resolve(mockUser);
        if (id === mockFriendRequest.to) return Promise.resolve(mockFriend);
      });

      const result = await friendService.acceptFriendRequest(requestId, userId);

      expect(FriendRequest.findById).toHaveBeenCalledWith(requestId);
      expect(mockFriendRequest.status).toBe('accepted');
      expect(mockFriendRequest.save).toHaveBeenCalled();
      expect(mockUser.friends).toContain(mockFriend._id);
      expect(mockFriend.friends).toContain(mockUser._id);
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockFriend.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if request not found', async () => {
      const requestId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439012';

      FriendRequest.findById.mockResolvedValue(null);

      const result = await friendService.acceptFriendRequest(requestId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail if user not authorized', async () => {
      const requestId = '507f1f77bcf86cd799439013';
      const userId = 'unauthorizedUserId';

      FriendRequest.findById.mockResolvedValue(mockFriendRequest);

      const result = await friendService.acceptFriendRequest(requestId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorized');
    });
  });

  describe('rejectFriendRequest', () => {
    it('should reject friend request successfully', async () => {
      const requestId = '507f1f77bcf86cd799439013';
      const userId = '507f1f77bcf86cd799439012';

      FriendRequest.findById.mockResolvedValue(mockFriendRequest);

      const result = await friendService.rejectFriendRequest(requestId, userId);

      expect(mockFriendRequest.status).toBe('rejected');
      expect(mockFriendRequest.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should handle rejection within transaction', async () => {
      const requestId = '507f1f77bcf86cd799439013';
      const userId = '507f1f77bcf86cd799439012';

      FriendRequest.findById.mockResolvedValue(mockFriendRequest);

      const result = await friendService.rejectFriendRequest(requestId, userId, true);

      expect(mockSession.startTransaction).toHaveBeenCalled();
      expect(mockSession.commitTransaction).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('cancelFriendRequest', () => {
    it('should cancel friend request successfully', async () => {
      const requestId = '507f1f77bcf86cd799439013';
      const userId = '507f1f77bcf86cd799439011';

      FriendRequest.findById.mockResolvedValue(mockFriendRequest);
      FriendRequest.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await friendService.cancelFriendRequest(requestId, userId);

      expect(FriendRequest.deleteOne).toHaveBeenCalledWith({ _id: requestId });
      expect(result.success).toBe(true);
    });
  });

  describe('removeFriend', () => {
    it('should remove friend successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const friendId = '507f1f77bcf86cd799439012';

      User.findById.mockImplementation((id) => {
        if (id === userId) return Promise.resolve(mockUser);
        if (id === friendId) return Promise.resolve(mockFriend);
      });

      const result = await friendService.removeFriend(userId, friendId);

      expect(mockUser.friends).not.toContain(friendId);
      expect(mockFriend.friends).not.toContain(userId);
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockFriend.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if users are not friends', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const friendId = 'notAFriendId';

      mockUser.friends = [];

      User.findById.mockImplementation((id) => {
        if (id === userId) return Promise.resolve(mockUser);
        if (id === friendId) return Promise.resolve(mockFriend);
      });

      const result = await friendService.removeFriend(userId, friendId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not friends');
    });
  });

  describe('getFriendRequests', () => {
    it('should get pending friend requests', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const mockRequests = [mockFriendRequest];

      FriendRequest.find.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockRequests),
      });

      const result = await friendService.getFriendRequests(userId);

      expect(FriendRequest.find).toHaveBeenCalledWith({
        to: userId,
        status: 'pending',
      });
      expect(result.success).toBe(true);
      expect(result.requests).toHaveLength(1);
    });

    it('should filter by type (sent/received)', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const type = 'sent';

      FriendRequest.find.mockReturnValue({
        populate: jest.fn().mockResolvedValue([]),
      });

      await friendService.getFriendRequests(userId, type);

      expect(FriendRequest.find).toHaveBeenCalledWith({
        from: userId,
        status: 'pending',
      });
    });
  });

  describe('getFriends', () => {
    it('should get user friends with pagination', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const page = 1;
      const limit = 10;

      User.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockResolvedValue(mockUser),
      });

      const result = await friendService.getFriends(userId, page, limit);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(result.success).toBe(true);
    });

    it('should search friends by query', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const query = 'john';

      User.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnValue({
          friends: {
            filter: jest.fn().mockReturnValue([]),
          },
        }),
      });

      const result = await friendService.getFriends(userId, 1, 10, query);

      expect(result.success).toBe(true);
    });
  });

  describe('blockUser', () => {
    it('should block user successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const targetId = '507f1f77bcf86cd799439013';

      User.findById.mockImplementation((id) => {
        if (id === userId) return Promise.resolve(mockUser);
        if (id === targetId) return Promise.resolve(mockFriend);
      });

      const result = await friendService.blockUser(userId, targetId);

      expect(mockUser.blockedUsers).toContain(targetId);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should remove friend when blocking', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const targetId = '507f1f77bcf86cd799439012';

      mockUser.friends = [targetId];
      mockFriend.friends = [userId];

      User.findById.mockImplementation((id) => {
        if (id === userId) return Promise.resolve(mockUser);
        if (id === targetId) return Promise.resolve(mockFriend);
      });

      const result = await friendService.blockUser(userId, targetId);

      expect(mockUser.friends).not.toContain(targetId);
      expect(mockFriend.friends).not.toContain(userId);
      expect(result.success).toBe(true);
    });
  });

  describe('unblockUser', () => {
    it('should unblock user successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const targetId = '507f1f77bcf86cd799439013';

      mockUser.blockedUsers = [targetId];

      User.findById.mockResolvedValue(mockUser);

      const result = await friendService.unblockUser(userId, targetId);

      expect(mockUser.blockedUsers).not.toContain(targetId);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });
});