const Redis = require('ioredis');
const logger = require('../src/utils/logger');
const notificationService = require('../src/services/notificationService');
const userService = require('../src/services/userService');
const { delay } = require('../src/utils/helpers');

class NotificationWorker {
  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || null,
      db: parseInt(process.env.REDIS_DB) || 1,
      retryStrategy: (times) => Math.min(times * 100, 3000)
    });
    
    this.queueName = 'notification_queue';
    this.priorityQueueName = 'notification_queue_priority';
    this.deadLetterQueue = 'notification_queue_dlq';
    this.maxRetries = 3;
    this.processing = false;
    this.workerId = `notification_worker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.webSocketService = null;
  }

  setWebSocketService(webSocketService) {
    this.webSocketService = webSocketService;
  }

  async start() {
    try {
      logger.info(`Starting notification worker ${this.workerId}`);
      
      this.redis.on('error', (err) => {
        logger.error('Notification worker Redis error:', err);
      });

      this.redis.on('connect', () => {
        logger.info('Notification worker connected to Redis');
      });

      await this.processQueues();
      
      process.on('SIGINT', this.gracefulShutdown.bind(this));
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      
    } catch (error) {
      logger.error('Failed to start notification worker:', error);
      process.exit(1);
    }
  }

  async processQueues() {
    this.processing = true;
    
    while (this.processing) {
      try {
        const priorityResult = await this.redis.brpop(this.priorityQueueName, 1);
        if (priorityResult && priorityResult[1]) {
          await this.processNotification(JSON.parse(priorityResult[1]));
          continue;
        }

        const normalResult = await this.redis.brpop(this.queueName, 1);
        if (normalResult && normalResult[1]) {
          await this.processNotification(JSON.parse(normalResult[1]));
          continue;
        }

        await delay(100);
        
      } catch (error) {
        logger.error('Error processing notification queue:', error);
        await delay(1000);
      }
    }
  }

  async processNotification(notificationData) {
    const startTime = Date.now();
    const { notification, retryCount = 0 } = notificationData;
    
    try {
      logger.info(`Processing notification ${notification.id} (retry: ${retryCount})`, {
        notificationId: notification.id,
        userId: notification.userId,
        type: notification.type,
        priority: notification.priority,
        retryCount
      });

      await this.validateNotification(notification);
      
      const userPreferences = await userService.getNotificationPreferences(notification.userId);
      
      if (!this.shouldSendNotification(notification, userPreferences)) {
        logger.info(`Notification ${notification.id} suppressed based on user preferences`, {
          notificationId: notification.id,
          userId: notification.userId
        });
        return;
      }

      if (this.webSocketService && await this.isUserOnline(notification.userId)) {
        await this.sendWebSocketNotification(notification);
      } else {
        await this.sendPushNotification(notification, userPreferences);
      }

      await notificationService.markNotificationAsProcessed(notification.id);
      
      const duration = Date.now() - startTime;
      logger.info(`Successfully processed notification ${notification.id}`, {
        notificationId: notification.id,
        userId: notification.userId,
        type: notification.type,
        duration: `${duration}ms`,
        deliveryMethod: this.webSocketService ? 'websocket/push' : 'push'
      });

    } catch (error) {
      logger.error(`Failed to process notification ${notification.id}:`, {
        error: error.message,
        notificationId: notification.id,
        userId: notification.userId,
        retryCount,
        stack: error.stack
      });

      if (retryCount < this.maxRetries) {
        await this.retryNotification(notificationData, retryCount);
      } else {
        await this.moveToDeadLetterQueue(notificationData, error);
        await this.handleFailedNotification(notification.id, error.message);
      }
    }
  }

  async validateNotification(notification) {
    const requiredFields = ['id', 'userId', 'type', 'title', 'message'];
    
    for (const field of requiredFields) {
      if (!notification[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!notification.createdAt) {
      notification.createdAt = new Date().toISOString();
    }

    if (notification.expiresAt && new Date(notification.expiresAt) < new Date()) {
      throw new Error('Notification has expired');
    }
  }

  shouldSendNotification(notification, userPreferences) {
    if (!userPreferences.inAppNotifications) {
      return false;
    }

    if (userPreferences.mutedTypes && userPreferences.mutedTypes.includes(notification.type)) {
      return false;
    }

    if (userPreferences.quietHours && userPreferences.quietHours.enabled) {
      const now = new Date();
      const currentTime = now.getHours() * 60 + now.getMinutes();
      
      if (userPreferences.quietHours.start && userPreferences.quietHours.end) {
        const [startHour, startMinute] = userPreferences.quietHours.start.split(':').map(Number);
        const [endHour, endMinute] = userPreferences.quietHours.end.split(':').map(Number);
        const startTime = startHour * 60 + startMinute;
        const endTime = endHour * 60 + endMinute;
        
        if (currentTime >= startTime && currentTime <= endTime) {
          return false;
        }
      }
    }

    return true;
  }

  async isUserOnline(userId) {
    if (!this.webSocketService) return false;
    
    try {
      return this.webSocketService.isUserOnline(userId);
    } catch (error) {
      logger.warn(`Error checking user online status ${userId}:`, error);
      return false;
    }
  }

  async sendWebSocketNotification(notification) {
    if (!this.webSocketService) {
      throw new Error('WebSocket service not available');
    }

    try {
      await this.webSocketService.sendNotification(notification.userId, {
        type: 'new_notification',
        notification: {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          data: notification.data,
          actionUrl: notification.actionUrl,
          createdAt: notification.createdAt
        },
        unreadCount: await notificationService.getUnreadCount(notification.userId)
      });

      logger.debug(`WebSocket notification sent for ${notification.id}`, {
        notificationId: notification.id,
        userId: notification.userId
      });

    } catch (error) {
      logger.error(`Failed to send WebSocket notification ${notification.id}:`, error);
      throw error;
    }
  }

  async sendPushNotification(notification, userPreferences) {
    if (!userPreferences.pushNotifications) {
      logger.debug(`Push notifications disabled for user ${notification.userId}`);
      return;
    }

    try {
      const pushTokens = await userService.getUserPushTokens(notification.userId);
      
      if (pushTokens.length === 0) {
        logger.debug(`No push tokens found for user ${notification.userId}`);
        return;
      }

      const pushPromises = pushTokens.map(token => 
        this.sendToPushService(token, notification)
      );

      const results = await Promise.allSettled(pushPromises);
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      if (successful > 0) {
        logger.info(`Push notification ${notification.id} sent to ${successful} device(s)`, {
          notificationId: notification.id,
          userId: notification.userId,
          successful,
          failed
        });
      } else if (failed > 0) {
        throw new Error(`All push attempts failed: ${failed} failures`);
      }

    } catch (error) {
      logger.error(`Error in push notification ${notification.id}:`, error);
      throw error;
    }
  }

  async sendToPushService(pushToken, notification) {
    const payload = {
      to: pushToken,
      notification: {
        title: notification.title,
        body: notification.message,
        icon: process.env.APP_ICON_URL || 'https://example.com/icon.png',
        badge: '1',
        sound: 'default'
      },
      data: {
        notificationId: notification.id,
        type: notification.type,
        actionUrl: notification.actionUrl,
        ...notification.data
      },
      priority: notification.priority === 'high' || notification.priority === 'urgent' ? 'high' : 'normal',
      ttl: 3600
    };

    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Push service error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    
    if (result.failure > 0) {
      throw new Error(`Push failed: ${result.results[0]?.error || 'Unknown error'}`);
    }

    return result;
  }

  async retryNotification(notificationData, retryCount) {
    const retryDelay = Math.pow(2, retryCount) * 1000;
    
    logger.warn(`Retrying notification in ${retryDelay}ms`, {
      notificationId: notificationData.notification.id,
      type: notificationData.notification.type,
      retryCount: retryCount + 1
    });

    await delay(retryDelay);

    await this.queueNotification({
      ...notificationData,
      retryCount: retryCount + 1
    }, notificationData.notification.priority);
  }

  async moveToDeadLetterQueue(notificationData, error) {
    const deadLetterNotification = {
      ...notificationData,
      error: error.message,
      failedAt: new Date().toISOString(),
      workerId: this.workerId
    };

    await this.redis.lpush(this.deadLetterQueue, JSON.stringify(deadLetterNotification));
    
    logger.error(`Notification moved to dead letter queue:`, {
      notificationId: notificationData.notification.id,
      userId: notificationData.notification.userId,
      type: notificationData.notification.type,
      error: error.message
    });
  }

  async handleFailedNotification(notificationId, error) {
    try {
      await notificationService.updateNotificationStatus(notificationId, 'failed', {
        error,
        failedAt: new Date()
      });
    } catch (updateError) {
      logger.error(`Failed to update notification status ${notificationId}:`, updateError);
    }
  }

  async queueNotification(notificationData, priority = 'normal') {
    try {
      const queueData = JSON.stringify(notificationData);
      const queueName = priority === 'high' || priority === 'urgent' ? 
        this.priorityQueueName : this.queueName;
      
      await this.redis.rpush(queueName, queueData);
      
      logger.debug(`Notification queued: ${notificationData.notification.type}`, {
        notificationId: notificationData.notification.id,
        userId: notificationData.notification.userId,
        priority,
        queue: queueName
      });

    } catch (error) {
      logger.error('Failed to queue notification:', error);
      throw error;
    }
  }

  async bulkQueueNotifications(notifications) {
    const pipeline = this.redis.pipeline();
    
    notifications.forEach(notification => {
      const queueName = notification.priority === 'high' || notification.priority === 'urgent' ? 
        this.priorityQueueName : this.queueName;
      
      pipeline.rpush(queueName, JSON.stringify({ notification }));
    });
    
    await pipeline.exec();
    
    logger.info(`Bulk queued ${notifications.length} notifications`);
  }

  async getQueueStats() {
    try {
      const queueLength = await this.redis.llen(this.queueName);
      const priorityQueueLength = await this.redis.llen(this.priorityQueueName);
      const dlqLength = await this.redis.llen(this.deadLetterQueue);
      
      return {
        queueLength,
        priorityQueueLength,
        deadLetterQueueLength: dlqLength,
        workerId: this.workerId,
        processing: this.processing
      };
    } catch (error) {
      logger.error('Failed to get queue stats:', error);
      return null;
    }
  }

  async cleanupExpiredNotifications() {
    try {
      const expiredCount = await notificationService.cleanupExpiredNotifications();
      
      if (expiredCount > 0) {
        logger.info(`Cleaned up ${expiredCount} expired notifications`);
      }
      
      return expiredCount;
    } catch (error) {
      logger.error('Error cleaning up expired notifications:', error);
      return 0;
    }
  }

  async gracefulShutdown() {
    logger.info('Shutting down notification worker gracefully...');
    
    this.processing = false;
    
    await delay(2000);
    
    try {
      await this.redis.quit();
      logger.info('Notification worker shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
    
    process.exit(0);
  }
}

const notificationWorker = new NotificationWorker();

if (require.main === module) {
  notificationWorker.start();
}

module.exports = {
  NotificationWorker,
  notificationWorker,
  queueNotification: (notificationData, priority) => 
    notificationWorker.queueNotification(notificationData, priority),
  bulkQueueNotifications: (notifications) => 
    notificationWorker.bulkQueueNotifications(notifications),
  getQueueStats: () => notificationWorker.getQueueStats(),
  cleanupExpiredNotifications: () => notificationWorker.cleanupExpiredNotifications()
};