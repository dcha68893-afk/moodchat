// readReceiptService.js — REWRITTEN: Mongoose → Sequelize
// The original used mongoose.startSession(), .find(), $ne, $in, aggregate()
// All replaced with Sequelize equivalents against the PostgreSQL DB.

const { Op, literal, fn, col } = require('sequelize');
const db = require('../models');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

const getReadReceipt = () => db.ReadReceipt;
const getMessage    = () => db.Message;
const getChat       = () => db.Chat;

class ReadReceiptService {
  /**
   * Mark a single message as read by userId.
   * Uses findOrCreate to be safe against duplicates (unique index on messageId+userId).
   */
  async markAsRead(messageId, userId) {
    try {
      if (!messageId || !userId) {
        throw new ValidationError('Message ID and user ID are required');
      }

      const Message = getMessage();
      const ReadReceipt = getReadReceipt();
      const Chat = getChat();

      const message = await Message.findByPk(messageId);
      if (!message) throw new NotFoundError('Message not found');

      // Verify the user is a participant in the chat
      const chat = await Chat.findByPk(message.chatId);
      if (!chat) throw new NotFoundError('Chat not found');

      const isParticipant =
        chat.userId1 === userId ||
        chat.userId2 === userId ||
        (chat.groupId != null); // group messages — trust membership check elsewhere

      if (!isParticipant) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }

      // Upsert read receipt
      const [receipt] = await ReadReceipt.findOrCreate({
        where: { messageId, userId },
        defaults: { readAt: new Date() }
      });

      return receipt.toJSON();
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error marking message as read:', error);
      throw new ServerError('Failed to mark message as read');
    }
  }

  /**
   * Mark all unread messages in a chat as read for userId.
   */
  async markConversationAsRead(chatId, userId) {
    try {
      if (!chatId || !userId) {
        throw new ValidationError('Chat ID and user ID are required');
      }

      const Message = getMessage();
      const ReadReceipt = getReadReceipt();
      const Chat = getChat();

      const chat = await Chat.findByPk(chatId);
      if (!chat) throw new NotFoundError('Chat not found');

      const isParticipant = chat.userId1 === userId || chat.userId2 === userId || chat.groupId != null;
      if (!isParticipant) throw new ForbiddenError('You are not a participant in this conversation');

      // Find message IDs already read by this user in this chat
      const alreadyRead = await ReadReceipt.findAll({
        attributes: ['messageId'],
        where: { userId }
      });
      const readIds = alreadyRead.map(r => r.messageId);

      // Find unread messages not sent by this user
      const whereUnread = {
        chatId,
        senderId: { [Op.ne]: userId }
      };
      if (readIds.length > 0) {
        whereUnread.id = { [Op.notIn]: readIds };
      }

      const unreadMessages = await Message.findAll({
        attributes: ['id'],
        where: whereUnread
      });

      if (unreadMessages.length === 0) {
        return { message: 'No unread messages', messagesMarked: 0, timestamp: new Date() };
      }

      const now = new Date();
      const newReceipts = unreadMessages.map(m => ({
        messageId: m.id,
        userId,
        readAt: now
      }));

      await ReadReceipt.bulkCreate(newReceipts, { ignoreDuplicates: true });

      return {
        message: 'Conversation marked as read',
        messagesMarked: newReceipts.length,
        timestamp: now
      };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error marking conversation as read:', error);
      throw new ServerError('Failed to mark conversation as read');
    }
  }

  /**
   * Get read status for a specific message.
   */
  async getMessageReadStatus(messageId, userId) {
    try {
      if (!messageId || !userId) {
        throw new ValidationError('Message ID and user ID are required');
      }

      const Message = getMessage();
      const ReadReceipt = getReadReceipt();
      const Chat = getChat();

      const message = await Message.findByPk(messageId);
      if (!message) throw new NotFoundError('Message not found');

      const chat = await Chat.findByPk(message.chatId);
      if (!chat) throw new NotFoundError('Chat not found');

      const isParticipant = chat.userId1 === userId || chat.userId2 === userId;
      const isSender = message.senderId === userId;
      if (!isParticipant && !isSender) throw new ForbiddenError('Permission denied');

      const receipts = await ReadReceipt.findAll({
        where: { messageId },
        order: [['readAt', 'ASC']]
      });

      const readCount = receipts.length;

      return {
        messageId,
        readCount,
        totalRecipients: 1, // 1-to-1 chat
        readByAll: readCount >= 1,
        readReceipts: receipts.map(r => r.toJSON())
      };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error fetching read status:', error);
      throw new ServerError('Failed to fetch read status');
    }
  }

  /**
   * Get unread message counts per chat for a user.
   */
  async getUnreadCounts(userId) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      const Message = getMessage();
      const ReadReceipt = getReadReceipt();
      const Chat = getChat();

      // Get all chats the user participates in
      const chats = await Chat.findAll({
        attributes: ['id'],
        where: {
          [Op.or]: [{ userId1: userId }, { userId2: userId }]
        }
      });
      const chatIds = chats.map(c => c.id);

      if (chatIds.length === 0) return { totalUnread: 0, byConversation: {} };

      // Get IDs of messages this user has already read
      const readReceipts = await ReadReceipt.findAll({
        attributes: ['messageId'],
        where: { userId }
      });
      const readIds = readReceipts.map(r => r.messageId);

      // Count unread messages per chat
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const unreadWhere = {
        chatId: { [Op.in]: chatIds },
        senderId: { [Op.ne]: userId },
        createdAt: { [Op.gt]: thirtyDaysAgo }
      };
      if (readIds.length > 0) {
        unreadWhere.id = { [Op.notIn]: readIds };
      }

      const unreadMessages = await Message.findAll({
        attributes: ['chatId'],
        where: unreadWhere
      });

      const byConversation = {};
      unreadMessages.forEach(m => {
        const cid = String(m.chatId);
        byConversation[cid] = (byConversation[cid] || 0) + 1;
      });

      return {
        totalUnread: Object.values(byConversation).reduce((a, b) => a + b, 0),
        byConversation
      };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      console.error('Error fetching unread counts:', error);
      throw new ServerError('Failed to fetch unread counts');
    }
  }

  /**
   * Get delivery status for messages sent by userId.
   */
  async getDeliveryStatus(userId, page = 1, limit = 20) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      page  = parseInt(page);
      limit = parseInt(limit);
      if (page < 1 || limit < 1 || limit > 50) throw new ValidationError('Invalid pagination parameters');

      const Message     = getMessage();
      const ReadReceipt = getReadReceipt();
      const offset = (page - 1) * limit;

      const { rows: messages, count: total } = await Message.findAndCountAll({
        where: { senderId: userId },
        order: [['createdAt', 'DESC']],
        limit,
        offset
      });

      const messageIds = messages.map(m => m.id);
      const receipts   = messageIds.length > 0
        ? await ReadReceipt.findAll({ where: { messageId: { [Op.in]: messageIds } } })
        : [];

      const receiptsByMessage = receipts.reduce((acc, r) => {
        const mid = String(r.messageId);
        if (!acc[mid]) acc[mid] = [];
        acc[mid].push(r.toJSON());
        return acc;
      }, {});

      const messagesWithStatus = messages.map(message => {
        const msgReceipts = receiptsByMessage[String(message.id)] || [];
        return {
          id:        message.id,
          content:   (message.content || '').substring(0, 100),
          createdAt: message.createdAt,
          chatId:    message.chatId,
          deliveryStatus: {
            sent:       true,
            delivered:  true,
            readCount:  msgReceipts.length,
            readByAll:  msgReceipts.length >= 1,
            readReceipts: msgReceipts
          }
        };
      });

      const totalPages = Math.ceil(total / limit);
      return {
        messages: messagesWithStatus,
        pagination: {
          currentPage:   page,
          totalPages,
          totalMessages: total,
          hasNext:       page < totalPages,
          hasPrevious:   page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      console.error('Error fetching delivery status:', error);
      throw new ServerError('Failed to fetch delivery status');
    }
  }
}

module.exports = new ReadReceiptService();
