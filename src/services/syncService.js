const { Op } = require('sequelize');
const { Message, ChatParticipant } = require('../models');
const redisClient = require('../utils/redisClient');
const logger = require('../utils/logger');

class SyncService {
  async getSyncData(userId, lastSyncTime) {
    try {
      // Get user's chats
      const chats = await this.getUserChats(userId);

      // Get messages since last sync
      const messages = await this.getMessagesSince(userId, lastSyncTime);

      // Get read receipts since last sync
      const readReceipts = await this.getReadReceiptsSince(userId, lastSyncTime);

      // Get typing indicators
      const typingIndicators = await this.getTypingIndicators(userId);

      // Get unread counts
      const unreadCounts = await this.getUnreadCounts(userId);

      return {
        chats,
        messages,
        readReceipts,
        typingIndicators,
        unreadCounts,
        syncTime: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Get sync data error:', error);
      throw error;
    }
  }

  async syncMessages(userId, messages) {
    try {
      const results = {
        created: [],
        updated: [],
        failed: [],
      };

      for (const message of messages) {
        try {
          // Check if message already exists (by clientMessageId)
          if (message.clientMessageId) {
            const existing = await Message.findOne({
              where: { clientMessageId: message.clientMessageId },
            });

            if (existing) {
              // Update existing message
              await existing.update({
                syncStatus: message.syncStatus || 'sent',
                ...message,
              });
              results.updated.push(existing);
              continue;
            }
          }

          // Create new message
          const newMessage = await Message.create({
            ...message,
            senderId: userId,
            syncStatus: 'sent',
          });

          // Update chat's last message
          const chat = await require('../models').Chat.findByPk(message.chatId);
          if (chat) {
            await chat.updateLastMessage(newMessage.id, newMessage.createdAt);
          }

          results.created.push(newMessage);
        } catch (error) {
          logger.error('Sync message error:', error);
          results.failed.push({
            message,
            error: error.message,
          });
        }
      }

      // Clear cache for affected chats
      const chatIds = [...new Set(messages.map(m => m.chatId))];
      await this.clearChatCache(userId, chatIds);

      return results;
    } catch (error) {
      logger.error('Sync messages error:', error);
      throw error;
    }
  }

  async syncReadReceipts(userId, readReceipts) {
    try {
      const results = {
        created: [],
        updated: [],
        failed: [],
      };

      const ReadReceipt = require('../models').ReadReceipt;

      for (const receipt of readReceipts) {
        try {
          const existing = await ReadReceipt.findOne({
            where: {
              messageId: receipt.messageId,
              userId: receipt.userId,
            },
          });

          if (existing) {
            // Update if newer
            if (new Date(receipt.readAt) > new Date(existing.readAt)) {
              await existing.update({
                readAt: receipt.readAt,
                deviceId: receipt.deviceId,
              });
              results.updated.push(existing);
            }
          } else {
            // Create new
            const newReceipt = await ReadReceipt.create({
              ...receipt,
              userId,
            });
            results.created.push(newReceipt);

            // Update message sync status
            await this.updateMessageSyncStatus(receipt.messageId, 'read');
          }
        } catch (error) {
          logger.error('Sync read receipt error:', error);
          results.failed.push({
            receipt,
            error: error.message,
          });
        }
      }

      return results;
    } catch (error) {
      logger.error('Sync read receipts error:', error);
      throw error;
    }
  }

  async syncTypingIndicators(userId, typingIndicators) {
    try {
      const TypingIndicator = require('../models').TypingIndicator;

      for (const indicator of typingIndicators) {
        try {
          await TypingIndicator.updateTyping(indicator.chatId, userId, indicator.isTyping, {
            deviceId: indicator.deviceId,
          });
        } catch (error) {
          logger.error('Sync typing indicator error:', error);
        }
      }

      return { success: true };
    } catch (error) {
      logger.error('Sync typing indicators error:', error);
      throw error;
    }
  }

  async getPendingMessages(userId) {
    try {
      const messages = await Message.findAll({
        where: {
          senderId: userId,
          syncStatus: 'pending',
        },
        order: [['createdAt', 'ASC']],
        limit: 100,
      });

      return messages;
    } catch (error) {
      logger.error('Get pending messages error:', error);
      throw error;
    }
  }

  async updateMessageSyncStatus(messageId, status) {
    try {
      const message = await Message.findByPk(messageId);
      if (!message) {
        throw new Error('Message not found');
      }

      message.syncStatus = status;
      await message.save();

      return message;
    } catch (error) {
      logger.error('Update message sync status error:', error);
      throw error;
    }
  }

  async getUserChats(userId) {
    try {
      const chatService = require('./chatService');
      return await chatService.getUserChats(userId, { forceRefresh: true });
    } catch (error) {
      logger.error('Get user chats error:', error);
      throw error;
    }
  }

  async getMessagesSince(userId, since) {
    try {
      const where = {
        createdAt: { [Op.gt]: since },
      };

      // Get user's chat IDs
      const chatParticipants = await ChatParticipant.findAll({
        where: { userId },
        attributes: ['chatId'],
      });

      const chatIds = chatParticipants.map(cp => cp.chatId);
      where.chatId = chatIds;

      const messages = await Message.findAll({
        where,
        include: [
          {
            model: require('../models').User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
        order: [['createdAt', 'ASC']],
        limit: 500,
      });

      return messages;
    } catch (error) {
      logger.error('Get messages since error:', error);
      throw error;
    }
  }

  async getReadReceiptsSince(userId, since) {
    try {
      const ReadReceipt = require('../models').ReadReceipt;

      const receipts = await ReadReceipt.findAll({
        where: {
          userId,
          readAt: { [Op.gt]: since },
        },
        include: [
          {
            model: require('../models').Message,
            attributes: ['id', 'chatId'],
          },
        ],
        order: [['readAt', 'ASC']],
      });

      return receipts;
    } catch (error) {
      logger.error('Get read receipts since error:', error);
      throw error;
    }
  }

  async getTypingIndicators(userId) {
    try {
      const TypingIndicator = require('../models').TypingIndicator;

      // Get user's chat IDs
      const chatParticipants = await ChatParticipant.findAll({
        where: { userId },
        attributes: ['chatId'],
      });

      const chatIds = chatParticipants.map(cp => cp.chatId);

      const indicators = await TypingIndicator.findAll({
        where: {
          chatId: chatIds,
          isTyping: true,
          lastTypingAt: {
            [Op.gt]: new Date(Date.now() - 10000), // Last 10 seconds
          },
        },
        include: [
          {
            model: require('../models').User,
            attributes: ['id', 'username', 'avatar'],
          },
        ],
      });

      return indicators;
    } catch (error) {
      logger.error('Get typing indicators error:', error);
      throw error;
    }
  }

  async getUnreadCounts(userId) {
    try {
      const chatService = require('./chatService');

      // Get user's chat IDs
      const chatParticipants = await ChatParticipant.findAll({
        where: { userId },
        attributes: ['chatId'],
      });

      const unreadCounts = {};

      for (const cp of chatParticipants) {
        const count = await chatService.getUnreadCount(cp.chatId, userId);
        unreadCounts[cp.chatId] = count;
      }

      return unreadCounts;
    } catch (error) {
      logger.error('Get unread counts error:', error);
      throw error;
    }
  }

  async clearChatCache(userId, chatIds) {
    try {
      const promises = chatIds.map(chatId => redisClient.del(`chat:${chatId}:messages`));

      promises.push(redisClient.del(`user:${userId}:chats`));

      await Promise.all(promises);
    } catch (error) {
      logger.error('Clear chat cache error:', error);
    }
  }

  async cleanupStaleData(days = 30) {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Clean up old pending messages
      await Message.destroy({
        where: {
          syncStatus: 'pending',
          createdAt: { [Op.lt]: cutoff },
        },
      });

      // Clean up old typing indicators
      const TypingIndicator = require('../models').TypingIndicator;
      await TypingIndicator.cleanupStale();

      logger.info('Stale data cleanup completed');
      return true;
    } catch (error) {
      logger.error('Cleanup stale data error:', error);
      throw error;
    }
  }
}

module.exports = new SyncService();
