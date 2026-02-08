const groupMembersService = require('../services/groupMembersService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class GroupMembersController {
  /**
   * Get group members
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getGroupMembers(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        role,
        onlineOnly = false,
        search,
        sortBy = 'joinedAt',
        sortOrder = 'desc'
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        role,
        onlineOnly: onlineOnly === 'true',
        search,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupMembersService.getGroupMembers(groupId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Group members retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get group members controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get group members', 500));
      }
    }
  }

  /**
   * Add member to group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async addMemberToGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { memberId, role = 'member', sendNotification = true } = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!memberId) {
        throw new AppError('Member ID is required', 400);
      }

      const member = await groupMembersService.addMemberToGroup(groupId, userId, memberId, role, sendNotification);

      // Emit WebSocket event for new member
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:member:added', {
          groupId,
          memberId,
          addedBy: userId,
          role,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Member added to group successfully',
        data: {
          member
        }
      });
    } catch (error) {
      logger.error('Add member to group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already a member')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('banned')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('maximum members')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to add member to group', 500));
      }
    }
  }

  /**
   * Remove member from group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async removeMemberFromGroup(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;
      const { reason } = req.body;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const result = await groupMembersService.removeMemberFromGroup(groupId, userId, memberId, reason);

      // Emit WebSocket event for member removal
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:member:removed', {
          groupId,
          memberId,
          removedBy: userId,
          reason,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Member removed from group successfully',
        data: {
          ...result,
          groupId,
          memberId
        }
      });
    } catch (error) {
      logger.error('Remove member from group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('cannot remove') || error.message.includes('creator')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to remove member from group', 500));
      }
    }
  }

  /**
   * Update member role
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateMemberRole(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;
      const { role } = req.body;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      if (!role) {
        throw new AppError('Role is required', 400);
      }

      const validRoles = ['member', 'moderator', 'admin', 'creator'];
      if (!validRoles.includes(role)) {
        throw new AppError(`Invalid role. Valid values: ${validRoles.join(', ')}`, 400);
      }

      const member = await groupMembersService.updateMemberRole(groupId, userId, memberId, role);

      // Emit WebSocket event for role update
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:member:role:updated', {
          groupId,
          memberId,
          newRole: role,
          updatedBy: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Member role updated successfully',
        data: {
          member
        }
      });
    } catch (error) {
      logger.error('Update member role controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('cannot update role')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to update member role', 500));
      }
    }
  }

  /**
   * Get member details
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMemberDetails(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const member = await groupMembersService.getMemberDetails(groupId, memberId, userId);

      res.status(200).json({
        success: true,
        message: 'Member details retrieved successfully',
        data: {
          member
        }
      });
    } catch (error) {
      logger.error('Get member details controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get member details', 500));
      }
    }
  }

  /**
   * Get pending invitations
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getPendingInvitations(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupMembersService.getPendingInvitations(groupId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Pending invitations retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get pending invitations controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get pending invitations', 500));
      }
    }
  }

  /**
   * Invite user to group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async inviteToGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { inviteeId, role = 'member', message } = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!inviteeId) {
        throw new AppError('Invitee ID is required', 400);
      }

      const invitation = await groupMembersService.inviteToGroup(groupId, userId, inviteeId, role, message);

      // Emit WebSocket event for invitation
      if (req.io) {
        req.io.to(`user:${inviteeId}`).emit('group:invitation:received', {
          groupId,
          invitationId: invitation.id,
          invitedBy: userId,
          role,
          message,
          timestamp: new Date()
        });
      }

      res.status(201).json({
        success: true,
        message: 'Invitation sent successfully',
        data: {
          invitation
        }
      });
    } catch (error) {
      logger.error('Invite to group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already invited') || error.message.includes('already a member')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('banned')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to send invitation', 500));
      }
    }
  }

  /**
   * Accept group invitation
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async acceptInvitation(req, res, next) {
    try {
      const { invitationId } = req.params;
      const userId = req.user.id;

      if (!invitationId) {
        throw new AppError('Invitation ID is required', 400);
      }

      const result = await groupMembersService.acceptInvitation(invitationId, userId);

      // Emit WebSocket events for acceptance
      if (req.io) {
        // Notify group about new member
        req.io.to(`group:${result.groupId}`).emit('group:member:joined', {
          groupId: result.groupId,
          memberId: userId,
          viaInvitation: true,
          timestamp: new Date()
        });

        // Notify inviter
        req.io.to(`user:${result.invitedBy}`).emit('group:invitation:accepted', {
          groupId: result.groupId,
          inviteeId: userId,
          invitationId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Invitation accepted successfully',
        data: {
          ...result,
          accepted: true
        }
      });
    } catch (error) {
      logger.error('Accept invitation controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already accepted') || error.message.includes('expired')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to accept invitation', 500));
      }
    }
  }

  /**
   * Reject group invitation
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async rejectInvitation(req, res, next) {
    try {
      const { invitationId } = req.params;
      const userId = req.user.id;
      const { reason } = req.body;

      if (!invitationId) {
        throw new AppError('Invitation ID is required', 400);
      }

      const result = await groupMembersService.rejectInvitation(invitationId, userId, reason);

      // Emit WebSocket event for rejection
      if (req.io && result.invitedBy) {
        req.io.to(`user:${result.invitedBy}`).emit('group:invitation:rejected', {
          groupId: result.groupId,
          inviteeId: userId,
          invitationId,
          reason,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Invitation rejected successfully',
        data: {
          ...result,
          rejected: true
        }
      });
    } catch (error) {
      logger.error('Reject invitation controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already responded')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to reject invitation', 500));
      }
    }
  }

  /**
   * Cancel invitation
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async cancelInvitation(req, res, next) {
    try {
      const { invitationId } = req.params;
      const userId = req.user.id;

      if (!invitationId) {
        throw new AppError('Invitation ID is required', 400);
      }

      const result = await groupMembersService.cancelInvitation(invitationId, userId);

      // Emit WebSocket event for cancellation
      if (req.io && result.inviteeId) {
        req.io.to(`user:${result.inviteeId}`).emit('group:invitation:cancelled', {
          groupId: result.groupId,
          invitationId,
          cancelledBy: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Invitation cancelled successfully',
        data: {
          ...result,
          cancelled: true
        }
      });
    } catch (error) {
      logger.error('Cancel invitation controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already responded')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to cancel invitation', 500));
      }
    }
  }

  /**
   * Leave group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async leaveGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const result = await groupMembersService.leaveGroup(groupId, userId);

      // Emit WebSocket event for leaving
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:member:left', {
          groupId,
          memberId: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Successfully left the group',
        data: {
          ...result,
          left: true
        }
      });
    } catch (error) {
      logger.error('Leave group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('cannot leave') || error.message.includes('creator')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to leave group', 500));
      }
    }
  }

  /**
   * Transfer group ownership
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async transferOwnership(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { newOwnerId } = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!newOwnerId) {
        throw new AppError('New owner ID is required', 400);
      }

      const result = await groupMembersService.transferOwnership(groupId, userId, newOwnerId);

      // Emit WebSocket event for ownership transfer
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:ownership:transferred', {
          groupId,
          previousOwnerId: userId,
          newOwnerId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Group ownership transferred successfully',
        data: {
          ...result,
          transferred: true
        }
      });
    } catch (error) {
      logger.error('Transfer ownership controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('cannot transfer')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to transfer ownership', 500));
      }
    }
  }

  /**
   * Get member statistics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMemberStatistics(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const statistics = await groupMembersService.getMemberStatistics(groupId, userId);

      res.status(200).json({
        success: true,
        message: 'Member statistics retrieved successfully',
        data: {
          statistics
        }
      });
    } catch (error) {
      logger.error('Get member statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get member statistics', 500));
      }
    }
  }

  /**
   * Search members
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async searchMembers(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { 
        query,
        page = 1, 
        limit = 20,
        role,
        onlineOnly = false,
        sortBy = 'relevance',
        sortOrder = 'desc'
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!query) {
        throw new AppError('Search query is required', 400);
      }

      const options = {
        query,
        page: parseInt(page),
        limit: parseInt(limit),
        role,
        onlineOnly: onlineOnly === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupMembersService.searchMembers(groupId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Members search completed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Search members controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to search members', 500));
      }
    }
  }

  /**
   * Mute member
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async muteMember(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;
      const { duration, reason } = req.body;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      if (!duration) {
        throw new AppError('Duration is required', 400);
      }

      const mute = await groupMembersService.muteMember(groupId, userId, memberId, duration, reason);

      // Emit WebSocket event for mute
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:member:muted', {
          groupId,
          memberId,
          mutedBy: userId,
          duration,
          reason,
          expiresAt: mute.expiresAt,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Member muted successfully',
        data: {
          mute
        }
      });
    } catch (error) {
      logger.error('Mute member controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already muted')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('cannot mute')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to mute member', 500));
      }
    }
  }

  /**
   * Unmute member
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async unmuteMember(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const result = await groupMembersService.unmuteMember(groupId, userId, memberId);

      // Emit WebSocket event for unmute
      if (req.io) {
        req.io.to(`group:${groupId}`).emit('group:member:unmuted', {
          groupId,
          memberId,
          unmutedBy: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Member unmuted successfully',
        data: {
          ...result,
          unmuted: true
        }
      });
    } catch (error) {
      logger.error('Unmute member controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('not muted')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to unmute member', 500));
      }
    }
  }

  /**
   * Ban member
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async banMember(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;
      const { duration, reason } = req.body;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const ban = await groupMembersService.banMember(groupId, userId, memberId, duration, reason);

      // Emit WebSocket events for ban
      if (req.io) {
        // Notify group about ban
        req.io.to(`group:${groupId}`).emit('group:member:banned', {
          groupId,
          memberId,
          bannedBy: userId,
          duration,
          reason,
          expiresAt: ban.expiresAt,
          timestamp: new Date()
        });

        // Notify banned user
        req.io.to(`user:${memberId}`).emit('group:you:banned', {
          groupId,
          bannedBy: userId,
          reason,
          expiresAt: ban.expiresAt,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Member banned successfully',
        data: {
          ban
        }
      });
    } catch (error) {
      logger.error('Ban member controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already banned')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('cannot ban')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to ban member', 500));
      }
    }
  }

  /**
   * Unban member
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async unbanMember(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const result = await groupMembersService.unbanMember(groupId, userId, memberId);

      // Emit WebSocket events for unban
      if (req.io) {
        // Notify group about unban
        req.io.to(`group:${groupId}`).emit('group:member:unbanned', {
          groupId,
          memberId,
          unbannedBy: userId,
          timestamp: new Date()
        });

        // Notify unbanned user
        req.io.to(`user:${memberId}`).emit('group:you:unbanned', {
          groupId,
          unbannedBy: userId,
          timestamp: new Date()
        });
      }

      res.status(200).json({
        success: true,
        message: 'Member unbanned successfully',
        data: {
          ...result,
          unbanned: true
        }
      });
    } catch (error) {
      logger.error('Unban member controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('not banned')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to unban member', 500));
      }
    }
  }

  /**
   * Get banned members
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getBannedMembers(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        activeOnly = true,
        sortBy = 'bannedAt',
        sortOrder = 'desc'
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        activeOnly: activeOnly === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupMembersService.getBannedMembers(groupId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Banned members retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get banned members controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get banned members', 500));
      }
    }
  }

  /**
   * Get online members
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getOnlineMembers(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'lastSeen',
        sortOrder = 'desc'
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupMembersService.getOnlineMembers(groupId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Online members retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get online members controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get online members', 500));
      }
    }
  }

  /**
   * Get member activity
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getMemberActivity(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        startDate,
        endDate,
        activityType,
        sortBy = 'timestamp',
        sortOrder = 'desc'
      } = req.query;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        activityType,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupMembersService.getMemberActivity(groupId, memberId, userId, options);

      res.status(200).json({
        success: true,
        message: 'Member activity retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get member activity controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get member activity', 500));
      }
    }
  }

  /**
   * Export members list
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async exportMembersList(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { 
        format = 'json',
        includeRole = true,
        includeJoinDate = true,
        includeLastSeen = true,
        includeActivity = false
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const exportData = await groupMembersService.exportMembersList(groupId, userId, {
        format,
        includeRole: includeRole === 'true',
        includeJoinDate: includeJoinDate === 'true',
        includeLastSeen: includeLastSeen === 'true',
        includeActivity: includeActivity === 'true'
      });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=group_${groupId}_members_${new Date().toISOString().split('T')[0]}.csv`);
        return res.send(exportData);
      } else if (format === 'json') {
        res.status(200).json({
          success: true,
          message: 'Members list exported successfully',
          data: exportData
        });
      } else {
        throw new AppError('Invalid export format. Use "json" or "csv"', 400);
      }
    } catch (error) {
      logger.error('Export members list controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to export members list', 500));
      }
    }
  }
}

module.exports = new GroupMembersController();