const Redis = require('ioredis');
const logger = require('../src/utils/logger');
const messageService = require('../src/services/messageService');
const notificationService = require('../src/services/notificationService');
const { delay } = require('../src/utils/helpers');

class MessageQueueWorker {
  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || null,
      db: parseInt(process.env.REDIS_DB) || 0,
      retryStrategy: (times) => Math.min(times * 100, 3000)
    });
    
    this.queueName = 'message_queue';
    this.deadLetterQueue = 'message_queue_dlq';
    this.maxRetries = 3;
    this.processing = false;
    this.workerId = `worker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async start() {
    try {
      logger.info(`Starting message queue worker ${this.workerId}`);
      
      this.redis.on('error', (err) => {
        logger.error('Redis connection error:', err);
      });

      this.redis.on('connect', () => {
        logger.info('Message queue worker connected to Redis');
      });

      await this.processQueue();
      
      process.on('SIGINT', this.gracefulShutdown.bind(this));
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      
    } catch (error) {
      logger.error('Failed to start message queue worker:', error);
      process.exit(1);
    }
  }

  async processQueue() {
    this.processing = true;
    
    while (this.processing) {
      try {
        const messageData = await this.redis.brpop(this.queueName, 0);
        
        if (messageData && messageData[1]) {
          const message = JSON.parse(messageData[1]);
          await this.processMessage(message);
        }
        
        await delay(100);
        
      } catch (error) {
        logger.error('Error processing message from queue:', error);
        await delay(1000);
      }
    }
  }

  async processMessage(messageData) {
    const startTime = Date.now();
    const { message, type, retryCount = 0 } = messageData;
    
    try {
      logger.info(`Processing message ${message.id} (type: ${type}, retry: ${retryCount})`, {
        messageId: message.id,
        type,
        retryCount
      });

      switch (type) {
        case 'send':
          await this.processSendMessage(message);
          break;
        case 'update_status':
          await this.processUpdateStatus(message);
          break;
        case 'delivery_receipt':
          await this.processDeliveryReceipt(message);
          break;
        case 'read_receipt':
          await this.processReadReceipt(message);
          break;
        case 'notification':
          await this.processNotification(message);
          break;
        case 'cleanup':
          await this.processCleanup(message);
          break;
        default:
          logger.warn(`Unknown message type: ${type}`, { message });
      }

      const duration = Date.now() - startTime;
      logger.info(`Successfully processed message ${message.id}`, {
        messageId: message.id,
        type,
        duration: `${duration}ms`
      });

    } catch (error) {
      logger.error(`Failed to process message ${message.id}:`, {
        error: error.message,
        messageId: message.id,
        type,
        retryCount,
        stack: error.stack
      });

      if (retryCount < this.maxRetries) {
        await this.retryMessage(messageData, retryCount);
      } else {
        await this.moveToDeadLetterQueue(messageData, error);
      }
    }
  }

  async processSendMessage(message) {
    const { id, chatId, senderId, content, messageType, mediaUrls, replyTo } = message;
    
    try {
      const savedMessage = await messageService.createMessage({
        chatId,
        senderId,
        content,
        messageType,
        mediaUrls,
        replyTo
      });

      await messageService.updateMessageStatus(id, 'sent');

      await this.queueMessage({
        type: 'delivery_receipt',
        message: {
          messageId: id,
          chatId,
          senderId,
          recipientIds: await messageService.getChatRecipients(chatId, senderId)
        }
      }, 1000);

      if (messageType === 'text' || mediaUrls) {
        await this.queueMessage({
          type: 'notification',
          message: {
            messageId: id,
            chatId,
            senderId,
            content: content || 'Sent a media message',
            messageType
          }
        }, 500);
      }

      logger.debug(`Message ${id} saved and processed`, { messageId: id, chatId });

    } catch (error) {
      logger.error(`Error processing send message ${id}:`, error);
      throw error;
    }
  }

  async processUpdateStatus(message) {
    const { messageId, status, userId, timestamp } = message;
    
    try {
      await messageService.updateMessageStatus(messageId, status);
      
      if (status === 'read') {
        await messageService.markMessageAsRead(messageId, userId);
        
        await this.queueMessage({
          type: 'read_receipt',
          message: {
            messageId,
            userId,
            readAt: timestamp || new Date()
          }
        });
      }
      
      logger.debug(`Message ${messageId} status updated to ${status}`, { messageId, status, userId });

    } catch (error) {
      logger.error(`Error updating message status ${messageId}:`, error);
      throw error;
    }
  }

  async processDeliveryReceipt(message) {
    const { messageId, chatId, senderId, recipientIds } = message;
    
    try {
      const deliveredTo = [];
      
      for (const recipientId of recipientIds) {
        try {
          const isOnline = await notificationService.isUserOnline(recipientId);
          
          if (isOnline) {
            await messageService.updateMessageDeliveryStatus(messageId, recipientId, 'delivered');
            deliveredTo.push(recipientId);
          }
        } catch (error) {
          logger.warn(`Failed to update delivery status for user ${recipientId}:`, error);
        }
      }

      if (deliveredTo.length > 0) {
        logger.debug(`Message ${messageId} delivered to ${deliveredTo.length} users`, {
          messageId,
          deliveredTo
        });
      }

    } catch (error) {
      logger.error(`Error processing delivery receipt for message ${messageId}:`, error);
      throw error;
    }
  }

  async processReadReceipt(message) {
    const { messageId, userId, readAt } = message;
    
    try {
      await messageService.markMessageAsRead(messageId, userId, readAt);
      
      logger.debug(`Read receipt processed for message ${messageId} by user ${userId}`, {
        messageId,
        userId
      });

    } catch (error) {
      logger.error(`Error processing read receipt for message ${messageId}:`, error);
      throw error;
    }
  }

  async processNotification(message) {
    const { messageId, chatId, senderId, content, messageType } = message;
    
    try {
      const recipients = await messageService.getChatRecipients(chatId, senderId);
      
      for (const recipientId of recipients) {
        try {
          await notificationService.createNotification({
            userId: recipientId,
            type: 'message',
            title: 'New Message',
            message: content?.substring(0, 100) || 'You have a new message',
            data: {
              messageId,
              chatId,
              senderId,
              messageType
            },
            priority: 'normal',
            senderId
          });
        } catch (error) {
          logger.warn(`Failed to create notification for user ${recipientId}:`, error);
        }
      }

      logger.debug(`Notifications created for message ${messageId}`, {
        messageId,
        recipients: recipients.length
      });

    } catch (error) {
      logger.error(`Error processing notifications for message ${messageId}:`, error);
      throw error;
    }
  }

  async processCleanup(message) {
    const { messageIds, olderThan } = message;
    
    try {
      const deletedCount = await messageService.cleanupOldMessages(olderThan, messageIds);
      
      logger.info(`Cleanup completed: ${deletedCount} messages deleted`, {
        olderThan,
        messageIds: messageIds?.length || 0,
        deletedCount
      });

    } catch (error) {
      logger.error('Error during message cleanup:', error);
      throw error;
    }
  }

  async retryMessage(messageData, retryCount) {
    const retryDelay = Math.pow(2, retryCount) * 1000;
    
    logger.warn(`Retrying message in ${retryDelay}ms`, {
      messageId: messageData.message?.id,
      type: messageData.type,
      retryCount: retryCount + 1
    });

    await delay(retryDelay);

    await this.queueMessage({
      ...messageData,
      retryCount: retryCount + 1
    }, 0);
  }

  async moveToDeadLetterQueue(messageData, error) {
    const deadLetterMessage = {
      ...messageData,
      error: error.message,
      failedAt: new Date().toISOString(),
      workerId: this.workerId
    };

    await this.redis.lpush(this.deadLetterQueue, JSON.stringify(deadLetterMessage));
    
    logger.error(`Message moved to dead letter queue:`, {
      messageId: messageData.message?.id,
      type: messageData.type,
      error: error.message
    });
  }

  async queueMessage(messageData, delayMs = 0) {
    try {
      const queueData = JSON.stringify(messageData);
      
      if (delayMs > 0) {
        await this.redis.lpush(this.queueName, queueData);
      } else {
        await this.redis.rpush(this.queueName, queueData);
      }
      
      logger.debug(`Message queued: ${messageData.type}`, {
        type: messageData.type,
        messageId: messageData.message?.id
      });

    } catch (error) {
      logger.error('Failed to queue message:', error);
      throw error;
    }
  }

  async getQueueStats() {
    try {
      const queueLength = await this.redis.llen(this.queueName);
      const dlqLength = await this.redis.llen(this.deadLetterQueue);
      
      return {
        queueLength,
        deadLetterQueueLength: dlqLength,
        workerId: this.workerId,
        processing: this.processing
      };
    } catch (error) {
      logger.error('Failed to get queue stats:', error);
      return null;
    }
  }

  async gracefulShutdown() {
    logger.info('Shutting down message queue worker gracefully...');
    
    this.processing = false;
    
    await delay(1000);
    
    try {
      await this.redis.quit();
      logger.info('Message queue worker shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
    
    process.exit(0);
  }
}

const worker = new MessageQueueWorker();

if (require.main === module) {
  worker.start();
}

module.exports = {
  MessageQueueWorker,
  worker,
  queueMessage: (messageData, delayMs) => worker.queueMessage(messageData, delayMs),
  getQueueStats: () => worker.getQueueStats()
};