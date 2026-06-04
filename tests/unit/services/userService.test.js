import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import userService from '../../../src/services/userService';
import User from '../../../src/models/User';
import redisClient from '../../../src/config/redis';
import mongoose from 'mongoose';

jest.mock('../../../src/models/User');
jest.mock('../../../src/config/redis');
jest.mock('bcrypt');

describe('User Service', () => {
  let mockUser;
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
      email: 'test@example.com',
      username: 'testuser',
      profile: {
        firstName: 'John',
        lastName: 'Doe',
        bio: 'Software Developer',
        avatar: 'avatar-url',
      },
      privacySettings: {
        profileVisibility: 'public',
        onlineStatus: true,
      },
      save: jest.fn().mockResolvedValue(true),
      toObject: jest.fn().mockReturnValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'test@example.com',
        username: 'testuser',
        profile: {
          firstName: 'John',
          lastName: 'Doe',
        },
      }),
    };

    mongoose.startSession.mockResolvedValue(mockSession);
  });

  describe('getUserProfile', () => {
    it('should get user profile successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const requesterId = '507f1f77bcf86cd799439012';

      User.findById.mockResolvedValue(mockUser);

      const result = await userService.getUserProfile(userId, requesterId);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
    });

    it('should return null if user not found', async () => {
      const userId = 'nonexistent';
      const requesterId = '507f1f77bcf86cd799439012';

      User.findById.mockResolvedValue(null);

      const result = await userService.getUserProfile(userId, requesterId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('User not found');
    });

    it('should handle private profile', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const requesterId = '507f1f77bcf86cd799439012';
      
      const privateUser = {
        ...mockUser,
        privacySettings: { profileVisibility: 'private' },
        friends: [],
      };

      User.findById.mockResolvedValue(privateUser);

      const result = await userService.getUserProfile(userId, requesterId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Profile is private');
    });
  });

  describe('updateProfile', () => {
    it('should update profile successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const updates = {
        profile: {
          firstName: 'Jane',
          lastName: 'Smith',
          bio: 'Updated bio',
        },
      };

      User.findById.mockResolvedValue(mockUser);
      User.findOne.mockResolvedValue(null); // For username/email uniqueness check

      const result = await userService.updateProfile(userId, updates);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if username already exists', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const updates = { username: 'existinguser' };

      User.findById.mockResolvedValue(mockUser);
      User.findOne.mockResolvedValue({ _id: 'differentId' });

      const result = await userService.updateProfile(userId, updates);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should handle update errors', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const updates = { profile: { firstName: 'Jane' } };

      User.findById.mockResolvedValue(mockUser);
      mockUser.save.mockRejectedValue(new Error('Database error'));

      await expect(userService.updateProfile(userId, updates)).rejects.toThrow('Database error');
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const passwordData = {
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      };

      User.findById.mockResolvedValue(mockUser);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(true);
      bcrypt.hash.mockResolvedValue('hashedNewPassword');
      redisClient.del.mockResolvedValue(1);

      const result = await userService.changePassword(userId, passwordData);

      expect(bcrypt.compare).toHaveBeenCalledWith(passwordData.currentPassword, mockUser.password);
      expect(bcrypt.hash).toHaveBeenCalledWith(passwordData.newPassword, 10);
      expect(redisClient.del).toHaveBeenCalledWith(`auth_${userId}`);
      expect(result.success).toBe(true);
    });

    it('should fail with incorrect current password', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const passwordData = {
        currentPassword: 'wrongPassword',
        newPassword: 'newPassword123',
      };

      User.findById.mockResolvedValue(mockUser);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(false);

      const result = await userService.changePassword(userId, passwordData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Current password is incorrect');
    });
  });

  describe('updatePrivacySettings', () => {
    it('should update privacy settings successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const settings = {
        profileVisibility: 'friends_only',
        onlineStatus: false,
        readReceipts: true,
      };

      User.findById.mockResolvedValue(mockUser);

      const result = await userService.updatePrivacySettings(userId, settings);

      expect(mockUser.privacySettings).toEqual(settings);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('searchUsers', () => {
    it('should search users successfully', async () => {
      const query = 'john';
      const page = 1;
      const limit = 10;
      
      const mockUsers = [mockUser, { ...mockUser, _id: '507f1f77bcf86cd799439012' }];
      
      User.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockUsers),
      });

      const result = await userService.searchUsers(query, page, limit);

      expect(User.find).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.users).toHaveLength(2);
    });

    it('should return empty array for no results', async () => {
      const query = 'nonexistent';
      
      User.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      const result = await userService.searchUsers(query);

      expect(result.success).toBe(true);
      expect(result.users).toHaveLength(0);
    });
  });

  describe('deleteAccount', () => {
    it('should delete account successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const password = 'correctPassword';

      User.findById.mockResolvedValue(mockUser);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(true);
      
      // Mock related models
      const Chat = require('../../../src/models/Chat');
      const Message = require('../../../src/models/Message');
      
      Chat.deleteMany.mockResolvedValue({ deletedCount: 5 });
      Message.deleteMany.mockResolvedValue({ deletedCount: 100 });

      const result = await userService.deleteAccount(userId, password);

      expect(bcrypt.compare).toHaveBeenCalled();
      expect(User.findByIdAndDelete).toHaveBeenCalledWith(userId);
      expect(result.success).toBe(true);
    });

    it('should handle delete account within transaction', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const password = 'correctPassword';

      User.findById.mockResolvedValue(mockUser);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(true);

      const result = await userService.deleteAccount(userId, password, true);

      expect(mockSession.startTransaction).toHaveBeenCalled();
      expect(mockSession.commitTransaction).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('updateStatus', () => {
    it('should update user status', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const status = 'away';
      const customStatus = 'In a meeting';

      User.findById.mockResolvedValue(mockUser);
      redisClient.set.mockResolvedValue('OK');

      const result = await userService.updateStatus(userId, status, customStatus);

      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.set).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });
});