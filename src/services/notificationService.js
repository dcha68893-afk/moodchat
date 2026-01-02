const { Notification, User } = require('../models');
const redisClient = require('../utils/redisClient');
const logger = require('../utils/logger');

class NotificationService {
  async createNotification(userId, notificationData) {
    try {
      const notification = await Notification.create({
        userId,
        ...notificationData,
      });

      // Clear unread count cache
      await redisClient.del(`user:${userId}:notifications:unread`);

      // Send real-time notification via WebSocket
      const webSocketService = require('./webSocketService');
      webSocketService.sendNotification(userId, notification);

      return notification;
    } catch (error) {
      logger.error('Create notification error:', error);
      throw error;
    }
  }

  async createFromTemplate(userId, template, data = {}) {
    try {
      // Get user's notification preferences
      const user = await User.findByPk(userId, {
        attributes: ['settings'],
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Check if user wants this type of notification
      const notificationSettings = user.settings?.notifications || {};
      const notificationType = this.getNotificationTypeFromTemplate(template);

      if (notificationSettings[notificationType] === false) {
        return null;
      }

      const templateData = this.getNotificationTemplate(template, data);

      if (!templateData) {
        throw new Error(`Unknown notification template: ${template}`);
      }

      return await this.createNotification(userId, templateData);
    } catch (error) {
      logger.error('Create notification from template error:', error);
      throw error;
    }
  }

  async getUserNotifications(userId, options = {}) {
    try {
      const cacheKey = `user:${userId}:notifications:${JSON.stringify(options)}`;
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const notifications = await Notification.getUserNotifications(userId, options);

      // Format response
      const formattedNotifications = notifications.map(notification => ({
        id: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        data: notification.data,
        isRead: notification.isRead,
        readAt: notification.readAt,
        isDelivered: notification.isDelivered,
        deliveredAt: notification.deliveredAt,
        priority: notification.priority,
        channel: notification.channel,
        actionUrl: notification.actionUrl,
        createdAt: notification.createdAt,
        expiresAt: notification.expiresAt,
        actionData: notification.getActionData(),
      }));

      // Cache for 30 seconds
      await redisClient.setex(cacheKey, 30, JSON.stringify(formattedNotifications));

      return formattedNotifications;
    } catch (error) {
      logger.error('Get user notifications error:', error);
      throw error;
    }
  }

  async getUnreadCount(userId) {
    try {
      const cacheKey = `user:${userId}:notifications:unread`;
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return parseInt(cached);
      }

      const count = await Notification.getUnreadCount(userId);

      // Cache for 30 seconds
      await redisClient.setex(cacheKey, 30, count.toString());

      return count;
    } catch (error) {
      logger.error('Get unread count error:', error);
      throw error;
    }
  }

  async markAsRead(notificationId, userId) {
    try {
      const notification = await Notification.findByPk(notificationId);
      if (!notification) {
        throw new Error('Notification not found');
      }

      // Check authorization
      if (notification.userId !== userId) {
        throw new Error('Not authorized to mark this notification as read');
      }

      // Mark as read
      await notification.markAsRead();

      // Clear cache
      await redisClient.del(`user:${userId}:notifications:*`);
      await redisClient.del(`user:${userId}:notifications:unread`);

      return notification;
    } catch (error) {
      logger.error('Mark as read error:', error);
      throw error;
    }
  }

  async markAllAsRead(userId) {
    try {
      await Notification.markAllAsRead(userId);

      // Clear cache
      await redisClient.del(`user:${userId}:notifications:*`);
      await redisClient.del(`user:${userId}:notifications:unread`);

      return true;
    } catch (error) {
      logger.error('Mark all as read error:', error);
      throw error;
    }
  }

  async markAsDelivered(notificationId, userId) {
    try {
      const notification = await Notification.findByPk(notificationId);
      if (!notification) {
        throw new Error('Notification not found');
      }

      // Check authorization
      if (notification.userId !== userId) {
        throw new Error('Not authorized to mark this notification as delivered');
      }

      // Mark as delivered
      await notification.markAsDelivered();

      // Clear cache
      await redisClient.del(`user:${userId}:notifications:*`);

      return notification;
    } catch (error) {
      logger.error('Mark as delivered error:', error);
      throw error;
    }
  }

  async deleteNotification(notificationId, userId) {
    try {
      const notification = await Notification.findByPk(notificationId);
      if (!notification) {
        throw new Error('Notification not found');
      }

      // Check authorization
      if (notification.userId !== userId) {
        throw new Error('Not authorized to delete this notification');
      }

      // Delete notification
      await notification.destroy();

      // Clear cache
      await redisClient.del(`user:${userId}:notifications:*`);
      await redisClient.del(`user:${userId}:notifications:unread`);

      return true;
    } catch (error) {
      logger.error('Delete notification error:', error);
      throw error;
    }
  }

  async deleteAllNotifications(userId, options = {}) {
    try {
      const where = { userId };

      if (options.readOnly) {
        where.isRead = true;
      }

      await Notification.destroy({ where });

      // Clear cache
      await redisClient.del(`user:${userId}:notifications:*`);
      await redisClient.del(`user:${userId}:notifications:unread`);

      return true;
    } catch (error) {
      logger.error('Delete all notifications error:', error);
      throw error;
    }
  }

  async updateNotificationPreferences(userId, preferences) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Update notification settings
      user.settings = {
        ...user.settings,
        notifications: {
          ...user.settings?.notifications,
          ...preferences,
        },
      };

      await user.save();

      return user.settings.notifications;
    } catch (error) {
      logger.error('Update notification preferences error:', error);
      throw error;
    }
  }

  async sendPushNotification(userId, notificationData) {
    try {
      // This would integrate with a push notification service like Firebase Cloud Messaging
      // For now, log and return success
      logger.info(`Would send push notification to user ${userId}:`, notificationData.title);

      return {
        success: true,
        messageId: `mock-push-${Date.now()}`,
      };
    } catch (error) {
      logger.error('Send push notification error:', error);
      throw error;
    }
  }

  async sendEmailNotification(userId, notificationData) {
    try {
      // This would integrate with an email service
      // For now, log and return success
      logger.info(`Would send email notification to user ${userId}:`, notificationData.subject);

      return {
        success: true,
        messageId: `mock-email-${Date.now()}`,
      };
    } catch (error) {
      logger.error('Send email notification error:', error);
      throw error;
    }
  }

  async cleanupExpiredNotifications() {
    try {
      const count = await Notification.cleanupExpired();
      logger.info(`Cleaned up ${count} expired notifications`);
      return count;
    } catch (error) {
      logger.error('Cleanup expired notifications error:', error);
      throw error;
    }
  }

  getNotificationTypeFromTemplate(template) {
    const typeMap = {
      friend_request: 'friendRequests',
      friend_request_accepted: 'friendRequests',
      new_message: 'messages',
      message_reaction: 'mentions',
      message_reply: 'mentions',
      group_invite: 'mentions',
      group_mention: 'mentions',
      call_incoming: 'calls',
      call_missed: 'calls',
      mood_shared: 'mentions',
    };

    return typeMap[template] || 'other';
  }

  getNotificationTemplate(template, data) {
    const templates = {
      friend_request: {
        type: 'friend_request',
        title: 'New Friend Request',
        body: `${data.requesterName} sent you a friend request`,
        data: data,
        priority: 'medium',
        actionUrl: `/friends/requests`,
      },
      friend_request_accepted: {
        type: 'friend_request_accepted',
        title: 'Friend Request Accepted',
        body: `${data.acceptorName} accepted your friend request`,
        data: data,
        priority: 'medium',
        actionUrl: `/friends`,
      },
      new_message: {
        type: 'new_message',
        title: 'New Message',
        body: `${data.senderName}: ${data.messagePreview}`,
        data: data,
        priority: 'high',
        actionUrl: `/chats/${data.chatId}`,
      },
      message_reaction: {
        type: 'message_reaction',
        title: 'Message Reaction',
        body: `${data.reactorName} reacted ${data.reaction} to your message`,
        data: data,
        priority: 'low',
        actionUrl: `/chats/${data.chatId}?message=${data.messageId}`,
      },
      message_reply: {
        type: 'message_reply',
        title: 'Message Reply',
        body: `${data.replierName} replied to your message`,
        data: data,
        priority: 'medium',
        actionUrl: `/chats/${data.chatId}?message=${data.messageId}`,
      },
      group_invite: {
        type: 'group_invite',
        title: 'Group Invitation',
        body: `${data.inviterName} invited you to join "${data.groupName}"`,
        data: data,
        priority: 'medium',
        actionUrl: `/groups/${data.groupId}`,
      },
      group_mention: {
        type: 'group_mention',
        title: 'You were mentioned',
        body: `${data.mentionerName} mentioned you in "${data.groupName}"`,
        data: data,
        priority: 'high',
        actionUrl: `/chats/${data.chatId}?message=${data.messageId}`,
      },
      call_incoming: {
        type: 'call_incoming',
        title: 'Incoming Call',
        body: `${data.callerName} is calling you`,
        data: data,
        priority: 'urgent',
        actionUrl: `/calls/${data.callId}`,
      },
      call_missed: {
        type: 'call_missed',
        title: 'Missed Call',
        body: `You missed a call from ${data.callerName}`,
        data: data,
        priority: 'medium',
        actionUrl: `/calls/${data.callId}`,
      },
      mood_shared: {
        type: 'mood_shared',
        title: 'Mood Shared',
        body: `${data.sharedByName} shared their ${data.moodType} mood with you`,
        data: data,
        priority: 'low',
        actionUrl: `/moods/shared/${data.moodId}`,
      },
    };

    return templates[template];
  }
}

module.exports = new NotificationService();
