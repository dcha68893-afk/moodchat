const mongoose = require('mongoose');
const Group = require('../models/Group');
const User = require('../models/User');
const Conversation = require('../models/Chat');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { MAX_GROUP_MEMBERS, DEFAULT_GROUP_PICTURE } = process.env;

/**
 * Group Service
 * Handles all business logic for group operations
 */
class GroupService {
  /**
   * Create a new group
   * @param {Object} groupData - Group data including name, creator, and initial members
   * @returns {Promise<Object>} Created group with conversation
   */
  async createGroup(groupData) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { name, creatorId, memberIds = [], description = '', isPublic = false } = groupData;

      // Validate required fields
      if (!name || !creatorId) {
        throw new ValidationError('Group name and creator ID are required');
      }

      // Validate name length
      if (name.length < 3 || name.length > 100) {
        throw new ValidationError('Group name must be between 3 and 100 characters');
      }

      // Validate description length
      if (description.length > 500) {
        throw new ValidationError('Description cannot exceed 500 characters');
      }

      // Include creator in member list
      const allMemberIds = [...new Set([creatorId, ...memberIds])];

      // Check member limit
      const maxMembers = parseInt(MAX_GROUP_MEMBERS) || 100;
      if (allMemberIds.length > maxMembers) {
        throw new ValidationError(`Group cannot have more than ${maxMembers} members`);
      }

      // Verify all users exist
      const users = await User.find({ _id: { $in: allMemberIds } }).session(session);
      if (users.length !== allMemberIds.length) {
        throw new NotFoundError('One or more users not found');
      }

      // Create group
      const group = new Group({
        name,
        description,
        createdBy: new mongoose.Types.ObjectId(creatorId),
        members: allMemberIds.map(id => new mongoose.Types.ObjectId(id)),
        admins: [new mongoose.Types.ObjectId(creatorId)],
        isPublic,
        picture: DEFAULT_GROUP_PICTURE || '/default-group.png',
      });

      // Create corresponding conversation
      const conversation = new Conversation({
        type: 'group',
        groupId: group._id,
        participants: allMemberIds.map(id => new mongoose.Types.ObjectId(id)),
        createdBy: new mongoose.Types.ObjectId(creatorId),
      });

      // Save both documents in transaction
      await group.save({ session });
      await conversation.save({ session });

      // Link conversation to group
      group.conversationId = conversation._id;
      await group.save({ session });

      await session.commitTransaction();

      // Populate fields for response
      await group.populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
        { path: 'createdBy', select: '_id username email profilePicture' },
      ]);

      return {
        group,
        conversation: {
          _id: conversation._id,
          type: conversation.type,
          participants: conversation.participants,
        },
      };
    } catch (error) {
      await session.abortTransaction();

      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error creating group:', error);
      throw new ServerError('Failed to create group');
    } finally {
      session.endSession();
    }
  }

  /**
   * Get group details by ID
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID for permission check
   * @returns {Promise<Object>} Group details
   */
  async getGroupById(groupId, userId) {
    try {
      if (!groupId || !userId) {
        throw new ValidationError('Group ID and user ID are required');
      }

      const group = await Group.findById(groupId).populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
        { path: 'createdBy', select: '_id username email profilePicture' },
        { path: 'conversationId', select: '_id type' },
      ]);

      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is a member (unless group is public)
      const isMember = group.members.some(member => member._id.toString() === userId);

      if (!group.isPublic && !isMember) {
        throw new ForbiddenError('You do not have permission to view this group');
      }

      return group;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching group:', error);
      throw new ServerError('Failed to fetch group details');
    }
  }

  /**
   * Update group information
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID (must be admin)
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated group
   */
  async updateGroup(groupId, userId, updates) {
    try {
      if (!groupId || !userId) {
        throw new ValidationError('Group ID and user ID are required');
      }

      const group = await Group.findById(groupId);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is admin
      const isAdmin = group.admins.some(adminId => adminId.toString() === userId);
      if (!isAdmin) {
        throw new ForbiddenError('Only group admins can update group information');
      }

      // Validate updates
      const allowedUpdates = ['name', 'description', 'picture', 'isPublic'];
      const updateFields = {};

      for (const [key, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(key)) {
          if (key === 'name' && (value.length < 3 || value.length > 100)) {
            throw new ValidationError('Group name must be between 3 and 100 characters');
          }
          if (key === 'description' && value.length > 500) {
            throw new ValidationError('Description cannot exceed 500 characters');
          }
          updateFields[key] = value;
        }
      }

      // Apply updates
      Object.assign(group, updateFields);
      await group.save();

      await group.populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
        { path: 'createdBy', select: '_id username email profilePicture' },
      ]);

      return group;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error updating group:', error);
      throw new ServerError('Failed to update group');
    }
  }

  /**
   * Add members to group
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID (must be admin)
   * @param {Array<string>} newMemberIds - IDs of users to add
   * @returns {Promise<Object>} Updated group
   */
  async addMembers(groupId, userId, newMemberIds) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!groupId || !userId || !newMemberIds?.length) {
        throw new ValidationError('Group ID, user ID, and member IDs are required');
      }

      const group = await Group.findById(groupId).session(session);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is admin
      const isAdmin = group.admins.some(adminId => adminId.toString() === userId);
      if (!isAdmin) {
        throw new ForbiddenError('Only group admins can add members');
      }

      // Remove duplicates and existing members
      const existingMemberIds = group.members.map(m => m.toString());
      const uniqueNewMemberIds = [...new Set(newMemberIds)].filter(
        id => !existingMemberIds.includes(id)
      );

      if (uniqueNewMemberIds.length === 0) {
        throw new ValidationError('All users are already group members');
      }

      // Check member limit
      const maxMembers = parseInt(MAX_GROUP_MEMBERS) || 100;
      if (group.members.length + uniqueNewMemberIds.length > maxMembers) {
        throw new ValidationError(`Cannot exceed maximum of ${maxMembers} members`);
      }

      // Verify new users exist
      const newUsers = await User.find({
        _id: { $in: uniqueNewMemberIds },
      }).session(session);

      if (newUsers.length !== uniqueNewMemberIds.length) {
        throw new NotFoundError('One or more users not found');
      }

      // Add to group members
      const memberObjectIds = uniqueNewMemberIds.map(id => new mongoose.Types.ObjectId(id));
      group.members.push(...memberObjectIds);
      await group.save({ session });

      // Add to conversation participants
      await Conversation.findByIdAndUpdate(
        group.conversationId,
        { $addToSet: { participants: { $each: memberObjectIds } } },
        { session }
      );

      await session.commitTransaction();

      await group.populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
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
      console.error('Error adding members:', error);
      throw new ServerError('Failed to add members');
    } finally {
      session.endSession();
    }
  }

  /**
   * Remove members from group
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID (must be admin or the member themselves)
   * @param {Array<string>} memberIdsToRemove - IDs of users to remove
   * @returns {Promise<Object>} Updated group
   */
  async removeMembers(groupId, userId, memberIdsToRemove) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!groupId || !userId || !memberIdsToRemove?.length) {
        throw new ValidationError('Group ID, user ID, and member IDs are required');
      }

      const group = await Group.findById(groupId).session(session);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is admin or removing themselves
      const isAdmin = group.admins.some(adminId => adminId.toString() === userId);
      const isSelfRemoval = memberIdsToRemove.length === 1 && memberIdsToRemove[0] === userId;

      if (!isAdmin && !isSelfRemoval) {
        throw new ForbiddenError('You do not have permission to remove members');
      }

      // Prevent removing the last admin
      const memberObjectIdsToRemove = memberIdsToRemove.map(id => new mongoose.Types.ObjectId(id));

      if (isAdmin) {
        const remainingAdmins = group.admins.filter(
          adminId => !memberObjectIdsToRemove.some(id => id.equals(adminId))
        );
        if (remainingAdmins.length === 0) {
          throw new ValidationError('Group must have at least one admin');
        }
      }

      // Remove from group members
      group.members = group.members.filter(
        memberId => !memberObjectIdsToRemove.some(id => id.equals(memberId))
      );

      // Remove from admins if they were admins
      group.admins = group.admins.filter(
        adminId => !memberObjectIdsToRemove.some(id => id.equals(adminId))
      );

      await group.save({ session });

      // Remove from conversation participants
      await Conversation.findByIdAndUpdate(
        group.conversationId,
        { $pull: { participants: { $in: memberObjectIdsToRemove } } },
        { session }
      );

      await session.commitTransaction();

      await group.populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
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
      console.error('Error removing members:', error);
      throw new ServerError('Failed to remove members');
    } finally {
      session.endSession();
    }
  }

  /**
   * Add or remove group admins
   * @param {string} groupId - Group ID
   * @param {string} userId - User ID (must be admin)
   * @param {Array<string>} adminIds - IDs to set as admins
   * @returns {Promise<Object>} Updated group
   */
  async updateAdmins(groupId, userId, adminIds) {
    try {
      if (!groupId || !userId || !adminIds?.length) {
        throw new ValidationError('Group ID, user ID, and admin IDs are required');
      }

      const group = await Group.findById(groupId);
      if (!group) {
        throw new NotFoundError('Group not found');
      }

      // Check if user is admin
      const isAdmin = group.admins.some(adminId => adminId.toString() === userId);
      if (!isAdmin) {
        throw new ForbiddenError('Only group admins can modify admin list');
      }

      // Verify all new admins are group members
      const adminObjectIds = adminIds.map(id => new mongoose.Types.ObjectId(id));
      const allAdminsAreMembers = adminObjectIds.every(adminId =>
        group.members.some(memberId => memberId.equals(adminId))
      );

      if (!allAdminsAreMembers) {
        throw new ValidationError('All admins must be group members');
      }

      // Update admins
      group.admins = adminObjectIds;
      await group.save();

      await group.populate([
        { path: 'members', select: '_id username email profilePicture' },
        { path: 'admins', select: '_id username email profilePicture' },
      ]);

      return group;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error updating admins:', error);
      throw new ServerError('Failed to update group admins');
    }
  }

  /**
   * Get user's groups with pagination
   * @param {string} userId - User ID
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Groups and pagination info
   */
  async getUserGroups(userId, page = 1, limit = 20) {
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

      // Get groups where user is a member
      const [groups, total] = await Promise.all([
        Group.find({ members: userId })
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate([
            { path: 'members', select: '_id username profilePicture' },
            { path: 'admins', select: '_id username profilePicture' },
            { path: 'conversationId', select: '_id type' },
          ]),
        Group.countDocuments({ members: userId }),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        groups,
        pagination: {
          currentPage: page,
          totalPages,
          totalGroups: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching user groups:', error);
      throw new ServerError('Failed to fetch user groups');
    }
  }

  /**
   * Search for public groups
   * @param {string} searchTerm - Search term
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Search results
   */
  async searchPublicGroups(searchTerm, page = 1, limit = 20) {
    try {
      page = parseInt(page);
      limit = parseInt(limit);

      if (page < 1 || limit < 1 || limit > 50) {
        throw new ValidationError('Invalid pagination parameters');
      }

      const skip = (page - 1) * limit;

      const query = { isPublic: true };
      if (searchTerm) {
        query.$or = [
          { name: { $regex: searchTerm, $options: 'i' } },
          { description: { $regex: searchTerm, $options: 'i' } },
        ];
      }

      const [groups, total] = await Promise.all([
        Group.find(query)
          .sort({ membersCount: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('_id name description picture membersCount createdAt')
          .populate('createdBy', '_id username profilePicture'),
        Group.countDocuments(query),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        groups,
        pagination: {
          currentPage: page,
          totalPages,
          totalGroups: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error searching groups:', error);
      throw new ServerError('Failed to search groups');
    }
  }
}

module.exports = new GroupService();
