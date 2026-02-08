const mongoose = require('mongoose');
const ChatParticipant = require('../models/ChatParticipant');
const Conversation = require('../models/Chats');
const User = require('../models/Users');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

/**
 * Chat Participant Service
 * Handles participant management in conversations
 */
class ChatParticipantService {
  /**
   * Add participant to conversation
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID adding participant
   * @param {Array<string>} participantIds - IDs of users to add
   * @returns {Promise<Object>} Updated conversation
   */
  async addParticipants(conversationId, userId, participantIds) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!conversationId || !userId || !participantIds?.length) {
        throw new ValidationError('Conversation ID, user ID, and participant IDs are required');
      }

      const conversation = await Conversation.findById(conversationId).session(session);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      // Check if user is participant or has permission
      const isParticipant = conversation.participants.some(p => p.toString() === userId);
      const isGroupConversation = conversation.type === 'group';
      
      if (!isParticipant && !isGroupConversation) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }

      // Remove duplicates and existing participants
      const existingParticipantIds = conversation.participants.map(p => p.toString());
      const uniqueNewParticipantIds = [...new Set(participantIds)].filter(
        id => !existingParticipantIds.includes(id)
      );

      if (uniqueNewParticipantIds.length === 0) {
        throw new ValidationError('All users are already participants');
      }

      // Verify users exist
      const users = await User.find({
        _id: { $in: uniqueNewParticipantIds }
      }).session(session);

      if (users.length !== uniqueNewParticipantIds.length) {
        throw new NotFoundError('One or more users not found');
      }

      // Add participants
      const participantObjectIds = uniqueNewParticipantIds.map(id => new mongoose.Types.ObjectId(id));
      conversation.participants.push(...participantObjectIds);
      
      // Update last activity
      conversation.lastActivity = new Date();
      
      await conversation.save({ session });

      // Create participant records
      const participantDocs = participantObjectIds.map(participantId => ({
        conversationId: conversation._id,
        userId: participantId,
        joinedAt: new Date(),
        role: participantId.toString() === userId ? 'admin' : 'member'
      }));

      await ChatParticipant.insertMany(participantDocs, { session });

      await session.commitTransaction();

      await conversation.populate([
        { path: 'participants', select: '_id username email profilePicture' },
        { path: 'createdBy', select: '_id username email profilePicture' }
      ]);

      return conversation;
    } catch (error) {
      await session.abortTransaction();

      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error adding participants:', error);
      throw new ServerError('Failed to add participants');
    } finally {
      session.endSession();
    }
  }

  /**
   * Remove participant from conversation
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID removing participant
   * @param {Array<string>} participantIds - IDs of users to remove
   * @returns {Promise<Object>} Updated conversation
   */
  async removeParticipants(conversationId, userId, participantIds) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!conversationId || !userId || !participantIds?.length) {
        throw new ValidationError('Conversation ID, user ID, and participant IDs are required');
      }

      const conversation = await Conversation.findById(conversationId).session(session);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      // Check if user has permission (must be participant)
      const isParticipant = conversation.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }

      // Prevent removing all participants
      if (participantIds.includes(userId) && conversation.participants.length <= participantIds.length) {
        throw new ValidationError('Cannot remove all participants from conversation');
      }

      // Remove participants
      const participantObjectIds = participantIds.map(id => new mongoose.Types.ObjectId(id));
      
      conversation.participants = conversation.participants.filter(
        participantId => !participantObjectIds.some(id => id.equals(participantId))
      );

      // Update last activity
      conversation.lastActivity = new Date();
      await conversation.save({ session });

      // Remove participant records
      await ChatParticipant.deleteMany({
        conversationId: conversation._id,
        userId: { $in: participantObjectIds }
      }).session(session);

      await session.commitTransaction();

      await conversation.populate([
        { path: 'participants', select: '_id username email profilePicture' },
        { path: 'createdBy', select: '_id username email profilePicture' }
      ]);

      return conversation;
    } catch (error) {
      await session.abortTransaction();

      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error removing participants:', error);
      throw new ServerError('Failed to remove participants');
    } finally {
      session.endSession();
    }
  }

  /**
   * Get conversation participants
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID for permission check
   * @returns {Promise<Array>} List of participants
   */
  async getParticipants(conversationId, userId) {
    try {
      if (!conversationId || !userId) {
        throw new ValidationError('Conversation ID and user ID are required');
      }

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      // Check if user is participant
      const isParticipant = conversation.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }

      const participants = await ChatParticipant.find({ conversationId })
        .populate('userId', '_id username email profilePicture status lastSeen')
        .sort({ joinedAt: 1 });

      return participants;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching participants:', error);
      throw new ServerError('Failed to fetch participants');
    }
  }

  /**
   * Update participant role
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID making the change
   * @param {string} targetUserId - User ID to update
   * @param {string} role - New role (admin/member)
   * @returns {Promise<Object>} Updated participant
   */
  async updateParticipantRole(conversationId, userId, targetUserId, role) {
    try {
      if (!conversationId || !userId || !targetUserId || !role) {
        throw new ValidationError('All fields are required');
      }

      if (!['admin', 'member'].includes(role)) {
        throw new ValidationError('Role must be either "admin" or "member"');
      }

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }

      // Check if user is admin
      const userParticipant = await ChatParticipant.findOne({
        conversationId,
        userId
      });

      if (!userParticipant || userParticipant.role !== 'admin') {
        throw new ForbiddenError('Only admins can update participant roles');
      }

      // Check if target user is participant
      const targetParticipant = await ChatParticipant.findOne({
        conversationId,
        userId: targetUserId
      });

      if (!targetParticipant) {
        throw new NotFoundError('Target user is not a participant in this conversation');
      }

      // Update role
      targetParticipant.role = role;
      await targetParticipant.save();

      await targetParticipant.populate('userId', '_id username email profilePicture');

      return targetParticipant;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error updating participant role:', error);
      throw new ServerError('Failed to update participant role');
    }
  }

  /**
   * Get user's conversations
   * @param {string} userId - User ID
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Conversations and pagination info
   */
  async getUserConversations(userId, page = 1, limit = 20) {
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

      // Get conversations where user is a participant
      const [participantRecords, total] = await Promise.all([
        ChatParticipant.find({ userId })
          .sort({ lastActive: -1 })
          .skip(skip)
          .limit(limit)
          .populate({
            path: 'conversationId',
            populate: [
              { path: 'participants', select: '_id username profilePicture' },
              { path: 'createdBy', select: '_id username profilePicture' }
            ]
          }),
        ChatParticipant.countDocuments({ userId })
      ]);

      const conversations = participantRecords.map(record => record.conversationId);
      const totalPages = Math.ceil(total / limit);

      return {
        conversations,
        pagination: {
          currentPage: page,
          totalPages,
          totalConversations: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching user conversations:', error);
      throw new ServerError('Failed to fetch user conversations');
    }
  }
}

module.exports = new ChatParticipantService();