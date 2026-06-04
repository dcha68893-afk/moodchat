import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import notificationService from '../../../src/services/notificationService';
import Notification from '../../../src/models/Notification';
import User from '../../../src/models/User';
import redisClient from '../../../src/config/redis';
import webSocketService from '../../../src/services/webSocketService';

jest.mock('../../../src/models/Notification');
jest.mock('../../../src/models/User');
jest.mock('../../../src/config/redis');
jest.mock('../../../src/services/webSocketService');

describe('Notification Service', () => {
  let mockNotification;
  let mockUser;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
      notificationSettings: {
        pushEnabled: true,
        emailEnabled: true,
        soundEnabled: true,
        mentions: true,
        friendRequests: true,
        messages: true,
      },
      save: jest.fn().mockResolvedValue(true),
    };

    mockNotification = {
      _id: '507f1f77bcf86cd799439071',
      user: '507f1f77bcf86cd799439011',
      type: 'message',
      title: 'New Message',
      body: 'You have a new message',
      data: { chatId: '507f1f77bcf86cd799439021' },
      read: false,
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue({
        ...mockNotification,
        user: mockUser,
      }),
    };
  });

  describe('createNotification', () => {
    it('should create notification successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const notificationData = {
        type: 'friend_request',
        title: 'Friend Request',
        body: 'You have a new friend request',
        data: { requestId: '507f1f77bcf86cd799439013' },
      };

      User.findById.mockResolvedValue(mockUser);
      Notification.create.mockResolvedValue(mockNotification);
      webSocketService.sendNotification.mockResolvedValue(true);
      redisClient.publish.mockResolvedValue(1);

      const result = await notificationService.createNotification(userId, notificationData);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(Notification.create).toHaveBeenCalledWith({
        user: userId,
        ...notificationData,
      });
      expect(webSocketService.sendNotification).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.notification).toBeDefined();
    });

    it('should respect user notification preferences', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const notificationData = {
        type: 'message',
        title: 'New Message',
        body: 'You have a new message',
      };

      const userWithDisabled = {
        ...mockUser,
        notificationSettings: { ...mockUser.notificationSettings, messages: false },
      };

      User.findById.mockResolvedValue(userWithDisabled);
      Notification.create.mockResolvedValue(mockNotification);

      const result = await notificationService.createNotification(userId, notificationData);

      expect(result.success).toBe(true);
      expect(webSocketService.sendNotification).not.toHaveBeenCalled();
    });

    it('should fail if user not found', async () => {
      const userId = 'nonexistent';
      const notificationData = {
        type: 'message',
        title: 'New Message',
        body: 'Test',
      };

      User.findById.mockResolvedValue(null);

      const result = await notificationService.createNotification(userId, notificationData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('getUserNotifications', () => {
    it('should get user notifications with pagination', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const page = 1;
      const limit = 10;
      const unreadOnly = false;

      const mockNotifications = [
        mockNotification,
        { ...mockNotification, _id: '507f1f77bcf86cd799439072' },
      ];

      Notification.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockNotifications),
      });

      Notification.countDocuments.mockResolvedValue(2);

      const result = await notificationService.getUserNotifications(userId, page, limit, unreadOnly);

      expect(Notification.find).toHaveBeenCalledWith({ user: userId });
      expect(result.success).toBe(true);
      expect(result.notifications).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
    });

    it('should filter unread notifications', async () => {
      const userId = '507f1f77bcf86cd799439011';

      Notification.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await notificationService.getUserNotifications(userId, 1, 10, true);

      expect(Notification.find).toHaveBeenCalledWith({
        user: userId,
        read: false,
      });
    });

    it('should filter by type', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const type = 'friend_request';

      Notification.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await notificationService.getUserNotifications(userId, 1, 10, false, type);

      expect(Notification.find).toHaveBeenCalledWith({
        user: userId,
        type,
      });
    });
  });

  describe('markAsRead', () => {
    it('should mark notification as read', async () => {
      const notificationId = '507f1f77bcf86cd799439071';
      const userId = '507f1f77bcf86cd799439011';

      Notification.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockNotification),
      });

      const result = await notificationService.markAsRead(notificationId, userId);

      expect(Notification.findById).toHaveBeenCalledWith(notificationId);
      expect(mockNotification.read).toBe(true);
      expect(mockNotification.readAt).toBeDefined();
      expect(mockNotification.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should mark all notifications as read', async () => {
      const userId = '507f1f77bcf86cd799439011';

      Notification.updateMany.mockResolvedValue({ modifiedCount: 5 });

      const result = await notificationService.markAsRead(null, userId);

      expect(Notification.updateMany).toHaveBeenCalledWith(
        { user: userId, read: false },
        { $set: { read: true, readAt: expect.any(Date) } }
      );
      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(5);
    });

    it('should fail if notification not found', async () => {
      const notificationId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';

      Notification.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await notificationService.markAsRead(notificationId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('deleteNotification', () => {
    it('should delete notification', async () => {
      const notificationId = '507f1f77bcf86cd799439071';
      const userId = '507f1f77bcf86cd799439011';

      Notification.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockNotification),
      });

      const result = await notificationService.deleteNotification(notificationId, userId);

      expect(Notification.findByIdAndDelete).toHaveBeenCalledWith(notificationId);
      expect(result.success).toBe(true);
    });

    it('should delete all read notifications', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const olderThan = new Date();

      Notification.deleteMany.mockResolvedValue({ deletedCount: 10 });

      const result = await notificationService.deleteNotification(null, userId, olderThan);

      expect(Notification.deleteMany).toHaveBeenCalledWith({
        user: userId,
        read: true,
        createdAt: { $lt: olderThan },
      });
      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(10);
    });
  });

  describe('getUnreadCount', () => {
    it('should get unread notification count', async () => {
      const userId = '507f1f77bcf86cd799439011';

      Notification.countDocuments.mockResolvedValue(5);

      const result = await notificationService.getUnreadCount(userId);

      expect(Notification.countDocuments).toHaveBeenCalledWith({
        user: userId,
        read: false,
      });
      expect(result.success).toBe(true);
      expect(result.count).toBe(5);
    });
  });

  describe('updateNotificationSettings', () => {
    it('should update notification settings', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const settings = {
        pushEnabled: false,
        emailEnabled: true,
        mentions: false,
      };

      User.findById.mockResolvedValue(mockUser);

      const result = await notificationService.updateNotificationSettings(userId, settings);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.notificationSettings.pushEnabled).toBe(false);
      expect(mockUser.notificationSettings.mentions).toBe(false);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('batchCreateNotifications', () => {
    it('should create notifications for multiple users', async () => {
      const userIds = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];
      const notificationData = {
        type: 'system',
        title: 'System Update',
        body: 'New features available',
      };

      User.find.mockResolvedValue([mockUser, { ...mockUser, _id: '507f1f77bcf86cd799439012' }]);
      Notification.insertMany.mockResolvedValue([mockNotification]);

      const result = await notificationService.batchCreateNotifications(userIds, notificationData);

      expect(User.find).toHaveBeenCalledWith({ _id: { $in: userIds } });
      expect(Notification.insertMany).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.createdCount).toBe(1);
    });
  });

  describe('processNotificationQueue', () => {
    it('should process notification queue', async () => {
      const queueItem = {
        userId: '507f1f77bcf86cd799439011',
        type: 'reminder',
        title: 'Reminder',
        body: 'Don\'t forget!',
        data: {},
      };

      redisClient.lpop.mockResolvedValue(JSON.stringify(queueItem));
      User.findById.mockResolvedValue(mockUser);
      Notification.create.mockResolvedValue(mockNotification);

      const result = await notificationService.processNotificationQueue();

      expect(redisClient.lpop).toHaveBeenCalled();
      expect(User.findById).toHaveBeenCalledWith(queueItem.userId);
      expect(Notification.create).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.processedCount).toBe(1);
    });

    it('should handle empty queue', async () => {
      redisClient.lpop.mockResolvedValue(null);

      const result = await notificationService.processNotificationQueue();

      expect(result.success).toBe(true);
      expect(result.processedCount).toBe(0);
    });
  });

  describe('scheduleNotification', () => {
    it('should schedule notification for future', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const notificationData = {
        type: 'reminder',
        title: 'Meeting Reminder',
        body: 'Meeting in 1 hour',
      };
      const scheduleTime = new Date(Date.now() + 3600000); // 1 hour from now

      redisClient.zadd.mockResolvedValue(1);

      const result = await notificationService.scheduleNotification(
        userId,
        notificationData,
        scheduleTime
      );

      expect(redisClient.zadd).toHaveBeenCalledWith(
        'scheduled_notifications',
        scheduleTime.getTime(),
        expect.any(String)
      );
      expect(result.success).toBe(true);
    });
  });

  describe('processScheduledNotifications', () => {
    it('should process scheduled notifications', async () => {
      const now = Date.now();
      const scheduledItem = JSON.stringify({
        userId: '507f1f77bcf86cd799439011',
        notification: {
          type: 'reminder',
          title: 'Scheduled',
          body: 'Time is up!',
        },
      });

      redisClient.zrangebyscore.mockResolvedValue([scheduledItem]);
      redisClient.zrem.mockResolvedValue(1);
      User.findById.mockResolvedValue(mockUser);
      Notification.create.mockResolvedValue(mockNotification);

      const result = await notificationService.processScheduledNotifications();

      expect(redisClient.zrangebyscore).toHaveBeenCalledWith(
        'scheduled_notifications',
        0,
        now
      );
      expect(redisClient.zrem).toHaveBeenCalled();
      expect(User.findById).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.processedCount).toBe(1);
    });
  });
});