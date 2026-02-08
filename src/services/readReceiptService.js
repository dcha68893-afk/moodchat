const mongoose = require('mongoose');
const ReadReceipt = require('../models/ReadReceipt');
const Message = require('../models/Message');
const Conversation = require('../models/Chats');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

/**
 * Read Receipt Service
 * Handles message read receipts and delivery status
 */
class ReadReceiptService {
  /**
   * Mark message as read
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Read receipt
   */
  async markAsRead(messageId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!messageId || !userId) {
        throw new ValidationError('Message ID and user ID are required');
      }

      const message = await Message.findById(messageId).session(session);
      if (!message) {
        throw new NotFoundError('Message not found');
      }

      // Check if user is participant in conversation
      const conversation = await Conversation.findById(message.conversationId).session(session);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      const isParticipant = conversation.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }

      // Check if already marked as read
      const existingReceipt = await ReadReceipt.findOne({
        messageId,
        userId
      }).session(session);

      if (existingReceipt) {
        return existingReceipt;
      }

      // Create read receipt
      const readReceipt = new ReadReceipt({
        messageId,
        userId,
        readAt: new Date(),
        conversationId: message.conversationId
      });

      await readReceipt.save({ session });

      // Update message read count
      const readCount = await ReadReceipt.countDocuments({
        messageId,
        readAt: { $ne: null }
      }).session(session);

      const totalParticipants = conversation.participants.length;
      
      // If all participants have read, mark message as completely read
      if (readCount >= totalParticipants - 1) { // -1 for sender
        message.readByAll = true;
        message.fullyReadAt = new Date();
        await message.save({ session });
      }

      await session.commitTransaction();

      await readReceipt.populate('userId', '_id username profilePicture');

      return readReceipt;
    } catch (error) {
      await session.abortTransaction();

      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error marking message as read:', error);
      throw new ServerError('Failed to mark message as read');
    } finally {
      session.endSession();
    }
  }

  /**
   * Mark conversation as read
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Result with count
   */
  async markConversationAsRead(conversationId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!conversationId || !userId) {
        throw new ValidationError('Conversation ID and user ID are required');
      }

      const conversation = await Conversation.findById(conversationId).session(session);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      const isParticipant = conversation.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }

      // Find all unread messages for this user in conversation
      const unreadMessages = await Message.find({
        conversationId,
        sender: { $ne: userId },
        _id: {
          $nin: await ReadReceipt.distinct('messageId', {
            userId,
            readAt: { $ne: null }
          })
        }
      }).session(session);

      // Create read receipts for all unread messages
      const readReceipts = unreadMessages.map(message => ({
        messageId: message._id,
        userId,
        readAt: new Date(),
        conversationId
      }));

      if (readReceipts.length > 0) {
        await ReadReceipt.insertMany(readReceipts, { session });
      }

      // Update conversation last read time for user
      // This would be stored in a separate collection if tracking per user
      conversation.lastActivity = new Date();
      await conversation.save({ session });

      await session.commitTransaction();

      return {
        message: 'Conversation marked as read',
        messagesMarked: readReceipts.length,
        timestamp: new Date()
      };
    } catch (error) {
      await session.abortTransaction();

      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error marking conversation as read:', error);
      throw new ServerError('Failed to mark conversation as read');
    } finally {
      session.endSession();
    }
  }

  /**
   * Get message read status
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID (must be sender or participant)
   * @returns {Promise<Object>} Read status information
   */
  async getMessageReadStatus(messageId, userId) {
    try {
      if (!messageId || !userId) {
        throw new ValidationError('Message ID and user ID are required');
      }

      const message = await Message.findById(messageId);
      if (!message) {
        throw new NotFoundError('Message not found');
      }

      // Check if user is sender or participant
      const conversation = await Conversation.findById(message.conversationId);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      const isParticipant = conversation.participants.some(p => p.toString() === userId);
      const isSender = message.sender.toString() === userId;

      if (!isParticipant && !isSender) {
        throw new ForbiddenError('You do not have permission to view read status');
      }

      // Get all read receipts for this message
      const readReceipts = await ReadReceipt.find({ messageId })
        .populate('userId', '_id username profilePicture')
        .sort({ readAt: 1 });

      const totalParticipants = conversation.participants.length;
      const readCount = readReceipts.length;
      
      // Get list of users who haven't read
      const readUserIds = readReceipts.map(receipt => receipt.userId.toString());
      const unreadUserIds = conversation.participants
        .filter(p => p.toString() !== message.sender.toString()) // Exclude sender
        .filter(p => !readUserIds.includes(p.toString()))
        .map(p => p.toString());

      return {
        messageId,
        readCount,
        totalRecipients: totalParticipants - 1, // Exclude sender
        readByAll: message.readByAll || false,
        fullyReadAt: message.fullyReadAt,
        readReceipts,
        unreadUserIds
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching read status:', error);
      throw new ServerError('Failed to fetch read status');
    }
  }

  /**
   * Get unread message count for user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Unread counts
   */
  async getUnreadCounts(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Get conversations where user is participant
      const conversations = await Conversation.find({
        participants: userId
      }).select('_id type');

      const conversationIds = conversations.map(c => c._id);

      // Count unread messages per conversation
      const unreadCounts = await Message.aggregate([
        {
          $match: {
            conversationId: { $in: conversationIds },
            sender: { $ne: new mongoose.Types.ObjectId(userId) },
            createdAt: {
              $gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
          }
        },
        {
          $lookup: {
            from: 'readreceipts',
            let: { messageId: '$_id', userId: new mongoose.Types.ObjectId(userId) },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$messageId', '$$messageId'] },
                      { $eq: ['$userId', '$$userId'] }
                    ]
                  }
                }
              }
            ],
            as: 'readReceipts'
          }
        },
        {
          $match: {
            readReceipts: { $size: 0 }
          }
        },
        {
          $group: {
            _id: '$conversationId',
            count: { $sum: 1 }
          }
        }
      ]);

      // Format result
      const result = {
        totalUnread: unreadCounts.reduce((sum, item) => sum + item.count, 0),
        byConversation: unreadCounts.reduce((acc, item) => {
          acc[item._id.toString()] = item.count;
          return acc;
        }, {})
      };

      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching unread counts:', error);
      throw new ServerError('Failed to fetch unread counts');
    }
  }

  /**
   * Get delivery status for sent messages
   * @param {string} userId - User ID
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Delivery status
   */
  async getDeliveryStatus(userId, page = 1, limit = 20) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      page = parseInt(page);
      limit = parseInt(limit);

      if (page < 1 || limit < 1 || limit > 50) {
        throw new ValidationError('Invalid pagination parameters');
      }

      const skip = (page - 1) * limit;

      // Get messages sent by user
      const [messages, total] = await Promise.all([
        Message.find({ sender: userId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate('conversationId', '_id type name'),
        Message.countDocuments({ sender: userId })
      ]);

      // Get read status for each message
      const messageIds = messages.map(m => m._id);
      const readReceipts = await ReadReceipt.find({
        messageId: { $in: messageIds }
      }).populate('userId', '_id username profilePicture');

      // Group receipts by message
      const receiptsByMessage = readReceipts.reduce((acc, receipt) => {
        const messageId = receipt.messageId.toString();
        if (!acc[messageId]) {
          acc[messageId] = [];
        }
        acc[messageId].push(receipt);
        return acc;
      }, {});

      // Format response with delivery status
      const messagesWithStatus = messages.map(message => {
        const receipts = receiptsByMessage[message._id.toString()] || [];
        const conversation = message.conversationId;
        
        // Get total recipients (all participants except sender)
        const totalRecipients = conversation?.participants?.length 
          ? conversation.participants.filter(p => p.toString() !== userId).length
          : 0;

        return {
          _id: message._id,
          content: message.content.substring(0, 100) + (message.content.length > 100 ? '...' : ''),
          createdAt: message.createdAt,
          conversation: {
            _id: conversation?._id,
            type: conversation?.type,
            name: conversation?.name
          },
          deliveryStatus: {
            sent: true,
            delivered: true, // Assuming delivered if saved in DB
            readCount: receipts.length,
            totalRecipients,
            readPercentage: totalRecipients > 0 ? Math.round((receipts.length / totalRecipients) * 100) : 0,
            readByAll: message.readByAll || false,
            readReceipts: receipts.map(r => ({
              userId: r.userId._id,
              username: r.userId.username,
              profilePicture: r.userId.profilePicture,
              readAt: r.readAt
            }))
          }
        };
      });

      const totalPages = Math.ceil(total / limit);

      return {
        messages: messagesWithStatus,
        pagination: {
          currentPage: page,
          totalPages,
          totalMessages: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching delivery status:', error);
      throw new ServerError('Failed to fetch delivery status');
    }
  }
}

module.exports = new ReadReceiptService();