const chatParticipantService = require('../services/chatParticipantService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class ChatParticipantController {
  /**
   * Get chat participants
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getChatParticipants(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        onlineOnly = false,
        includeSelf = true,
        sortBy = 'joinedAt',
        sortOrder = 'desc'
      } = req.query;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        onlineOnly: onlineOnly === 'true',
        includeSelf: includeSelf === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await chatParticipantService.getChatParticipants(chatId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Chat participants retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get chat participants controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get chat participants', 500));
      }
    }
  }

  /**
   * Add participant to chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async addParticipantToChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { participantId } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      if (!participantId) {
        throw new AppError('Participant ID is required', 400);
      }

      const participant = await chatParticipantService.addParticipantToChat(chatId, userId, participantId);

      // Emit WebSocket event for new participant
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('chat:participant:added', {
          chatId,
          participantId,
          addedBy: userId,
          timestamp: new Date()
        });
        
        // Notify the new participant
        req.io.to(`user:${participantId}`).emit('chat:added', {
          chatId,
          addedBy: userId,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Participant added to chat successfully',
        data: {
          participant
        }
      });
    } catch (error) {
      logger.error('Add participant to chat controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already a participant')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('blocked')) {
        next(new AppError('Cannot add blocked user to chat', 403));
      } else if (error.message.includes('direct chat')) {
        next(new AppError('Cannot add more participants to a direct chat', 400));
      } else {
        next(new AppError('Failed to add participant to chat', 500));
      }
    }
  }

  /**
   * Remove participant from chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async removeParticipantFromChat(req, res, next) {
    try {
      const { chatId, participantId } = req.params;
      const userId = req.user.id;

      if (!chatId || !participantId) {
        throw new AppError('Chat ID and Participant ID are required', 400);
      }

      const result = await chatParticipantService.removeParticipantFromChat(chatId, userId, participantId);

      // Emit WebSocket events
      if (req.io) {
        // Notify chat about removal
        req.io.to(`chat:${chatId}`).emit('chat:participant:removed', {
          chatId,
          participantId,
          removedBy: userId,
          timestamp: new Date()
        });
        
        // Notify removed participant
        req.io.to(`user:${participantId}`).emit('chat:removed', {
          chatId,
          removedBy: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Participant removed from chat successfully',
        data: {
          ...result,
          chatId,
          participantId
        }
      });
    } catch (error) {
      logger.error('Remove participant from chat controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('cannot remove') || error.message.includes('last participant')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to remove participant from chat', 500));
      }
    }
  }

  /**
   * Get participant details
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getParticipantDetails(req, res, next) {
    try {
      const { chatId, participantId } = req.params;
      const userId = req.user.id;

      if (!chatId || !participantId) {
        throw new AppError('Chat ID and Participant ID are required', 400);
      }

      const participant = await chatParticipantService.getParticipantDetails(chatId, participantId, userId);

      res.status(200).json({
        success: true,
        message: 'Participant details retrieved successfully',
        data: {
          participant
        }
      });
    } catch (error) {
      logger.error('Get participant details controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get participant details', 500));
      }
    }
  }

  /**
   * Update participant settings
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateParticipantSettings(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { 
        notifications = true,
        sound = true,
        vibration = true,
        customName,
        color
      } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const settings = {
        notifications,
        sound,
        vibration,
        customName,
        color
      };

      const participant = await chatParticipantService.updateParticipantSettings(chatId, userId, settings);

      res.status(200).json({
        success: true,
        message: 'Participant settings updated successfully',
        data: {
          participant,
          settings: participant.settings
        }
      });
    } catch (error) {
      logger.error('Update participant settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to update participant settings', 500));
      }
    }
  }

  /**
   * Leave chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async leaveChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const result = await chatParticipantService.leaveChat(chatId, userId);

      // Emit WebSocket events
      if (req.io) {
        // Notify chat about participant leaving
        req.io.to(`chat:${chatId}`).emit('chat:participant:left', {
          chatId,
          participantId: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Successfully left the chat',
        data: {
          ...result,
          left: true
        }
      });
    } catch (error) {
      logger.error('Leave chat controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('last participant')) {
        next(new AppError('Cannot leave as the last participant. Delete the chat instead.', 400));
      } else {
        next(new AppError('Failed to leave chat', 500));
      }
    }
  }

  /**
   * Mute chat notifications
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async muteChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { duration, muteType = 'all' } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      if (!duration) {
        throw new AppError('Duration is required', 400);
      }

      const mute = await chatParticipantService.muteChat(chatId, userId, duration, muteType);

      res.status(200).json({
        success: true,
        message: 'Chat muted successfully',
        data: {
          mute,
          muted: true,
          expiresAt: mute.expiresAt
        }
      });
    } catch (error) {
      logger.error('Mute chat controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('already muted')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to mute chat', 500));
      }
    }
  }

  /**
   * Unmute chat notifications
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async unmuteChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const result = await chatParticipantService.unmuteChat(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Chat unmuted successfully',
        data: {
          ...result,
          muted: false
        }
      });
    } catch (error) {
      logger.error('Unmute chat controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not muted')) {
        next(new AppError('Chat is not muted', 404));
      } else {
        next(new AppError('Failed to unmute chat', 500));
      }
    }
  }

  /**
   * Get participant's read status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getReadStatus(req, res, next) {
    try {
      const { chatId, participantId } = req.params;
      const userId = req.user.id;

      if (!chatId || !participantId) {
        throw new AppError('Chat ID and Participant ID are required', 400);
      }

      const readStatus = await chatParticipantService.getReadStatus(chatId, participantId, userId);

      res.status(200).json({
        success: true,
        message: 'Read status retrieved successfully',
        data: {
          readStatus
        }
      });
    } catch (error) {
      logger.error('Get read status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get read status', 500));
      }
    }
  }

  /**
   * Update last read message
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateLastRead(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { lastReadMessageId } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      if (!lastReadMessageId) {
        throw new AppError('Last read message ID is required', 400);
      }

      const readStatus = await chatParticipantService.updateLastRead(chatId, userId, lastReadMessageId);

      // Emit WebSocket event for read status update
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('chat:read:updated', {
          chatId,
          participantId: userId,
          lastReadMessageId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Last read message updated successfully',
        data: {
          readStatus
        }
      });
    } catch (error) {
      logger.error('Update last read controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to update last read message', 500));
      }
    }
  }

  /**
   * Get participant's typing status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getTypingStatus(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const typingStatus = await chatParticipantService.getTypingStatus(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Typing status retrieved successfully',
        data: {
          typingStatus,
          isTyping: typingStatus.isTyping,
          lastTypingAt: typingStatus.lastTypingAt
        }
      });
    } catch (error) {
      logger.error('Get typing status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to get typing status', 500));
      }
    }
  }

  /**
   * Update typing status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateTypingStatus(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { isTyping } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      if (typeof isTyping !== 'boolean') {
        throw new AppError('isTyping must be a boolean', 400);
      }

      const typingStatus = await chatParticipantService.updateTypingStatus(chatId, userId, isTyping);

      // Emit WebSocket event for typing status
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('chat:typing', {
          chatId,
          participantId: userId,
          isTyping,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: `Typing status ${isTyping ? 'started' : 'stopped'} successfully`,
        data: {
          typingStatus
        }
      });
    } catch (error) {
      logger.error('Update typing status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to update typing status', 500));
      }
    }
  }

  /**
   * Get participant's presence status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getPresenceStatus(req, res, next) {
    try {
      const { chatId, participantId } = req.params;
      const userId = req.user.id;

      if (!chatId || !participantId) {
        throw new AppError('Chat ID and Participant ID are required', 400);
      }

      const presence = await chatParticipantService.getPresenceStatus(chatId, participantId, userId);

      res.status(200).json({
        success: true,
        message: 'Presence status retrieved successfully',
        data: {
          presence
        }
      });
    } catch (error) {
      logger.error('Get presence status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get presence status', 500));
      }
    }
  }

  /**
   * Update participant's presence
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updatePresence(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { isActive, lastSeen } = req.body;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const presence = await chatParticipantService.updatePresence(chatId, userId, {
        isActive,
        lastSeen: lastSeen ? new Date(lastSeen) : new Date()
      });

      // Emit WebSocket event for presence update
      if (req.io) {
        req.io.to(`chat:${chatId}`).emit('chat:presence', {
          chatId,
          participantId: userId,
          isActive,
          lastSeen: presence.lastSeen,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Presence updated successfully',
        data: {
          presence
        }
      });
    } catch (error) {
      logger.error('Update presence controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to update presence', 500));
      }
    }
  }

  /**
   * Check if user is participant in chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async checkParticipant(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const isParticipant = await chatParticipantService.isParticipant(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Participant check completed',
        data: {
          chatId,
          userId,
          isParticipant,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error('Check participant controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to check participant status', 500));
      }
    }
  }

  /**
   * Get participant statistics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getParticipantStatistics(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const statistics = await chatParticipantService.getParticipantStatistics(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Participant statistics retrieved successfully',
        data: {
          statistics
        }
      });
    } catch (error) {
      logger.error('Get participant statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get participant statistics', 500));
      }
    }
  }

  /**
   * Search participants in chat
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async searchParticipants(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;
      const { 
        query,
        page = 1, 
        limit = 20,
        onlineOnly = false,
        sortBy = 'relevance',
        sortOrder = 'desc'
      } = req.query;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      if (!query) {
        throw new AppError('Search query is required', 400);
      }

      const options = {
        query,
        page: parseInt(page),
        limit: parseInt(limit),
        onlineOnly: onlineOnly === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await chatParticipantService.searchParticipants(chatId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Participants search completed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Search participants controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to search participants', 500));
      }
    }
  }

  /**
   * Get online participants
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getOnlineParticipants(req, res, next) {
    try {
      const { chatId } = req.params;
      const userId = req.user.id;

      if (!chatId) {
        throw new AppError('Chat ID is required', 400);
      }

      const onlineParticipants = await chatParticipantService.getOnlineParticipants(chatId, userId);

      res.status(200).json({
        success: true,
        message: 'Online participants retrieved successfully',
        data: {
          onlineParticipants,
          count: onlineParticipants.length,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error('Get online participants controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get online participants', 500));
      }
    }
  }
}

module.exports = new ChatParticipantController();