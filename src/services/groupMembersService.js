const mongoose = require('mongoose');
const Group = require('../models/Group');
const User = require('../models/Users');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

/**
 * Group Members Service
 * Handles detailed group member operations and analytics
 */
class GroupMembersService {
  /**
   * Get group member details with status
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID for permission check
   * @returns {Promise<Array>} Detailed member information
   */
  async getGroupMembers(groupId, userId) {
    try {
      if (!groupId || !userId) {
        throw new ValidationError('Group ID and user ID are required');
      }

      const group = await Group.findById(groupId);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is member
      const isMember = group.members.some(member => member.toString() === userId);
      if (!isMember && !group.isPublic) {
        throw new ForbiddenError('You must be a member to view group members');
      }

      // Get detailed member information
      const members = await User.find({ _id: { $in: group.members } })
        .select('_id username email profilePicture status lastSeen createdAt')
        .lean();

      // Add admin status
      const adminIds = group.admins.map(admin => admin.toString());
      const membersWithDetails = members.map(member => ({
        ...member,
        isAdmin: adminIds.includes(member._id.toString()),
        joinedAt: group.createdAt // In reality, you might want to store join date separately
      }));

      return membersWithDetails;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching group members:', error);
      throw new ServerError('Failed to fetch group members');
    }
  }

  /**
   * Get active members (online or recently active)
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Active members
   */
  async getActiveMembers(groupId, userId) {
    try {
      if (!groupId || !userId) {
        throw new ValidationError('Group ID and user ID are required');
      }

      const group = await Group.findById(groupId);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is member
      const isMember = group.members.some(member => member.toString() === userId);
      if (!isMember) {
        throw new ForbiddenError('You must be a member to view active members');
      }

      // Get members who were active in the last 15 minutes
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

      const activeMembers = await User.find({
        _id: { $in: group.members },
        $or: [
          { status: 'online' },
          { lastSeen: { $gte: fifteenMinutesAgo } }
        ]
      })
      .select('_id username profilePicture status lastSeen')
      .sort({ lastSeen: -1 });

      return activeMembers;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching active members:', error);
      throw new ServerError('Failed to fetch active members');
    }
  }

  /**
   * Transfer group ownership
   * @param {string} groupId - Group ID
   * @param {string} currentOwnerId - Current owner ID
   * @param {string} newOwnerId - New owner ID
   * @returns {Promise<Object>} Updated group
   */
  async transferOwnership(groupId, currentOwnerId, newOwnerId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!groupId || !currentOwnerId || !newOwnerId) {
        throw new ValidationError('Group ID, current owner ID, and new owner ID are required');
      }

      const group = await Group.findById(groupId).session(session);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if current user is the creator
      if (group.createdBy.toString() !== currentOwnerId) {
        throw new ForbiddenError('Only the group creator can transfer ownership');
      }

      // Check if new owner is a member
      const newOwnerIsMember = group.members.some(member => member.toString() === newOwnerId);
      if (!newOwnerIsMember) {
        throw new ValidationError('New owner must be a group member');
      }

      // Update group creator
      group.createdBy = new mongoose.Types.ObjectId(newOwnerId);
      
      // Ensure new owner is an admin
      const newOwnerObjectId = new mongoose.Types.ObjectId(newOwnerId);
      if (!group.admins.some(admin => admin.equals(newOwnerObjectId))) {
        group.admins.push(newOwnerObjectId);
      }

      await group.save({ session });

      await session.commitTransaction();

      await group.populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
        { path: 'createdBy', select: '_id username email profilePicture' }
      ]);

      return group;
    } catch (error) {
      await session.abortTransaction();

      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error transferring ownership:', error);
      throw new ServerError('Failed to transfer group ownership');
    } finally {
      session.endSession();
    }
  }

  /**
   * Get group membership statistics
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID (must be admin)
   * @returns {Promise<Object>} Membership statistics
   */
  async getMembershipStats(groupId, userId) {
    try {
      if (!groupId || !userId) {
        throw new ValidationError('Group ID and user ID are required');
      }

      const group = await Group.findById(groupId);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is admin
      const isAdmin = group.admins.some(admin => admin.toString() === userId);
      if (!isAdmin) {
        throw new ForbiddenError('Only group admins can view membership statistics');
      }

      const totalMembers = group.members.length;
      const totalAdmins = group.admins.length;

      // Get member activity stats
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      // You would need to query message/activity logs here
      // This is a placeholder implementation
      const activeLastWeek = Math.floor(totalMembers * 0.7); // Replace with actual query

      // Get join dates distribution (you'd need to store join dates)
      const joinStats = {
        last24Hours: 0,
        last7Days: 0,
        last30Days: 0,
        total: totalMembers
      };

      return {
        totalMembers,
        totalAdmins,
        activeLastWeek,
        joinStats,
        adminToMemberRatio: totalAdmins / totalMembers
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching membership stats:', error);
      throw new ServerError('Failed to fetch membership statistics');
    }
  }

  /**
   * Check if user is group admin
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if user is admin
   */
  async isGroupAdmin(groupId, userId) {
    try {
      if (!groupId || !userId) {
        throw new ValidationError('Group ID and user ID are required');
      }

      const group = await Group.findById(groupId);
      if (!group) {
        return false;
      }

      return group.admins.some(admin => admin.toString() === userId);
    } catch (error) {
      console.error('Error checking admin status:', error);
      return false;
    }
  }

  /**
   * Get groups where user is admin
   * @param {string} userId - User ID
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Admin groups
   */
  async getAdminGroups(userId, page = 1, limit = 20) {
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

      const [groups, total] = await Promise.all([
        Group.find({ admins: userId })
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate([
            { path: 'members', select: '_id username profilePicture' },
            { path: 'admins', select: '_id username profilePicture' }
          ]),
        Group.countDocuments({ admins: userId })
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        groups,
        pagination: {
          currentPage: page,
          totalPages,
          totalGroups: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching admin groups:', error);
      throw new ServerError('Failed to fetch admin groups');
    }
  }
}

module.exports = new GroupMembersService();