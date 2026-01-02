const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Chat');
const { ServerError, ValidationError, NotFoundError } = require('../utils/errors');
const { MESSAGE_LIMIT_PER_PAGE } = process.env;

/**
 * Message Service
 * Handles all business logic for messaging operations
 */
class MessageService {
  /**
   * Create a new message
   * @param {Object} messageData - Message data including sender, conversationId, content
   * @returns {Promise<Object>} Created message
   */
  async createMessage(messageData) {
    try {
      const { sender, conversationId, content, type = 'text' } = messageData;

      // Validate required fields
      if (!sender || !conversationId || !content) {
        throw new ValidationError('Sender, conversationId, and content are required');
      }

      // Check if conversation exists
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      // Verify sender is part of the conversation
      if (!conversation.participants.includes(sender)) {
        throw new ValidationError('Sender is not a participant in this conversation');
      }

      // Validate message type
      const validTypes = ['text', 'image', 'file', 'system'];
      if (!validTypes.includes(type)) {
        throw new ValidationError('Invalid message type');
      }

      // Validate content length for text messages
      if (type === 'text' && content.length > 5000) {
        throw new ValidationError('Message content too long');
      }

      // Create message
      const message = new Message({
        sender: new mongoose.Types.ObjectId(sender),
        conversationId: new mongoose.Types.ObjectId(conversationId),
        content,
        type,
        readBy: [sender], // Sender has read their own message
      });

      const savedMessage = await message.save();

      // Update conversation's last message and timestamp
      conversation.lastMessage = savedMessage._id;
      conversation.lastMessageAt = savedMessage.createdAt;
      await conversation.save();

      // Populate sender details for response
      await savedMessage.populate({
        path: 'sender',
        select: '_id username email profilePicture',
      });

      return savedMessage;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error creating message:', error);
      throw new ServerError('Failed to create message');
    }
  }

  /**
   * Get messages for a conversation with pagination
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID for read status
   * @param {number} page - Page number (starting from 1)
   * @param {number} limit - Messages per page
   * @returns {Promise<Object>} Messages and pagination info
   */
  async getConversationMessages(
    conversationId,
    userId,
    page = 1,
    limit = MESSAGE_LIMIT_PER_PAGE || 50
  ) {
    try {
      // Validate parameters
      if (!conversationId || !userId) {
        throw new ValidationError('Conversation ID and user ID are required');
      }

      page = parseInt(page);
      limit = parseInt(limit);

      if (page < 1 || limit < 1 || limit > 100) {
        throw new ValidationError('Invalid pagination parameters');
      }

      // Check if conversation exists and user is a participant
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      if (!conversation.participants.includes(userId)) {
        throw new ValidationError('User is not a participant in this conversation');
      }

      // Calculate skip value for pagination
      const skip = (page - 1) * limit;

      // Fetch messages with population
      const messages = await Message.find({ conversationId })
        .sort({ createdAt: -1 }) // Latest messages first
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'sender',
          select: '_id username email profilePicture',
        })
        .lean();

      // Update read status for messages not read by this user
      const unreadMessageIds = messages
        .filter(msg => !msg.readBy.includes(userId))
        .map(msg => msg._id);

      if (unreadMessageIds.length > 0) {
        await Message.updateMany(
          { _id: { $in: unreadMessageIds } },
          { $addToSet: { readBy: userId } }
        );

        // Update read status in the returned messages
        messages.forEach(msg => {
          if (unreadMessageIds.includes(msg._id)) {
            msg.readBy.push(userId);
          }
        });
      }

      // Get total count for pagination metadata
      const totalMessages = await Message.countDocuments({ conversationId });
      const totalPages = Math.ceil(totalMessages / limit);

      return {
        messages: messages.reverse(), // Return in chronological order
        pagination: {
          currentPage: page,
          totalPages,
          totalMessages,
          hasNext: page < totalPages,
          hasPrevious: page > 1,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error fetching messages:', error);
      throw new ServerError('Failed to fetch messages');
    }
  }

  /**
   * Mark messages as read
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID marking as read
   * @param {Array<string>} messageIds - Specific message IDs to mark as read (optional)
   * @returns {Promise<Object>} Update result
   */
  async markMessagesAsRead(conversationId, userId, messageIds = null) {
    try {
      if (!conversationId || !userId) {
        throw new ValidationError('Conversation ID and user ID are required');
      }

      // Build query
      const query = { conversationId };
      if (messageIds && messageIds.length > 0) {
        query._id = { $in: messageIds.map(id => new mongoose.Types.ObjectId(id)) };
      } else {
        // Mark all unread messages in conversation as read
        query.readBy = { $ne: userId };
      }

      // Update messages
      const result = await Message.updateMany(query, { $addToSet: { readBy: userId } });

      return {
        success: true,
        modifiedCount: result.modifiedCount,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error marking messages as read:', error);
      throw new ServerError('Failed to mark messages as read');
    }
  }

  /**
   * Delete a message (soft delete)
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID requesting deletion
   * @returns {Promise<Object>} Deletion result
   */
  async deleteMessage(messageId, userId) {
    try {
      if (!messageId || !userId) {
        throw new ValidationError('Message ID and user ID are required');
      }

      const message = await Message.findById(messageId);
      if (!message) {
        throw new NotFoundError('Message not found');
      }

      // Check if user is the sender
      if (message.sender.toString() !== userId) {
        throw new ValidationError('Only the sender can delete this message');
      }

      // Soft delete by marking as deleted
      message.deleted = true;
      message.deletedAt = new Date();
      await message.save();

      return {
        success: true,
        message: 'Message deleted successfully',
      };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error deleting message:', error);
      throw new ServerError('Failed to delete message');
    }
  }

  /**
   * Get unread message count for a user across all conversations
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Unread counts per conversation
   */
  async getUnreadCounts(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Get all conversations where user is a participant
      const conversations = await Conversation.find({
        participants: userId,
      }).select('_id');

      const conversationIds = conversations.map(conv => conv._id);

      // Aggregate unread counts per conversation
      const unreadCounts = await Message.aggregate([
        {
          $match: {
            conversationId: { $in: conversationIds },
            readBy: { $ne: new mongoose.Types.ObjectId(userId) },
            sender: { $ne: new mongoose.Types.ObjectId(userId) }, // Don't count own messages
          },
        },
        {
          $group: {
            _id: '$conversationId',
            count: { $sum: 1 },
          },
        },
      ]);

      // Format results
      const result = {};
      unreadCounts.forEach(item => {
        result[item._id.toString()] = item.count;
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error getting unread counts:', error);
      throw new ServerError('Failed to get unread message counts');
    }
  }

  /**
   * Search messages within a conversation
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @param {string} query - Search query
   * @param {number} limit - Maximum results
   * @returns {Promise<Array>} Search results
   */
  async searchMessages(conversationId, userId, query, limit = 20) {
    try {
      if (!conversationId || !userId || !query) {
        throw new ValidationError('Conversation ID, user ID, and search query are required');
      }

      // Verify user is part of conversation
      const conversation = await Conversation.findById(conversationId);
      if (!conversation || !conversation.participants.includes(userId)) {
        throw new ValidationError('User cannot access this conversation');
      }

      // Search for messages with text content matching query
      const messages = await Message.find({
        conversationId,
        type: 'text',
        content: { $regex: query, $options: 'i' },
        deleted: { $ne: true }, // Exclude deleted messages
      })
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .populate({
          path: 'sender',
          select: '_id username profilePicture',
        })
        .lean();

      return messages;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error searching messages:', error);
      throw new ServerError('Failed to search messages');
    }
  }
}

module.exports = new MessageService();
