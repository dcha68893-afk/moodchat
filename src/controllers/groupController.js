const groupService = require('../services/groupService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class GroupController {
  /**
   * Create a new group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async createGroup(req, res, next) {
    try {
      const userId = req.user.id;
      const { name, description, avatar, members, privacy, settings } = req.body;

      if (!name) {
        throw new AppError('Group name is required', 400);
      }

      const groupData = {
        name,
        description,
        avatar,
        creatorId: userId,
        members: members || [],
        privacy: privacy || 'public',
        settings: settings || {}
      };

      const group = await groupService.createGroup(groupData);

      res.status(201).json({
        success: true,
        message: 'Group created successfully',
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Create group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.code === 11000) {
        next(new AppError('Group with this name already exists', 409));
      } else {
        next(new AppError('Failed to create group', 500));
      }
    }
  }

  /**
   * Get group by ID
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getGroupById(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const group = await groupService.getGroupById(groupId, userId);

      res.status(200).json({
        success: true,
        message: 'Group retrieved successfully',
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Get group by ID controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to retrieve group', 500));
      }
    }
  }

  /**
   * Update group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const updateData = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!updateData || typeof updateData !== 'object') {
        throw new AppError('Update data is required', 400);
      }

      const group = await groupService.updateGroup(groupId, userId, updateData);

      res.status(200).json({
        success: true,
        message: 'Group updated successfully',
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Update group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to update group', 500));
      }
    }
  }

  /**
   * Delete group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      await groupService.deleteGroup(groupId, userId);

      res.status(200).json({
        success: true,
        message: 'Group deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to delete group', 500));
      }
    }
  }

  /**
   * Add member to group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async addMember(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { memberId, role = 'member' } = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!memberId) {
        throw new AppError('Member ID is required', 400);
      }

      const group = await groupService.addMember(groupId, userId, memberId, role);

      res.status(200).json({
        success: true,
        message: 'Member added successfully',
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Add member controller error:', error);
      
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
      } else {
        next(new AppError('Failed to add member', 500));
      }
    }
  }

  /**
   * Remove member from group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async removeMember(req, res, next) {
    try {
      const { groupId, memberId } = req.params;
      const userId = req.user.id;

      if (!groupId || !memberId) {
        throw new AppError('Group ID and Member ID are required', 400);
      }

      const group = await groupService.removeMember(groupId, userId, memberId);

      res.status(200).json({
        success: true,
        message: 'Member removed successfully',
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Remove member controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('cannot remove yourself') || error.message.includes('cannot remove creator')) {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to remove member', 500));
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

      const group = await groupService.updateMemberRole(groupId, userId, memberId, role);

      res.status(200).json({
        success: true,
        message: 'Member role updated successfully',
        data: {
          group
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

      const result = await groupService.leaveGroup(groupId, userId);

      res.status(200).json({
        success: true,
        message: 'Successfully left the group',
        data: {
          left: result
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
   * Get user's groups
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getUserGroups(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 20, 
        role,
        search,
        sortBy = 'updatedAt',
        sortOrder = 'desc'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        role,
        search,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupService.getUserGroups(userId, options);

      res.status(200).json({
        success: true,
        message: 'User groups retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get user groups controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve user groups', 500));
      }
    }
  }

  /**
   * Search groups
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async searchGroups(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        query,
        page = 1, 
        limit = 20,
        privacy,
        sortBy = 'relevance',
        sortOrder = 'desc'
      } = req.query;

      if (!query) {
        throw new AppError('Search query is required', 400);
      }

      const options = {
        query,
        page: parseInt(page),
        limit: parseInt(limit),
        privacy,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupService.searchGroups(userId, options);

      res.status(200).json({
        success: true,
        message: 'Groups search completed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Search groups controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to search groups', 500));
      }
    }
  }

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
        search,
        online
      } = req.query;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        role,
        search,
        online: online === 'true'
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupService.getGroupMembers(groupId, userId, options);

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
        next(new AppError('Failed to retrieve group members', 500));
      }
    }
  }

  /**
   * Update group settings
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateGroupSettings(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const settings = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      if (!settings || typeof settings !== 'object') {
        throw new AppError('Settings data is required', 400);
      }

      const group = await groupService.updateGroupSettings(groupId, userId, settings);

      res.status(200).json({
        success: true,
        message: 'Group settings updated successfully',
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Update group settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to update group settings', 500));
      }
    }
  }

  /**
   * Get group statistics
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getGroupStatistics(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const statistics = await groupService.getGroupStatistics(groupId, userId);

      res.status(200).json({
        success: true,
        message: 'Group statistics retrieved successfully',
        data: {
          statistics
        }
      });
    } catch (error) {
      logger.error('Get group statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to retrieve group statistics', 500));
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

      const group = await groupService.transferOwnership(groupId, userId, newOwnerId);

      res.status(200).json({
        success: true,
        message: 'Group ownership transferred successfully',
        data: {
          group
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
   * Archive group
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async archiveGroup(req, res, next) {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { archived = true } = req.body;

      if (!groupId) {
        throw new AppError('Group ID is required', 400);
      }

      const group = await groupService.archiveGroup(groupId, userId, archived);

      res.status(200).json({
        success: true,
        message: `Group ${archived ? 'archived' : 'unarchived'} successfully`,
        data: {
          group
        }
      });
    } catch (error) {
      logger.error('Archive group controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to archive group', 500));
      }
    }
  }

  /**
   * Get group invitations
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getGroupInvitations(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 20,
        status = 'pending'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        status
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await groupService.getGroupInvitations(userId, options);

      res.status(200).json({
        success: true,
        message: 'Group invitations retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get group invitations controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve group invitations', 500));
      }
    }
  }

  /**
   * Send group invitation
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async sendInvitation(req, res, next) {
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

      const invitation = await groupService.sendInvitation(groupId, userId, inviteeId, role, message);

      res.status(201).json({
        success: true,
        message: 'Invitation sent successfully',
        data: {
          invitation
        }
      });
    } catch (error) {
      logger.error('Send invitation controller error:', error);
      
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
      } else {
        next(new AppError('Failed to send invitation', 500));
      }
    }
  }

  /**
   * Respond to group invitation
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async respondToInvitation(req, res, next) {
    try {
      const { invitationId } = req.params;
      const userId = req.user.id;
      const { accept } = req.body;

      if (!invitationId) {
        throw new AppError('Invitation ID is required', 400);
      }

      if (typeof accept !== 'boolean') {
        throw new AppError('Accept status is required (true/false)', 400);
      }

      const result = await groupService.respondToInvitation(invitationId, userId, accept);

      res.status(200).json({
        success: true,
        message: `Invitation ${accept ? 'accepted' : 'declined'} successfully`,
        data: {
          accepted: accept,
          group: accept ? result.group : null
        }
      });
    } catch (error) {
      logger.error('Respond to invitation controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('already responded')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to respond to invitation', 500));
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

      await groupService.cancelInvitation(invitationId, userId);

      res.status(200).json({
        success: true,
        message: 'Invitation cancelled successfully',
        data: null
      });
    } catch (error) {
      logger.error('Cancel invitation controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to cancel invitation', 500));
      }
    }
  }
}

module.exports = new GroupController();