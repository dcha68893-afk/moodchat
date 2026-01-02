const Redis = require('ioredis');
const logger = require('../src/utils/logger');
const messageService = require('../src/services/messageService');
const chatService = require('../src/services/chatService');
const userService = require('../src/services/userService');
const { delay } = require('../src/utils/helpers');

class SyncWorker {
  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || null,
      db: parseInt(process.env.REDIS_DB) || 2,
      retryStrategy: (times) => Math.min(times * 100, 3000)
    });
    
    this.syncQueueName = 'sync_queue';
    this.conflictQueueName = 'sync_conflicts';
    this.retryQueueName = 'sync_retry';
    this.maxRetries = 5;
    this.processing = false;
    this.workerId = `sync_worker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.batchSize = 50;
    this.syncInterval = 1000;
  }

  async start() {
    try {
      logger.info(`Starting sync worker ${this.workerId}`);
      
      this.redis.on('error', (err) => {
        logger.error('Sync worker Redis error:', err);
      });

      this.redis.on('connect', () => {
        logger.info('Sync worker connected to Redis');
      });

      await this.processSyncQueue();
      
      setInterval(() => this.processPeriodicSync(), 60000);
      
      process.on('SIGINT', this.gracefulShutdown.bind(this));
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      
    } catch (error) {
      logger.error('Failed to start sync worker:', error);
      process.exit(1);
    }
  }

  async processSyncQueue() {
    this.processing = true;
    
    while (this.processing) {
      try {
        const syncData = await this.redis.brpop(this.syncQueueName, 1);
        
        if (syncData && syncData[1]) {
          const syncJob = JSON.parse(syncData[1]);
          await this.processSyncJob(syncJob);
        } else {
          await this.processBatchSync();
        }
        
        await delay(100);
        
      } catch (error) {
        logger.error('Error processing sync queue:', error);
        await delay(1000);
      }
    }
  }

  async processSyncJob(syncJob) {
    const startTime = Date.now();
    const { userId, operation, data, deviceId, timestamp, retryCount = 0 } = syncJob;
    
    try {
      logger.info(`Processing sync job for user ${userId} (operation: ${operation})`, {
        userId,
        operation,
        deviceId,
        retryCount
      });

      switch (operation) {
        case 'sync_messages':
          await this.syncUserMessages(userId, data, deviceId);
          break;
        case 'sync_chats':
          await this.syncUserChats(userId, data, deviceId);
          break;
        case 'update_status':
          await this.syncStatusUpdate(userId, data);
          break;
        case 'sync_media':
          await this.syncUserMedia(userId, data, deviceId);
          break;
        case 'resolve_conflict':
          await this.resolveConflict(userId, data);
          break;
        default:
          logger.warn(`Unknown sync operation: ${operation}`, { userId, operation });
      }

      const duration = Date.now() - startTime;
      logger.info(`Successfully processed sync job for user ${userId}`, {
        userId,
        operation,
        duration: `${duration}ms`
      });

    } catch (error) {
      logger.error(`Failed to process sync job for user ${userId}:`, {
        error: error.message,
        userId,
        operation,
        retryCount,
        stack: error.stack
      });

      if (retryCount < this.maxRetries) {
        await this.retrySyncJob(syncJob, retryCount);
      } else {
        await this.handleSyncFailure(syncJob, error);
      }
    }
  }

  async syncUserMessages(userId, syncData, deviceId) {
    const { lastSyncTime, pendingMessages, readReceipts } = syncData;
    
    logger.info(`Syncing messages for user ${userId}`, {
      userId,
      lastSyncTime,
      pendingMessagesCount: pendingMessages?.length || 0,
      readReceiptsCount: readReceipts?.length || 0
    });

    const syncStartTime = new Date();
    
    const unsyncedMessages = await messageService.getUnsyncedMessages(userId, lastSyncTime);
    
    const conflicts = [];
    const processedMessages = [];

    if (pendingMessages && pendingMessages.length > 0) {
      for (const pendingMessage of pendingMessages) {
        try {
          const existingMessage = await messageService.getMessageById(pendingMessage.tempId);
          
          if (existingMessage) {
            conflicts.push({
              tempId: pendingMessage.tempId,
              serverId: existingMessage.id,
              type: 'message_duplicate',
              clientData: pendingMessage,
              serverData: existingMessage
            });
            continue;
          }

          const savedMessage = await messageService.createMessage({
            ...pendingMessage,
            senderId: userId,
            status: 'sent',
            synced: true,
            syncedAt: new Date(),
            deviceId
          });

          processedMessages.push({
            tempId: pendingMessage.tempId,
            serverId: savedMessage.id,
            serverTimestamp: savedMessage.createdAt
          });

          await this.cacheSyncResult(userId, 'message_saved', {
            tempId: pendingMessage.tempId,
            serverId: savedMessage.id
          });

        } catch (error) {
          logger.error(`Error saving pending message for user ${userId}:`, {
            error: error.message,
            tempId: pendingMessage.tempId,
            userId
          });
          
          await this.queueSyncJob({
            userId,
            operation: 'sync_messages',
            data: { pendingMessages: [pendingMessage] },
            deviceId,
            timestamp: new Date().toISOString()
          }, 5000);
        }
      }
    }

    if (readReceipts && readReceipts.length > 0) {
      for (const receipt of readReceipts) {
        try {
          await messageService.markMessageAsRead(receipt.messageId, userId, receipt.readAt);
          
          logger.debug(`Read receipt synced for message ${receipt.messageId}`, {
            userId,
            messageId: receipt.messageId
          });

        } catch (error) {
          logger.warn(`Failed to sync read receipt for message ${receipt.messageId}:`, error);
        }
      }
    }

    const syncSummary = {
      userId,
      deviceId,
      syncStartTime: syncStartTime.toISOString(),
      syncEndTime: new Date().toISOString(),
      serverMessagesSent: unsyncedMessages.length,
      clientMessagesProcessed: processedMessages.length,
      conflictsFound: conflicts.length,
      readReceiptsProcessed: readReceipts?.length || 0
    };

    await this.cacheSyncResult(userId, 'sync_summary', syncSummary);

    const response = {
      serverMessages: unsyncedMessages,
      processedMessages,
      conflicts,
      syncToken: new Date().toISOString()
    };

    if (conflicts.length > 0) {
      await this.queueConflictResolution(userId, conflicts);
    }

    return response;
  }

  async syncUserChats(userId, syncData, deviceId) {
    const { lastSyncTime, chatUpdates } = syncData;
    
    logger.info(`Syncing chats for user ${userId}`, {
      userId,
      lastSyncTime,
      chatUpdatesCount: chatUpdates?.length || 0
    });

    const updatedChats = await chatService.getUpdatedChats(userId, lastSyncTime);
    
    if (chatUpdates && chatUpdates.length > 0) {
      for (const chatUpdate of chatUpdates) {
        try {
          await chatService.updateLastRead(chatUpdate.chatId, userId, chatUpdate.lastRead);
          
          logger.debug(`Chat last read updated for user ${userId}`, {
            userId,
            chatId: chatUpdate.chatId
          });

        } catch (error) {
          logger.warn(`Failed to update chat last read for user ${userId}:`, error);
        }
      }
    }

    return {
      updatedChats,
      syncToken: new Date().toISOString()
    };
  }

  async syncStatusUpdate(userId, statusData) {
    const { online, lastSeen, status, deviceId } = statusData;
    
    logger.info(`Syncing status for user ${userId}`, {
      userId,
      online,
      status,
      deviceId
    });

    await userService.updateUserStatus(userId, {
      online,
      lastSeen: lastSeen || new Date(),
      status,
      deviceId
    });

    await this.cacheUserPresence(userId, {
      online,
      lastSeen: lastSeen || new Date(),
      status,
      deviceId
    });

    return { success: true };
  }

  async syncUserMedia(userId, syncData, deviceId) {
    const { pendingUploads, pendingDownloads } = syncData;
    
    logger.info(`Syncing media for user ${userId}`, {
      userId,
      pendingUploadsCount: pendingUploads?.length || 0,
      pendingDownloadsCount: pendingDownloads?.length || 0
    });

    const results = {
      uploads: [],
      downloads: []
    };

    if (pendingUploads && pendingUploads.length > 0) {
      for (const upload of pendingUploads) {
        try {
          const mediaId = await this.processMediaUpload(upload, userId, deviceId);
          results.uploads.push({
            tempId: upload.tempId,
            serverId: mediaId,
            success: true
          });
        } catch (error) {
          logger.error(`Failed to sync media upload for user ${userId}:`, error);
          results.uploads.push({
            tempId: upload.tempId,
            success: false,
            error: error.message
          });
        }
      }
    }

    return results;
  }

  async processMediaUpload(uploadData, userId, deviceId) {
    return `media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async resolveConflict(userId, conflictData) {
    const { conflictId, resolution, clientData, serverData } = conflictData;
    
    logger.info(`Resolving conflict ${conflictId} for user ${userId}`, {
      userId,
      conflictId,
      resolution
    });

    switch (resolution) {
      case 'use_client':
        await this.applyClientResolution(userId, conflictData);
        break;
      case 'use_server':
        await this.applyServerResolution(userId, conflictData);
        break;
      case 'merge':
        await this.applyMergeResolution(userId, conflictData);
        break;
      default:
        throw new Error(`Unknown resolution type: ${resolution}`);
    }

    await this.redis.hdel(`conflicts:${userId}`, conflictId);
    
    return { success: true, conflictId };
  }

  async applyClientResolution(userId, conflictData) {
    const { conflictType, clientData } = conflictData;
    
    switch (conflictType) {
      case 'message_duplicate':
        await messageService.deleteMessage(clientData.serverId);
        break;
      default:
        logger.warn(`Unknown conflict type for client resolution: ${conflictType}`);
    }
  }

  async applyServerResolution(userId, conflictData) {
    return { applied: 'server' };
  }

  async applyMergeResolution(userId, conflictData) {
    return { applied: 'merge' };
  }

  async processBatchSync() {
    try {
      const usersToSync = await this.getUsersNeedingSync();
      
      if (usersToSync.length === 0) {
        return;
      }

      const batch = usersToSync.slice(0, this.batchSize);
      
      const syncPromises = batch.map(userId => 
        this.queueSyncJob({
          userId,
          operation: 'sync_messages',
          data: { lastSyncTime: await this.getLastSyncTime(userId) },
          timestamp: new Date().toISOString()
        }, 0)
      );

      await Promise.all(syncPromises);
      
      logger.info(`Queued batch sync for ${batch.length} users`);

    } catch (error) {
      logger.error('Error in batch sync:', error);
    }
  }

  async processPeriodicSync() {
    try {
      await this.cleanupStaleSyncData();
      await this.retryFailedSyncs();
      
      logger.debug('Periodic sync maintenance completed');
    } catch (error) {
      logger.error('Error in periodic sync:', error);
    }
  }

  async cleanupStaleSyncData() {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    
    try {
      const staleKeys = await this.redis.keys('sync:*');
      const pipeline = this.redis.pipeline();
      
      for (const key of staleKeys) {
        const timestamp = await this.redis.hget(key, 'timestamp');
        if (timestamp && parseInt(timestamp) < cutoff) {
          pipeline.del(key);
        }
      }
      
      await pipeline.exec();
      
    } catch (error) {
      logger.error('Error cleaning up stale sync data:', error);
    }
  }

  async retryFailedSyncs() {
    try {
      const retryJobs = await this.redis.lrange(this.retryQueueName, 0, -1);
      
      if (retryJobs.length === 0) {
        return;
      }

      const pipeline = this.redis.pipeline();
      
      for (const jobJson of retryJobs) {
        const job = JSON.parse(jobJson);
        if (job.retryCount < this.maxRetries) {
          pipeline.rpush(this.syncQueueName, JSON.stringify(job));
        }
      }
      
      pipeline.del(this.retryQueueName);
      await pipeline.exec();
      
      logger.info(`Retried ${retryJobs.length} failed sync jobs`);
      
    } catch (error) {
      logger.error('Error retrying failed syncs:', error);
    }
  }

  async retrySyncJob(syncJob, retryCount) {
    const retryDelay = Math.pow(2, retryCount) * 1000;
    
    logger.warn(`Retrying sync job in ${retryDelay}ms`, {
      userId: syncJob.userId,
      operation: syncJob.operation,
      retryCount: retryCount + 1
    });

    await delay(retryDelay);

    await this.redis.rpush(this.retryQueueName, JSON.stringify({
      ...syncJob,
      retryCount: retryCount + 1
    }));
  }

  async handleSyncFailure(syncJob, error) {
    const failureData = {
      ...syncJob,
      error: error.message,
      failedAt: new Date().toISOString(),
      workerId: this.workerId
    };

    await this.redis.hset(`sync_failures:${syncJob.userId}`, 
      Date.now().toString(), 
      JSON.stringify(failureData)
    );

    logger.error(`Sync job failed permanently for user ${syncJob.userId}:`, {
      userId: syncJob.userId,
      operation: syncJob.operation,
      error: error.message
    });
  }

  async queueSyncJob(syncJob, delayMs = 0) {
    try {
      const queueData = JSON.stringify(syncJob);
      
      if (delayMs > 0) {
        await this.redis.lpush(this.syncQueueName, queueData);
      } else {
        await this.redis.rpush(this.syncQueueName, queueData);
      }
      
      await this.updateLastSyncRequest(syncJob.userId);
      
      logger.debug(`Sync job queued: ${syncJob.operation}`, {
        userId: syncJob.userId,
        operation: syncJob.operation,
        delayMs
      });

    } catch (error) {
      logger.error('Failed to queue sync job:', error);
      throw error;
    }
  }

  async queueConflictResolution(userId, conflicts) {
    for (const conflict of conflicts) {
      await this.redis.hset(`conflicts:${userId}`, 
        conflict.tempId, 
        JSON.stringify(conflict)
      );
    }
    
    await this.queueSyncJob({
      userId,
      operation: 'resolve_conflict',
      data: { conflicts },
      timestamp: new Date().toISOString()
    });
  }

  async cacheSyncResult(userId, key, data) {
    await this.redis.hset(`sync_results:${userId}`, key, JSON.stringify(data));
    await this.redis.expire(`sync_results:${userId}`, 3600);
  }

  async cacheUserPresence(userId, presenceData) {
    await this.redis.hset(`presence:${userId}`, 'data', JSON.stringify(presenceData));
    await this.redis.expire(`presence:${userId}`, 300);
  }

  async getLastSyncTime(userId) {
    const lastSync = await this.redis.hget(`sync_status:${userId}`, 'lastSyncTime');
    return lastSync ? new Date(lastSync) : null;
  }

  async updateLastSyncRequest(userId) {
    await this.redis.hset(`sync_status:${userId}`, 
      'lastSyncRequest', 
      Date.now().toString()
    );
    await this.redis.expire(`sync_status:${userId}`, 86400);
  }

  async getUsersNeedingSync() {
    const userKeys = await this.redis.keys('sync_status:*');
    const users = [];
    
    for (const key of userKeys) {
      const userId = key.replace('sync_status:', '');
      const lastSyncRequest = await this.redis.hget(key, 'lastSyncRequest');
      
      if (lastSyncRequest && (Date.now() - parseInt(lastSyncRequest)) > 30000) {
        users.push(userId);
      }
    }
    
    return users;
  }

  async getQueueStats() {
    try {
      const queueLength = await this.redis.llen(this.syncQueueName);
      const conflictQueueLength = await this.redis.llen(this.conflictQueueName);
      const retryQueueLength = await this.redis.llen(this.retryQueueName);
      
      return {
        queueLength,
        conflictQueueLength,
        retryQueueLength,
        workerId: this.workerId,
        processing: this.processing
      };
    } catch (error) {
      logger.error('Failed to get queue stats:', error);
      return null;
    }
  }

  async gracefulShutdown() {
    logger.info('Shutting down sync worker gracefully...');
    
    this.processing = false;
    
    await delay(2000);
    
    try {
      await this.redis.quit();
      logger.info('Sync worker shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
    
    process.exit(0);
  }
}

const syncWorker = new SyncWorker();

if (require.main === module) {
  syncWorker.start();
}

module.exports = {
  SyncWorker,
  syncWorker,
  queueSyncJob: (syncJob, delayMs) => syncWorker.queueSyncJob(syncJob, delayMs),
  getQueueStats: () => syncWorker.getQueueStats(),
  getLastSyncTime: (userId) => syncWorker.getLastSyncTime(userId)
};