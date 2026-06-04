import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import syncService from '../../../src/services/syncService';
import User from '../../../src/models/User';
import Chat from '../../../src/models/Chat';
import Message from '../../../src/models/Message';
import redisClient from '../../../src/config/redis';
import mongoose from 'mongoose';

jest.mock('../../../src/models/User');
jest.mock('../../../src/models/Chat');
jest.mock('../../../src/models/Message');
jest.mock('../../../src/config/redis');

describe('Sync Service', () => {
  let mockUser;
  let mockChat;
  let mockMessage;
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
      lastSync: new Date('2024-01-01T00:00:00Z'),
      deviceTokens: ['device-token-1'],
      save: jest.fn().mockResolvedValue(true),
    };

    mockChat = {
      _id: '507f1f77bcf86cd799439021',
      participants: [{ user: '507f1f77bcf86cd799439011' }],
      updatedAt: new Date('2024-01-02T00:00:00Z'),
    };

    mockMessage = {
      _id: '507f1f77bcf86cd799439031',
      chat: '507f1f77bcf86cd799439021',
      sender: '507f1f77bcf86cd799439011',
      content: 'Hello',
      createdAt: new Date('2024-01-02T12:00:00Z'),
      updatedAt: new Date('2024-01-02T12:00:00Z'),
    };

    mongoose.startSession.mockResolvedValue(mockSession);
  });

  describe('syncUserData', () => {
    it('should sync user data successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const lastSync = new Date('2024-01-01T00:00:00Z');
      const deviceInfo = {
        deviceId: 'device-123',
        platform: 'ios',
        appVersion: '1.0.0',
      };

      User.findById.mockResolvedValue(mockUser);

      // Mock chat updates
      const updatedChats = [mockChat];
      Chat.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(updatedChats),
      });

      // Mock new messages
      const newMessages = [mockMessage];
      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(newMessages),
      });

      // Mock read receipts
      const readReceipts = [{ messageId: 'msg1', readAt: new Date() }];
      Message.find.mockReturnValueOnce({
        select: jest.fn().mockResolvedValue(readReceipts),
      });

      const result = await syncService.syncUserData(userId, lastSync, deviceInfo);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(Chat.find).toHaveBeenCalledWith({
        'participants.user': userId,
        updatedAt: { $gt: lastSync },
      });
      expect(Message.find).toHaveBeenCalledWith({
        chat: { $in: [mockChat._id] },
        createdAt: { $gt: lastSync },
        sender: { $ne: userId },
      });
      expect(mockUser.lastSync).toBeDefined();
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('chats');
      expect(result.data).toHaveProperty('messages');
      expect(result.data).toHaveProperty('readReceipts');
    });

    it('should handle initial sync', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const lastSync = null; // Initial sync
      const deviceInfo = { deviceId: 'device-123' };

      User.findById.mockResolvedValue(mockUser);

      // Mock all chats for initial sync
      const allChats = [mockChat, { ...mockChat, _id: 'chat2' }];
      Chat.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(allChats),
      });

      // Mock all messages for initial sync (limited)
      const recentMessages = [mockMessage];
      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(recentMessages),
      });

      const result = await syncService.syncUserData(userId, lastSync, deviceInfo);

      expect(Message.find).toHaveBeenCalledWith({
        chat: { $in: [mockChat._id, 'chat2'] },
      });
      expect(result.success).toBe(true);
      expect(result.data.initialSync).toBe(true);
    });

    it('should fail if user not found', async () => {
      const userId = 'nonexistent';
      const lastSync = new Date();

      User.findById.mockResolvedValue(null);

      const result = await syncService.syncUserData(userId, lastSync);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('registerDevice', () => {
    it('should register device successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const deviceToken = 'new-device-token';
      const deviceInfo = {
        deviceId: 'device-123',
        platform: 'android',
        appVersion: '1.0.0',
        pushToken: 'push-token-123',
      };

      User.findById.mockResolvedValue(mockUser);
      redisClient.set.mockResolvedValue('OK');

      const result = await syncService.registerDevice(userId, deviceToken, deviceInfo);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.deviceTokens).toContain(deviceToken);
      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.set).toHaveBeenCalledWith(
        `device:${deviceToken}`,
        JSON.stringify({ userId, ...deviceInfo })
      );
      expect(result.success).toBe(true);
    });

    it('should update existing device', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const deviceToken = 'existing-device-token';
      const deviceInfo = {
        deviceId: 'device-123',
        platform: 'ios',
        appVersion: '1.1.0',
      };

      mockUser.deviceTokens = [deviceToken];
      User.findById.mockResolvedValue(mockUser);

      const result = await syncService.registerDevice(userId, deviceToken, deviceInfo);

      expect(mockUser.deviceTokens).toHaveLength(1); // Should not duplicate
      expect(result.success).toBe(true);
    });

    it('should limit number of devices', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const deviceToken = 'new-device-token';
      const deviceInfo = { deviceId: 'device-123' };

      // User already has 10 devices (max)
      mockUser.deviceTokens = Array(10).fill('device-token');
      User.findById.mockResolvedValue(mockUser);

      const result = await syncService.registerDevice(userId, deviceToken, deviceInfo);

      expect(mockUser.deviceTokens).toHaveLength(10); // Should not exceed limit
      expect(result.success).toBe(true);
    });
  });

  describe('unregisterDevice', () => {
    it('should unregister device successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const deviceToken = 'device-token-1';

      User.findById.mockResolvedValue(mockUser);
      redisClient.del.mockResolvedValue(1);

      const result = await syncService.unregisterDevice(userId, deviceToken);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.deviceTokens).not.toContain(deviceToken);
      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.del).toHaveBeenCalledWith(`device:${deviceToken}`);
      expect(result.success).toBe(true);
    });

    it('should handle device not found', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const deviceToken = 'nonexistent-token';

      User.findById.mockResolvedValue(mockUser);

      const result = await syncService.unregisterDevice(userId, deviceToken);

      expect(result.success).toBe(true); // Should succeed even if token not found
    });
  });

  describe('getUserDevices', () => {
    it('should get user devices', async () => {
      const userId = '507f1f77bcf86cd799439011';

      mockUser.deviceTokens = ['token1', 'token2'];
      User.findById.mockResolvedValue(mockUser);

      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({ deviceId: 'device1', platform: 'ios' }))
        .mockResolvedValueOnce(JSON.stringify({ deviceId: 'device2', platform: 'android' }));

      const result = await syncService.getUserDevices(userId);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(redisClient.get).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.devices).toHaveLength(2);
    });

    it('should filter invalid device tokens', async () => {
      const userId = '507f1f77bcf86cd799439011';

      mockUser.deviceTokens = ['valid-token', 'invalid-token'];
      User.findById.mockResolvedValue(mockUser);

      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({ deviceId: 'device1' }))
        .mockResolvedValueOnce(null); // Invalid token

      const result = await syncService.getUserDevices(userId);

      expect(result.success).toBe(true);
      expect(result.devices).toHaveLength(1);
    });
  });

  describe('syncReadReceipts', () => {
    it('should sync read receipts', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const receipts = [
        { messageId: 'msg1', chatId: 'chat1', readAt: new Date() },
        { messageId: 'msg2', chatId: 'chat1', readAt: new Date() },
      ];

      Message.updateMany.mockResolvedValue({ modifiedCount: 2 });

      const result = await syncService.syncReadReceipts(userId, receipts);

      expect(Message.updateMany).toHaveBeenCalledWith(
        {
          _id: { $in: ['msg1', 'msg2'] },
          chat: { $in: ['chat1'] },
          sender: { $ne: userId },
          status: { $in: ['sent', 'delivered'] },
        },
        {
          $set: {
            status: 'read',
            readAt: expect.any(Date),
          },
        }
      );
      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(2);
    });

    it('should validate receipt data', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const receipts = [
        { messageId: 'msg1' }, // Missing required fields
      ];

      const result = await syncService.syncReadReceipts(userId, receipts);

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid');
    });
  });

  describe('syncMessageStatus', () => {
    it('should sync message delivery status', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const statusUpdates = [
        { messageId: 'msg1', status: 'delivered' },
        { messageId: 'msg2', status: 'read' },
      ];

      Message.updateMany.mockResolvedValue({ modifiedCount: 2 });

      const result = await syncService.syncMessageStatus(userId, statusUpdates);

      expect(Message.updateMany).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('syncUserProfile', () => {
    it('should sync user profile changes', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const profileUpdates = {
        username: 'newusername',
        profile: { bio: 'Updated bio' },
      };

      User.findById.mockResolvedValue(mockUser);
      redisClient.publish.mockResolvedValue(1);

      const result = await syncService.syncUserProfile(userId, profileUpdates);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.username).toBe('newusername');
      expect(mockUser.profile.bio).toBe('Updated bio');
      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('resolveSyncConflicts', () => {
    it('should resolve sync conflicts using last-write-wins', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const conflicts = [
        {
          entityType: 'message',
          entityId: 'msg1',
          localVersion: { content: 'Local edit', updatedAt: new Date('2024-01-01T10:00:00Z') },
          serverVersion: { content: 'Server edit', updatedAt: new Date('2024-01-01T11:00:00Z') },
        },
      ];

      Message.findById.mockResolvedValue({
        ...mockMessage,
        save: jest.fn().mockResolvedValue(true),
      });

      const result = await syncService.resolveSyncConflicts(userId, conflicts);

      expect(Message.findById).toHaveBeenCalledWith('msg1');
      expect(result.success).toBe(true);
      expect(result.resolved).toHaveLength(1);
    });

    it('should handle merge conflicts for chat data', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const conflicts = [
        {
          entityType: 'chat',
          entityId: 'chat1',
          localVersion: { name: 'Local name', updatedAt: new Date('2024-01-01T10:00:00Z') },
          serverVersion: { name: 'Server name', updatedAt: new Date('2024-01-01T09:00:00Z') },
        },
      ];

      Chat.findById.mockResolvedValue({
        ...mockChat,
        save: jest.fn().mockResolvedValue(true),
      });

      const result = await syncService.resolveSyncConflicts(userId, conflicts);

      expect(Chat.findById).toHaveBeenCalledWith('chat1');
      expect(result.success).toBe(true);
    });
  });

  describe('getSyncStatus', () => {
    it('should get sync status', async () => {
      const userId = '507f1f77bcf86cd799439011';

      User.findById.mockResolvedValue(mockUser);
      Chat.countDocuments.mockResolvedValue(5);
      Message.countDocuments.mockResolvedValue(100);

      const result = await syncService.getSyncStatus(userId);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(Chat.countDocuments).toHaveBeenCalledWith({
        'participants.user': userId,
      });
      expect(result.success).toBe(true);
      expect(result.status).toHaveProperty('lastSync');
      expect(result.status).toHaveProperty('chatCount');
      expect(result.status).toHaveProperty('messageCount');
    });
  });

  describe('cleanupOldSyncData', () => {
    it('should cleanup old sync data', async () => {
      const daysThreshold = 30;

      Message.deleteMany.mockResolvedValue({ deletedCount: 1000 });
      redisClient.keys.mockResolvedValue(['sync:oldkey1', 'sync:oldkey2']);
      redisClient.del.mockResolvedValue(2);

      const result = await syncService.cleanupOldSyncData(daysThreshold);

      expect(Message.deleteMany).toHaveBeenCalledWith({
        deleted: true,
        deletedAt: { $lt: expect.any(Date) },
      });
      expect(redisClient.keys).toHaveBeenCalledWith('sync:*');
      expect(result.success).toBe(true);
      expect(result.deletedMessages).toBe(1000);
      expect(result.deletedRedisKeys).toBe(2);
    });
  });

  describe('forceSync', () => {
    it('should force sync for user', async () => {
      const userId = '507f1f77bcf86cd799439011';

      User.findById.mockResolvedValue(mockUser);
      redisClient.publish.mockResolvedValue(1);

      const result = await syncService.forceSync(userId);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(redisClient.publish).toHaveBeenCalledWith(
        `sync:${userId}`,
        JSON.stringify({ type: 'force_sync', timestamp: expect.any(Date) })
      );
      expect(result.success).toBe(true);
    });
  });
});