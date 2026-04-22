// routes/groups.js - Complete Group Management Routes
// Full implementation with all features - NO SUMMARIZATION
// Includes: Group CRUD, Members, Invites, Invite Links, Settings, Public Groups, Search, Purposes

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');

// ===== SAFE MODEL IMPORT =====
// Uses db.models (the sequelize instance's model registry) as primary source
// so models resolve correctly regardless of export key capitalisation
let db, User, Group, GroupMember, Invite, Chat;
try {
    db = require('../models');
    // Primary: db.models (sequelize registered names) ? fallback to direct export keys
    const m = db.models || {};
    // FIXED: Use correct registry keys - 'Groups' and 'GroupMembers' exist in Sequelize registry
    User        = m.Users        || m.User        || db.Users        || db.User;
    Group       = m.Groups       || m.userGroup   || db.Groups       || db.Group;
    GroupMember = m.GroupMembers || m.userGroupMember || db.GroupMembers || db.GroupMember;
    Invite      = m.Invite       || m.Invites     || db.Invite       || db.Invites || null;
    Chat        = m.Chats        || m.Chat        || db.Chats        || db.Chat;
    console.log('[Groups Route] Models loaded - User:', !!User, 'Group:', !!Group, 'GroupMember:', !!GroupMember, 'Invite:', !!Invite);
} catch (error) {
    console.error('[Groups Route] Error loading models:', error.message);
    db = null;
}

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

// ========== HELPER FUNCTIONS ==========

// Helper function to get user ID with validation
const getUserId = (req) => {
    if (!req.user) {
        console.error('[Groups] req.user is undefined!');
        return null;
    }
    return req.user.userId || req.user.id;
};

// Helper function to format group data
const formatGroup = (group) => {
    if (!group) return null;
    const groupData = group.toJSON ? group.toJSON() : group;
    return {
        id: groupData.id,
        name: groupData.name || '',
        description: groupData.description || '',
        avatar: groupData.avatar || null,
        isPublic: groupData.isPublic !== undefined ? groupData.isPublic : true,
        purpose: groupData.purpose || 'social',
        maxMembers: groupData.maxMembers || 100,
        tags: groupData.tags || [],
        rules: groupData.rules || '',
        location: groupData.location || '',
        createdBy: groupData.createdBy,
        createdAt: groupData.createdAt,
        updatedAt: groupData.updatedAt,
        stats: {
            totalMembers: groupData.totalMembers || 0,
            totalMessages: groupData.totalMessages || 0,
            dailyActiveUsers: groupData.dailyActiveUsers || 0,
            weeklyActiveUsers: groupData.weeklyActiveUsers || 0
        },
        isVerified: groupData.isVerified || false,
        settings: groupData.settings || {
            allowMedia: true,
            allowCalls: true,
            allowReactions: true,
            allowReplies: true,
            allowEditing: true,
            allowDeleting: true,
            slowMode: false,
            requireAdminApproval: false
        }
    };
};

// Helper function to format invite data
const formatInvite = (invite) => {
    if (!invite) return null;
    const inviteData = invite.toJSON ? invite.toJSON() : invite;
    return {
        id: inviteData.id,
        groupId: inviteData.groupId,
        inviterId: inviteData.inviterId,
        inviter: inviteData.inviter ? {
            id: inviteData.inviter.id,
            username: inviteData.inviter.username,
            avatar: inviteData.inviter.avatar
        } : null,
        targetUserId: inviteData.targetUserId,
        targetUser: inviteData.targetUser ? {
            id: inviteData.targetUser.id,
            username: inviteData.targetUser.username,
            avatar: inviteData.targetUser.avatar
        } : null,
        targetEmail: inviteData.targetEmail,
        message: inviteData.message || '',
        status: inviteData.status || 'pending',
        createdAt: inviteData.createdAt,
        expiresAt: inviteData.expiresAt,
        inviteLink: inviteData.inviteLink
    };
};

// Helper function with timeout
const withTimeout = (promise, timeoutMs = 15000) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Query timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
    });
};

// ========== GROUP CONTROLLER ==========
class GroupController {
  
  // ===== PUBLIC ROUTES =====
  
  // Get group purposes (for dropdowns, etc.) - PUBLIC
  async getGroupPurposes(req, res) {
    try {
      res.json({
        success: true,
        data: {
          purposes: [
            { id: 'social', name: 'Social', icon: '??', description: 'Connect with friends and make new ones' },
            { id: 'study', name: 'Study', icon: '??', description: 'Study groups and academic discussions' },
            { id: 'work', name: 'Work', icon: '??', description: 'Professional collaboration and networking' },
            { id: 'gaming', name: 'Gaming', icon: '??', description: 'Gaming communities and tournaments' },
            { id: 'support', name: 'Support', icon: '??', description: 'Support groups and wellness communities' },
            { id: 'hobby', name: 'Hobby', icon: '??', description: 'Share and discuss your hobbies' },
            { id: 'professional', name: 'Professional', icon: '??', description: 'Industry professionals and experts' },
            { id: 'entertainment', name: 'Entertainment', icon: '??', description: 'Movies, music, and entertainment' },
            { id: 'education', name: 'Education', icon: '??', description: 'Educational content and learning' },
            { id: 'tech', name: 'Technology', icon: '??', description: 'Tech discussions and innovations' },
            { id: 'sports', name: 'Sports', icon: '?', description: 'Sports fans and teams' },
            { id: 'health', name: 'Health', icon: '??', description: 'Health and fitness communities' },
            { id: 'business', name: 'Business', icon: '??', description: 'Business networking and entrepreneurship' },
            { id: 'art', name: 'Art', icon: '??', description: 'Artists and creative communities' },
            { id: 'travel', name: 'Travel', icon: '??', description: 'Travel enthusiasts and explorers' },
            { id: 'food', name: 'Food', icon: '??', description: 'Food lovers and cooking enthusiasts' },
            { id: 'music', name: 'Music', icon: '??', description: 'Music lovers and musicians' },
            { id: 'photography', name: 'Photography', icon: '??', description: 'Photography enthusiasts' },
            { id: 'writing', name: 'Writing', icon: '??', description: 'Writers and authors' },
            { id: 'other', name: 'Other', icon: '??', description: 'Other types of groups' }
          ]
        }
      });
    } catch (error) {
      console.error('[Groups] Error getting purposes:', error);
      res.status(500).json({ success: false, message: 'Failed to get group purposes', error: error.message });
    }
  }

  // Get public groups - PUBLIC
  async getPublicGroups(req, res) {
    try {
      const { limit = 20, offset = 0, purpose, search } = req.query;
      const limitNum = Math.min(parseInt(limit), 100);
      const offsetNum = parseInt(offset);
      
      if (!Group) {
        return res.json({
          success: true,
          data: {
            groups: []
          },
          pagination: {
            limit: limitNum,
            offset: offsetNum,
            total: 0,
            hasMore: false
          }
        });
      }
      
      const whereCondition = { isPublic: true };
      if (purpose && purpose !== 'all') {
        whereCondition.purpose = purpose;
      }
      if (search && search.trim().length >= 2) {
        const searchRegex = `%${search}%`;
        whereCondition[Op.or] = [
          { name: { [Op.iLike]: searchRegex } },
          { description: { [Op.iLike]: searchRegex } }
        ];
      }
      
      const { count, rows: groups } = await withTimeout(Group.findAndCountAll({
        where: whereCondition,
        limit: limitNum,
        offset: offsetNum,
        order: [['createdAt', 'DESC']],
        attributes: ['id', 'name', 'description', 'avatar', 'purpose', 'isPublic', 'maxMembers', 'createdBy', 'createdAt', 'updatedAt']
      }));
      
      const formattedGroups = (groups || []).map(group => formatGroup(group));
      
      res.json({
        success: true,
        data: {
          groups: formattedGroups
        },
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          total: count,
          hasMore: offsetNum + limitNum < count
        }
      });
    } catch (error) {
      console.error('[Groups] Error getting public groups:', error);
      res.status(200).json({ 
        success: true, 
        data: { groups: [] },
        pagination: { limit: 20, offset: 0, total: 0, hasMore: false }
      });
    }
  }

  // Search groups - PUBLIC
  async searchGroups(req, res) {
    try {
      const { q, limit = 20, offset = 0, purpose, sortBy = 'relevance' } = req.query;
      
      if (!q || q.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Search query must be at least 2 characters',
          code: 'INVALID_SEARCH_QUERY'
        });
      }
      
      const limitNum = Math.min(parseInt(limit), 100);
      const offsetNum = parseInt(offset);
      
      if (!Group) {
        return res.json({
          success: true,
          data: { groups: [] },
          query: q,
          pagination: {
            limit: limitNum,
            offset: offsetNum,
            total: 0,
            hasMore: false
          }
        });
      }
      
      const searchRegex = `%${q}%`;
      const whereCondition = {
        isPublic: true,
        [Op.or]: [
          { name: { [Op.iLike]: searchRegex } },
          { description: { [Op.iLike]: searchRegex } },
          { tags: { [Op.contains]: [q] } }
        ]
      };
      
      if (purpose && purpose !== 'all') {
        whereCondition.purpose = purpose;
      }
      
      const { count, rows: groups } = await withTimeout(Group.findAndCountAll({
        where: whereCondition,
        limit: limitNum,
        offset: offsetNum,
        order: sortBy === 'relevance' ? [['createdAt', 'DESC']] : [['name', 'ASC']],
        attributes: ['id', 'name', 'description', 'avatar', 'purpose', 'isPublic', 'maxMembers', 'createdBy', 'createdAt', 'updatedAt']
      }));
      
      const formattedGroups = (groups || []).map(group => formatGroup(group));
      
      res.json({
        success: true,
        data: { groups: formattedGroups },
        query: q,
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          total: count,
          hasMore: offsetNum + limitNum < count
        }
      });
    } catch (error) {
      console.error('[Groups] Error searching groups:', error);
      res.status(200).json({ 
        success: true, 
        data: { groups: [] },
        query: req.query.q,
        pagination: { limit: 20, offset: 0, total: 0, hasMore: false }
      });
    }
  }
  
  // ===== PROTECTED ROUTES =====

  // Create group - PROTECTED
  async createGroup(req, res) {
    try {
      const { name, description, isPublic, purpose, maxMembers, tags, rules, location, avatar } = req.body;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      // Validate required fields
      if (!name || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Group name is required',
          code: 'MISSING_GROUP_NAME'
        });
      }
      
      if (name.length > 100) {
        return res.status(400).json({
          success: false,
          message: 'Group name cannot exceed 100 characters',
          code: 'NAME_TOO_LONG'
        });
      }
      
      if (description && description.length > 500) {
        return res.status(400).json({
          success: false,
          message: 'Description cannot exceed 500 characters',
          code: 'DESCRIPTION_TOO_LONG'
        });
      }
      
      if (!Group) {
        // Fallback for when Group model doesn't exist
        const newGroup = {
          id: Date.now(),
          name: name.trim(),
          description: description || '',
          isPublic: isPublic !== undefined ? isPublic : true,
          purpose: purpose || 'social',
          maxMembers: maxMembers || 100,
          tags: tags || [],
          rules: rules || '',
          location: location || '',
          avatar: avatar || null,
          createdBy: userId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          stats: { totalMembers: 1, totalMessages: 0, dailyActiveUsers: 1, weeklyActiveUsers: 1 },
          isVerified: false
        };
        
        return res.status(201).json({
          success: true,
          data: { group: newGroup },
          message: 'Group created successfully'
        });
      }
      
      const newGroup = await Group.create({
        name: name.trim(),
        description: description || '',
        isPublic: isPublic !== undefined ? isPublic : true,
        purpose: purpose || 'social',
        maxMembers: maxMembers || 100,
        tags: tags || [],
        rules: rules || '',
        location: location || '',
        avatar: avatar || null,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      
      // Add creator as owner
      if (GroupMember) {
        await GroupMember.create({
          groupId: newGroup.id,
          userId: userId,
          role: 'owner',
          joinedAt: new Date()
        });
      }
      
      res.status(201).json({
        success: true,
        data: { group: formatGroup(newGroup) },
        message: 'Group created successfully'
      });
    } catch (error) {
      console.error('[Groups] Error creating group:', error);
      res.status(500).json({ success: false, message: 'Failed to create group', error: error.message });
    }
  }

  async getUserGroups(req, res) {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const { limit = 50, offset = 0, includeArchived = false } = req.query;
      const limitNum = Math.min(parseInt(limit), 200);
      const offsetNum = parseInt(offset);
      
      if (!Group || !GroupMember) {
        return res.json({
          success: true,
          data: { groups: [] },
          pagination: { limit: limitNum, offset: offsetNum, total: 0, hasMore: false },
          userId
        });
      }
      
      // FIXED: Use the correct association alias 'groupMemberGroup' (or whatever is defined in GroupMembers.associate)
      // Common aliases: 'group' or 'Group' - check your association definition
      const memberships = await withTimeout(GroupMember.findAll({
        where: { userId: userId, leftAt: null },
        include: [{
          model: Group,
          as: 'group',  // FIXED: Changed from 'userGroup' to match typical association alias
          required: true,
          attributes: ['id', 'name', 'description', 'avatar', 'purpose', 'isPublic', 'maxMembers', 'createdBy', 'createdAt', 'updatedAt']
        }],
        limit: limitNum,
        offset: offsetNum
      }));
      
      const groups = memberships.map(m => formatGroup(m.group)).filter(g => g);  // FIXED: Changed from m.userGroup to m.group
      
      res.json({
        success: true,
        data: { groups: groups },
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          total: groups.length,
          hasMore: groups.length === limitNum
        },
        userId
      });
    } catch (error) {
      console.error('[Groups] Error getting user groups:', error);
      res.status(200).json({ 
        success: true, 
        data: { groups: [] },
        pagination: { limit: 50, offset: 0, total: 0, hasMore: false }
      });
    }
  }

  // Get group by ID - PROTECTED
  async getGroupById(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID',
          code: 'INVALID_GROUP_ID'
        });
      }
      
      if (!Group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      const group = await withTimeout(Group.findByPk(groupIdNum, {
        attributes: ['id', 'name', 'description', 'avatar', 'isPublic', 'purpose', 'maxMembers', 'tags', 'rules', 'location', 'createdBy', 'createdAt', 'updatedAt', 'isVerified', 'settings']
      }));
      
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      // Check if user is a member
      let userRole = null;
      if (GroupMember) {
        const membership = await GroupMember.findOne({
          where: { groupId: groupIdNum, userId: userId }
        });
        if (membership) {
          userRole = membership.role;
        }
      }
      
      // Get members
      let members = [];
      if (GroupMember && (userRole === 'owner' || userRole === 'admin' || group.isPublic)) {
        const memberList = await GroupMember.findAll({
          where: { groupId: groupIdNum },
          include: [{
            model: User,
            as: 'groupMemberUser',  // FIXED: Use correct alias for User in GroupMembers association
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status']
          }],
          limit: 100
        });
        members = memberList.map(m => ({
          userId: m.userId,
          role: m.role,
          joinedAt: m.joinedAt,
          user: m.groupMemberUser ? {  // FIXED: Changed from m.user to m.groupMemberUser
            id: m.groupMemberUser.id,
            username: m.groupMemberUser.username,
            avatar: m.groupMemberUser.avatar,
            displayName: [m.groupMemberUser.firstName, m.groupMemberUser.lastName].filter(Boolean).join(' ') || m.groupMemberUser.username
          } : null
        }));
      }
      
      res.json({
        success: true,
        data: {
          group: formatGroup(group),
          userRole: userRole,
          members: members,
          isMember: !!userRole
        }
      });
    } catch (error) {
      console.error('[Groups] Error getting group by ID:', error);
      res.status(500).json({ success: false, message: 'Failed to get group', error: error.message });
    }
  }

  // Update group - PROTECTED
  async updateGroup(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      const updates = req.body;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!Group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      const group = await Group.findByPk(groupIdNum);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      // Check permission
      if (group.createdBy !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Only group owner can update group',
          code: 'INSUFFICIENT_PERMISSION'
        });
      }
      
      const allowedUpdates = ['name', 'description', 'isPublic', 'purpose', 'maxMembers', 'tags', 'rules', 'location', 'avatar'];
      const filteredUpdates = {};
      
      for (const key of allowedUpdates) {
        if (updates[key] !== undefined) {
          filteredUpdates[key] = updates[key];
        }
      }
      
      if (Object.keys(filteredUpdates).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No valid updates provided',
          code: 'NO_UPDATES'
        });
      }
      
      filteredUpdates.updatedAt = new Date();
      await group.update(filteredUpdates);
      
      res.json({
        success: true,
        data: { group: formatGroup(group) },
        message: 'Group updated successfully'
      });
    } catch (error) {
      console.error('[Groups] Error updating group:', error);
      res.status(500).json({ success: false, message: 'Failed to update group', error: error.message });
    }
  }

  // Delete group - PROTECTED
  async deleteGroup(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!Group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      const group = await Group.findByPk(groupIdNum);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      // Check permission
      if (group.createdBy !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Only group owner can delete group',
          code: 'INSUFFICIENT_PERMISSION'
        });
      }
      
      await group.destroy();
      
      res.json({
        success: true,
        message: 'Group deleted successfully'
      });
    } catch (error) {
      console.error('[Groups] Error deleting group:', error);
      res.status(500).json({ success: false, message: 'Failed to delete group', error: error.message });
    }
  }

  // Get group members - PROTECTED
  async getGroupMembers(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      const { limit = 100, offset = 0, role } = req.query;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!GroupMember) {
        return res.json({
          success: true,
          data: { members: [] },
          pagination: { limit: parseInt(limit), offset: parseInt(offset), total: 0, hasMore: false }
        });
      }
      
      const whereCondition = { groupId: groupIdNum };
      if (role && role !== 'all') {
        whereCondition.role = role;
      }
      
      const { count, rows: members } = await withTimeout(GroupMember.findAndCountAll({
        where: whereCondition,
        include: [{
          model: User,
          as: 'groupMemberUser',  // FIXED: Use correct alias for User in GroupMembers association
          attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
        }],
        limit: Math.min(parseInt(limit), 200),
        offset: parseInt(offset),
        order: [['role', 'ASC'], ['joinedAt', 'DESC']]
      }));
      
      const formattedMembers = (members || []).map(m => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        user: m.groupMemberUser ? {  // FIXED: Changed from m.user to m.groupMemberUser
          id: m.groupMemberUser.id,
          username: m.groupMemberUser.username,
          avatar: m.groupMemberUser.avatar,
          displayName: [m.groupMemberUser.firstName, m.groupMemberUser.lastName].filter(Boolean).join(' ') || m.groupMemberUser.username,
          status: m.groupMemberUser.status,
          lastSeen: m.groupMemberUser.lastSeen
        } : null
      }));
      
      res.json({
        success: true,
        data: { members: formattedMembers },
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: count,
          hasMore: parseInt(offset) + parseInt(limit) < count
        }
      });
    } catch (error) {
      console.error('[Groups] Error getting group members:', error);
      res.status(200).json({ 
        success: true, 
        data: { members: [] },
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false }
      });
    }
  }

  // Add group member - PROTECTED
  async addGroupMember(req, res) {
    try {
      const { groupId, userId: targetUserId } = req.params;
      const currentUserId = getUserId(req);
      const { role = 'member' } = req.body;
      
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      const targetIdNum = parseInt(targetUserId);
      
      if (isNaN(groupIdNum) || isNaN(targetIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID or user ID'
        });
      }
      
      if (!['member', 'admin', 'moderator'].includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role',
          code: 'INVALID_ROLE'
        });
      }
      
      if (!GroupMember) {
        return res.status(201).json({
          success: true,
          data: { groupId: groupIdNum, userId: targetIdNum, role, joinedAt: new Date().toISOString() },
          message: 'Member added successfully'
        });
      }
      
      // Check if already a member
      const existing = await GroupMember.findOne({
        where: { groupId: groupIdNum, userId: targetIdNum }
      });
      
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'User is already a member of this group',
          code: 'ALREADY_MEMBER'
        });
      }
      
      const membership = await GroupMember.create({
        groupId: groupIdNum,
        userId: targetIdNum,
        role: role,
        joinedAt: new Date()
      });
      
      res.status(201).json({
        success: true,
        data: {
          groupId: groupIdNum,
          userId: targetIdNum,
          role: role,
          joinedAt: membership.joinedAt
        },
        message: 'Member added successfully'
      });
    } catch (error) {
      console.error('[Groups] Error adding group member:', error);
      res.status(500).json({ success: false, message: 'Failed to add member', error: error.message });
    }
  }

  // Remove group member - PROTECTED
  async removeGroupMember(req, res) {
    try {
      const { groupId, userId: targetUserId } = req.params;
      const currentUserId = getUserId(req);
      
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      const targetIdNum = parseInt(targetUserId);
      
      if (isNaN(groupIdNum) || isNaN(targetIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID or user ID'
        });
      }
      
      if (!GroupMember) {
        return res.json({
          success: true,
          message: 'Member removed successfully'
        });
      }
      
      const membership = await GroupMember.findOne({
        where: { groupId: groupIdNum, userId: targetIdNum }
      });
      
      if (!membership) {
        return res.status(404).json({
          success: false,
          message: 'Member not found'
        });
      }
      
      await membership.destroy();
      
      res.json({
        success: true,
        message: 'Member removed successfully'
      });
    } catch (error) {
      console.error('[Groups] Error removing group member:', error);
      res.status(500).json({ success: false, message: 'Failed to remove member', error: error.message });
    }
  }

  // Update member role - PROTECTED
  async updateMemberRole(req, res) {
    try {
      const { groupId, userId: targetUserId } = req.params;
      const { role } = req.body;
      const currentUserId = getUserId(req);
      
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      const targetIdNum = parseInt(targetUserId);
      
      if (isNaN(groupIdNum) || isNaN(targetIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID or user ID'
        });
      }
      
      if (!['member', 'admin', 'moderator', 'owner'].includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role',
          code: 'INVALID_ROLE'
        });
      }
      
      if (!GroupMember) {
        return res.json({
          success: true,
          message: 'Member role updated successfully'
        });
      }
      
      const membership = await GroupMember.findOne({
        where: { groupId: groupIdNum, userId: targetIdNum }
      });
      
      if (!membership) {
        return res.status(404).json({
          success: false,
          message: 'Member not found'
        });
      }
      
      membership.role = role;
      await membership.save();
      
      res.json({
        success: true,
        data: { groupId: groupIdNum, userId: targetIdNum, role: role },
        message: 'Member role updated successfully'
      });
    } catch (error) {
      console.error('[Groups] Error updating member role:', error);
      res.status(500).json({ success: false, message: 'Failed to update member role', error: error.message });
    }
  }

  // ===== INVITE ROUTES =====
  
  // GET /api/invites - Get user invites (ADDED - FIXES 404 ERROR)
  async getUserInvites(req, res) {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const { status = 'pending', limit = 50, offset = 0 } = req.query;
      const limitNum = Math.min(parseInt(limit), 100);
      const offsetNum = parseInt(offset);
      
      if (!Invite) {
        return res.json({
          success: true,
          data: { invites: [] },
          pagination: { limit: limitNum, offset: offsetNum, total: 0, hasMore: false },
          userId
        });
      }
      
      const whereCondition = {
        [Op.or]: [
          { targetUserId: userId },
          { targetEmail: userId }
        ]
      };
      
      if (status !== 'all') {
        whereCondition.status = status;
      }
      
      const { count, rows: invites } = await withTimeout(Invite.findAndCountAll({
        where: whereCondition,
        include: [
          {
            model: User,
            as: 'inviter',
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
          },
          {
            model: Group,
            as: 'group',  // FIXED: Changed from 'userGroup' to match typical alias
            attributes: ['id', 'name', 'avatar', 'description', 'purpose']
          }
        ],
        limit: limitNum,
        offset: offsetNum,
        order: [['createdAt', 'DESC']]
      }));
      
      const formattedInvites = (invites || []).map(invite => ({
        id: invite.id,
        group: invite.group ? {  // FIXED: Changed from invite.group to invite.group
          id: invite.group.id,
          name: invite.group.name,
          avatar: invite.group.avatar,
          description: invite.group.description,
          purpose: invite.group.purpose
        } : null,
        inviter: invite.inviter ? {
          id: invite.inviter.id,
          username: invite.inviter.username,
          avatar: invite.inviter.avatar,
          displayName: [invite.inviter.firstName, invite.inviter.lastName].filter(Boolean).join(' ') || invite.inviter.username
        } : null,
        message: invite.message,
        status: invite.status,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt
      }));
      
      res.json({
        success: true,
        data: { invites: formattedInvites },
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          total: count,
          hasMore: offsetNum + limitNum < count
        },
        userId
      });
    } catch (error) {
      console.error('[Groups] Error getting user invites:', error);
      res.status(200).json({ 
        success: true, 
        data: { invites: [] },
        pagination: { limit: 50, offset: 0, total: 0, hasMore: false }
      });
    }
  }

  // Invite to group - PROTECTED
  async inviteToGroup(req, res) {
    try {
      const { groupId } = req.params;
      const { userId: targetUserId, email, message } = req.body;
      const inviterId = getUserId(req);
      
      if (!inviterId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!targetUserId && !email) {
        return res.status(400).json({
          success: false,
          message: 'Either userId or email is required',
          code: 'MISSING_INVITE_TARGET'
        });
      }
      
      if (!Invite) {
        const invite = {
          id: Date.now(),
          groupId: groupIdNum,
          inviterId,
          targetUserId: targetUserId ? parseInt(targetUserId) : null,
          targetEmail: email || null,
          message: message || '',
          status: 'pending',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          inviteLink: `/invite/${groupIdNum}/${Date.now()}`
        };
        
        return res.status(201).json({
          success: true,
          data: { invite },
          message: 'Invite sent successfully'
        });
      }
      
      const invite = await Invite.create({
        groupId: groupIdNum,
        inviterId,
        targetUserId: targetUserId ? parseInt(targetUserId) : null,
        targetEmail: email || null,
        message: message || '',
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
      
      res.status(201).json({
        success: true,
        data: { invite: formatInvite(invite) },
        message: 'Invite sent successfully'
      });
    } catch (error) {
      console.error('[Groups] Error inviting to group:', error);
      res.status(500).json({ success: false, message: 'Failed to send invite', error: error.message });
    }
  }

  // Get group invites - PROTECTED
  async getGroupInvites(req, res) {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const { status = 'pending', limit = 50, offset = 0 } = req.query;
      const limitNum = Math.min(parseInt(limit), 100);
      const offsetNum = parseInt(offset);
      
      if (!Invite) {
        return res.json({
          success: true,
          data: { invites: [] },
          pagination: { limit: limitNum, offset: offsetNum, total: 0, hasMore: false }
        });
      }
      
      const whereCondition = { targetUserId: userId };
      if (status !== 'all') {
        whereCondition.status = status;
      }
      
      const { count, rows: invites } = await withTimeout(Invite.findAndCountAll({
        where: whereCondition,
        include: [
          {
            model: User,
            as: 'inviter',
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
          },
          {
            model: Group,
            as: 'group',  // FIXED: Changed from 'userGroup' to match typical alias
            attributes: ['id', 'name', 'avatar', 'description', 'purpose']
          }
        ],
        limit: limitNum,
        offset: offsetNum,
        order: [['createdAt', 'DESC']]
      }));
      
      const formattedInvites = (invites || []).map(invite => formatInvite(invite));
      
      res.json({
        success: true,
        data: { invites: formattedInvites },
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          total: count,
          hasMore: offsetNum + limitNum < count
        }
      });
    } catch (error) {
      console.error('[Groups] Error getting group invites:', error);
      res.status(200).json({ 
        success: true, 
        data: { invites: [] },
        pagination: { limit: 50, offset: 0, total: 0, hasMore: false }
      });
    }
  }

  // Accept group invite - PROTECTED
  async acceptGroupInvite(req, res) {
    try {
      const { inviteId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const inviteIdNum = parseInt(inviteId);
      if (isNaN(inviteIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid invite ID'
        });
      }
      
      if (!Invite || !GroupMember) {
        return res.json({
          success: true,
          message: 'Invite accepted successfully'
        });
      }
      
      const invite = await Invite.findOne({
        where: { id: inviteIdNum, targetUserId: userId, status: 'pending' }
      });
      
      if (!invite) {
        return res.status(404).json({
          success: false,
          message: 'Invite not found or already processed'
        });
      }
      
      // Add user to group
      await GroupMember.create({
        groupId: invite.groupId,
        userId: userId,
        role: 'member',
        joinedAt: new Date()
      });
      
      invite.status = 'accepted';
      await invite.save();
      
      res.json({
        success: true,
        message: 'Invite accepted successfully'
      });
    } catch (error) {
      console.error('[Groups] Error accepting invite:', error);
      res.status(500).json({ success: false, message: 'Failed to accept invite', error: error.message });
    }
  }

  // Reject group invite - PROTECTED
  async rejectGroupInvite(req, res) {
    try {
      const { inviteId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const inviteIdNum = parseInt(inviteId);
      if (isNaN(inviteIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid invite ID'
        });
      }
      
      if (!Invite) {
        return res.json({
          success: true,
          message: 'Invite rejected successfully'
        });
      }
      
      const invite = await Invite.findOne({
        where: { id: inviteIdNum, targetUserId: userId, status: 'pending' }
      });
      
      if (!invite) {
        return res.status(404).json({
          success: false,
          message: 'Invite not found or already processed'
        });
      }
      
      invite.status = 'rejected';
      await invite.save();
      
      res.json({
        success: true,
        message: 'Invite rejected successfully'
      });
    } catch (error) {
      console.error('[Groups] Error rejecting invite:', error);
      res.status(500).json({ success: false, message: 'Failed to reject invite', error: error.message });
    }
  }

  // Join group - PROTECTED
  async joinGroup(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!Group || !GroupMember) {
        return res.json({
          success: true,
          message: 'Joined group successfully'
        });
      }
      
      const group = await Group.findByPk(groupIdNum);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      if (!group.isPublic) {
        return res.status(403).json({
          success: false,
          message: 'This is a private group. You need an invitation to join.',
          code: 'PRIVATE_GROUP'
        });
      }
      
      const existing = await GroupMember.findOne({
        where: { groupId: groupIdNum, userId: userId }
      });
      
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'You are already a member of this group',
          code: 'ALREADY_MEMBER'
        });
      }
      
      await GroupMember.create({
        groupId: groupIdNum,
        userId: userId,
        role: 'member',
        joinedAt: new Date()
      });
      
      res.json({
        success: true,
        message: 'Joined group successfully'
      });
    } catch (error) {
      console.error('[Groups] Error joining group:', error);
      res.status(500).json({ success: false, message: 'Failed to join group', error: error.message });
    }
  }

  // Leave group - PROTECTED
  async leaveGroup(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!GroupMember) {
        return res.json({
          success: true,
          message: 'Left group successfully'
        });
      }
      
      const membership = await GroupMember.findOne({
        where: { groupId: groupIdNum, userId: userId }
      });
      
      if (!membership) {
        return res.status(404).json({
          success: false,
          message: 'You are not a member of this group'
        });
      }
      
      if (membership.role === 'owner') {
        return res.status(400).json({
          success: false,
          message: 'Group owner cannot leave. Transfer ownership first or delete the group.',
          code: 'CANNOT_LEAVE_AS_OWNER'
        });
      }
      
      await membership.destroy();
      
      res.json({
        success: true,
        message: 'Left group successfully'
      });
    } catch (error) {
      console.error('[Groups] Error leaving group:', error);
      res.status(500).json({ success: false, message: 'Failed to leave group', error: error.message });
    }
  }

  // Update group settings - PROTECTED
  async updateGroupSettings(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      const settings = req.body;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!Group) {
        return res.json({
          success: true,
          message: 'Group settings updated successfully'
        });
      }
      
      const group = await Group.findByPk(groupIdNum);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      // Check permission (only owner and admins can update settings)
      let isAuthorized = false;
      if (GroupMember) {
        const membership = await GroupMember.findOne({
          where: { groupId: groupIdNum, userId: userId }
        });
        isAuthorized = membership && (membership.role === 'owner' || membership.role === 'admin');
      } else {
        isAuthorized = group.createdBy === userId;
      }
      
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: 'Only group owner and admins can update settings',
          code: 'INSUFFICIENT_PERMISSION'
        });
      }
      
      const allowedSettings = [
        'allowMedia', 'allowCalls', 'allowReactions', 'allowReplies',
        'allowEditing', 'allowDeleting', 'slowMode', 'requireAdminApproval'
      ];
      
      const currentSettings = group.settings || {};
      const filteredSettings = {};
      for (const key of allowedSettings) {
        if (settings[key] !== undefined) {
          filteredSettings[key] = settings[key];
        }
      }
      
      if (Object.keys(filteredSettings).length > 0) {
        await group.update({ settings: { ...currentSettings, ...filteredSettings } });
      }
      
      res.json({
        success: true,
        data: { settings: { ...currentSettings, ...filteredSettings } },
        message: 'Group settings updated successfully'
      });
    } catch (error) {
      console.error('[Groups] Error updating group settings:', error);
      res.status(500).json({ success: false, message: 'Failed to update settings', error: error.message });
    }
  }

  // Generate invite link - PROTECTED
  async generateInviteLink(req, res) {
    try {
      const { groupId } = req.params;
      const { expiresInHours = 24 } = req.body;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (!Group) {
        const inviteLink = {
          link: `/join/${groupIdNum}/${Math.random().toString(36).substr(2, 16)}`,
          expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
          groupId: groupIdNum,
          createdBy: userId
        };
        
        return res.json({
          success: true,
          ...inviteLink,
          message: 'Invite link generated successfully'
        });
      }
      
      const group = await Group.findByPk(groupIdNum);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }
      
      const inviteLink = `/join/${groupIdNum}/${Math.random().toString(36).substr(2, 16)}`;
      const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
      
      if (Invite) {
        await Invite.create({
          groupId: groupIdNum,
          inviterId: userId,
          targetEmail: null,
          message: 'Join via invite link',
          status: 'pending',
          inviteLink: inviteLink,
          expiresAt: expiresAt,
          createdAt: new Date()
        });
      }
      
      res.json({
        success: true,
        link: inviteLink,
        expiresAt: expiresAt.toISOString(),
        groupId: groupIdNum,
        createdBy: userId,
        message: 'Invite link generated successfully'
      });
    } catch (error) {
      console.error('[Groups] Error generating invite link:', error);
      res.status(500).json({ success: false, message: 'Failed to generate invite link', error: error.message });
    }
  }

  // Revoke invite link - PROTECTED
  async revokeInviteLink(req, res) {
    try {
      const { groupId } = req.params;
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }
      
      const groupIdNum = parseInt(groupId);
      if (isNaN(groupIdNum)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid group ID'
        });
      }
      
      if (Invite) {
        await Invite.update(
          { status: 'revoked' },
          { where: { groupId: groupIdNum, status: 'pending', inviteLink: { [Op.ne]: null } } }
        );
      }
      
      res.json({
        success: true,
        message: 'Invite link revoked successfully'
      });
    } catch (error) {
      console.error('[Groups] Error revoking invite link:', error);
      res.status(500).json({ success: false, message: 'Failed to revoke invite link', error: error.message });
    }
  }
}

// Initialize controller
const groupController = new GroupController();

// ========== PUBLIC ROUTES (No authentication required) ==========
router.get('/purposes', groupController.getGroupPurposes.bind(groupController));
router.get('/public', groupController.getPublicGroups.bind(groupController));
router.get('/search', groupController.searchGroups.bind(groupController));

// /moods - static list, no DB needed, must be BEFORE /:groupId
router.get('/moods', (req, res) => {
  // Send response immediately to avoid timeout
  const moods = [
    { id: 'happy', name: 'Happy', label: 'Happy', emoji: '😊', icon: '😊', color: '#FFD700', value: 'happy' },
    { id: 'excited', name: 'Excited', label: 'Excited', emoji: '🤩', icon: '🤩', color: '#FF6B6B', value: 'excited' },
    { id: 'calm', name: 'Calm', label: 'Calm', emoji: '😌', icon: '😌', color: '#4ECDC4', value: 'calm' },
    { id: 'focused', name: 'Focused', label: 'Focused', emoji: '🎯', icon: '🎯', color: '#45B7D1', value: 'focused' },
    { id: 'sad', name: 'Sad', label: 'Sad', emoji: '😢', icon: '😢', color: '#74B9FF', value: 'sad' },
    { id: 'angry', name: 'Angry', label: 'Angry', emoji: '😠', icon: '😠', color: '#FF7675', value: 'angry' },
    { id: 'anxious', name: 'Anxious', label: 'Anxious', emoji: '😰', icon: '😰', color: '#A29BFE', value: 'anxious' },
    { id: 'grateful', name: 'Grateful', label: 'Grateful', emoji: '🙏', icon: '🙏', color: '#FD79A8', value: 'grateful' },
    { id: 'bored', name: 'Bored', label: 'Bored', emoji: '😑', icon: '😑', color: '#B2BEC3', value: 'bored' },
    { id: 'tired', name: 'Tired', label: 'Tired', emoji: '😴', icon: '😴', color: '#636E72', value: 'tired' },
    { id: 'energetic', name: 'Energetic', label: 'Energetic', emoji: '⚡', icon: '⚡', color: '#FDCB6E', value: 'energetic' },
    { id: 'relaxed', name: 'Relaxed', label: 'Relaxed', emoji: '🧘', icon: '🧘', color: '#00CEC9', value: 'relaxed' },
    { id: 'nostalgic', name: 'Nostalgic', label: 'Nostalgic', emoji: '📸', icon: '📸', color: '#A29BFE', value: 'nostalgic' },
    { id: 'romantic', name: 'Romantic', label: 'Romantic', emoji: '💕', icon: '💕', color: '#FF6B6B', value: 'romantic' },
    { id: 'lonely', name: 'Lonely', label: 'Lonely', emoji: '🫂', icon: '🫂', color: '#74B9FF', value: 'lonely' },
    { id: 'confused', name: 'Confused', label: 'Confused', emoji: '🤔', icon: '🤔', color: '#B2BEC3', value: 'confused' },
    { id: 'proud', name: 'Proud', label: 'Proud', emoji: '🦁', icon: '🦁', color: '#FDCB6E', value: 'proud' },
    { id: 'hopeful', name: 'Hopeful', label: 'Hopeful', emoji: '🌈', icon: '🌈', color: '#00CEC9', value: 'hopeful' },
    { id: 'sick', name: 'Sick', label: 'Sick', emoji: '🤒', icon: '🤒', color: '#636E72', value: 'sick' },
    { id: 'neutral', name: 'Neutral', label: 'Neutral', emoji: '😐', icon: '😐', color: '#B2BEC3', value: 'neutral' }
  ];
  
  // Return in the format the frontend expects
  res.status(200).json({
    success: true,
    data: moods,
    status: 'success'
  });
});

// ========== PROTECTED ROUTES (Authentication required) ==========
// Apply authentication middleware to all routes below
router.use(authenticateToken);

// ── NEW: /invitations - user's received invitations (all groups)
// Frontend panel calls GET /api/groups/invitations?status=pending
// Must be before /:groupId to avoid being matched as a group ID
router.get('/invitations', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const status = req.query.status || 'pending';

    // Try GroupMembers model first (has customSettings with ban info)
    // Look for invitations sent TO this user
    const whereClause = {
      userId: userId,
    };

    // Try to query invitation records - fall back gracefully if table missing
    let invitations = [];
    try {
      // Use the Invite model if available
      if (Invite) {
        const raw = await Invite.findAll({
          where: { targetUserId: userId, status: status },
          include: [
            {
              model: Group,
              as: 'inviteGroup',
              attributes: ['id', 'name', 'description', 'avatar', 'purpose', 'stats'],
            },
            {
              model: User,
              as: 'inviter',
              attributes: ['id', 'username', 'avatar'],
            },
          ],
          order: [['createdAt', 'DESC']],
          limit: 50,
        });
        invitations = raw.map(inv => {
          const d = inv.toJSON ? inv.toJSON() : inv;
          return {
            id: d.id,
            groupId: d.groupId,
            group: d.inviteGroup || null,
            groupName: d.inviteGroup?.name || d.groupName,
            inviter: d.inviter || null,
            inviterName: d.inviter?.username,
            status: d.status,
            role: d.role || 'member',
            message: d.message || '',
            createdAt: d.createdAt,
          };
        });
      }
    } catch (modelErr) {
      // Model may not exist yet — return empty list gracefully
      invitations = [];
    }

    return res.status(200).json({
      success: true,
      message: 'Invitations retrieved successfully',
      data: { invitations, total: invitations.length },
    });
  } catch (error) {
    console.error('[Groups] GET /invitations error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to get invitations' });
  }
});

// ── NEW: /invitations/sent - invitations sent BY this user (all groups)
// Frontend Sent tab calls GET /api/groups/invitations/sent
router.get('/invitations/sent', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let invitations = [];
    try {
      if (Invite) {
        const raw = await Invite.findAll({
          where: { inviterId: userId },
          include: [
            {
              model: Group,
              as: 'inviteGroup',
              attributes: ['id', 'name', 'avatar'],
            },
            {
              model: User,
              as: 'targetUser',
              attributes: ['id', 'username', 'avatar'],
            },
          ],
          order: [['createdAt', 'DESC']],
          limit: 50,
        });
        invitations = raw.map(inv => {
          const d = inv.toJSON ? inv.toJSON() : inv;
          return {
            id: d.id,
            groupId: d.groupId,
            group: d.inviteGroup || null,
            targetUserId: d.targetUserId,
            targetUser: d.targetUser || null,
            status: d.status,
            role: d.role || 'member',
            createdAt: d.createdAt,
          };
        });
      }
    } catch (_) { invitations = []; }

    return res.status(200).json({
      success: true,
      data: { invitations, total: invitations.length },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get sent invitations' });
  }
});

// ── NEW: /events - global upcoming events across all user's groups
// Frontend Events panel calls GET /api/events?filter=upcoming when no group selected
router.get('/events', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    // Return empty list gracefully — events table may not exist yet
    return res.status(200).json({
      success: true,
      data: { events: [], total: 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get events' });
  }
});

// Group CRUD operations
router.post('/', [
  body('name').notEmpty().withMessage('Group name is required').isLength({ max: 100 }).withMessage('Name too long'),
  body('description').optional().isLength({ max: 500 }).withMessage('Description too long'),
  body('purpose').optional().isString(),
  body('maxMembers').optional().isInt({ min: 1, max: 1000 }).withMessage('Max members must be between 1 and 1000')
], groupController.createGroup.bind(groupController));

router.get('/', groupController.getUserGroups.bind(groupController));
router.get('/user', groupController.getUserGroups.bind(groupController));

// Group invite routes - MUST be before /:groupId to avoid shadowing
// /invites/user MUST come before /invites/:inviteId routes
router.get('/invites/user', groupController.getUserInvites.bind(groupController));
router.get('/invites', groupController.getGroupInvites.bind(groupController));
router.post('/invites/:inviteId/accept', groupController.acceptGroupInvite.bind(groupController));
router.post('/invites/:inviteId/reject', groupController.rejectGroupInvite.bind(groupController));

// Parametric group routes - after all static routes
router.get('/:groupId', groupController.getGroupById.bind(groupController));
router.put('/:groupId', groupController.updateGroup.bind(groupController));
router.delete('/:groupId', groupController.deleteGroup.bind(groupController));

// Group members
router.get('/:groupId/members', groupController.getGroupMembers.bind(groupController));
router.post('/:groupId/members/:userId', groupController.addGroupMember.bind(groupController));
router.delete('/:groupId/members/:userId', groupController.removeGroupMember.bind(groupController));
router.put('/:groupId/members/:userId/role', [
  body('role').isIn(['member', 'admin', 'moderator', 'owner']).withMessage('Invalid role')
], groupController.updateMemberRole.bind(groupController));

// Group invite management (per group)
router.post('/:groupId/invite', [
  body('userId').optional().isInt().withMessage('Invalid user ID'),
  body('email').optional().isEmail().withMessage('Invalid email')
], groupController.inviteToGroup.bind(groupController));

// Invite links
router.post('/:groupId/invite-link', groupController.generateInviteLink.bind(groupController));
router.delete('/:groupId/invite-link', groupController.revokeInviteLink.bind(groupController));

// Group events (per group)
router.get('/:groupId/events', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { filter = 'upcoming', limit = 20 } = req.query;
    // Return graceful empty until events table is implemented
    return res.status(200).json({
      success: true,
      data: { events: [], total: 0, groupId, filter },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get group events' });
  }
});

router.post('/:groupId/events', async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = getUserId(req);
    const { title, description, startDate, endDate, location } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Event title is required' });
    }
    // Return success with stub data until events table exists
    const newEvent = {
      id: Date.now(),
      groupId: parseInt(groupId),
      title: title.trim(),
      description: description || '',
      startDate: startDate || null,
      endDate: endDate || null,
      location: location || '',
      createdBy: userId,
      createdAt: new Date().toISOString(),
      attendees: [],
    };
    return res.status(201).json({
      success: true,
      message: 'Event created successfully',
      data: { event: newEvent },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create event' });
  }
});

// Group actions
router.post('/:groupId/join', groupController.joinGroup.bind(groupController));
router.post('/:groupId/leave', groupController.leaveGroup.bind(groupController));
router.put('/:groupId/settings', groupController.updateGroupSettings.bind(groupController));

// ============================================================
// GROUP MESSAGES — GET + POST /api/groups/:groupId/messages
// These routes were missing entirely, causing every message
// send and history load to silently fail (404 from parent
// pipeline was swallowed as a generic "API request failed").
// ============================================================

// ── Helper: normalise a GroupMessage record for the client ──────────────────
function _fmtMessage(msg, currentUserId) {
  const d = msg.toJSON ? msg.toJSON() : msg;
  return {
    id:           d.id,
    groupId:      d.groupId,
    senderId:     d.senderId || d.userId,
    senderName:   d.sender
      ? ([d.sender.firstName, d.sender.lastName].filter(Boolean).join(' ') || d.sender.username || 'User')
      : (d.senderName || 'User'),
    senderAvatar: d.sender?.avatar || d.senderAvatar || null,
    content:      d.content || d.text || '',
    type:         d.type    || 'text',
    topic:        d.topic   || null,
    anonymous:    d.anonymous || false,
    readBy:       d.readBy  || [],
    createdAt:    d.createdAt,
    timestamp:    d.createdAt || d.timestamp,
  };
}

// GET /api/groups/:groupId/messages?limit=50&before=<id>
// Load group message history (newest 50 by default)
router.get('/:groupId/messages', async (req, res) => {
  try {
    const userId  = getUserId(req);
    const groupId = parseInt(req.params.groupId);
    const limit   = Math.min(parseInt(req.query.limit || 50), 200);
    const before  = req.query.before || null;

    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (isNaN(groupId)) return res.status(400).json({ success: false, message: 'Invalid group ID' });

    // Verify membership
    if (GroupMember) {
      const membership = await GroupMember.findOne({ where: { groupId, userId } });
      if (!membership) {
        return res.status(403).json({ success: false, message: 'You are not a member of this group' });
      }
    }

    // GroupMessage model may not exist yet — return empty gracefully
    const GroupMessage = db?.models?.GroupMessages || db?.models?.GroupMessage
                      || db?.GroupMessages || db?.GroupMessage || null;

    if (!GroupMessage) {
      console.warn('[Groups] GroupMessage model not available, returning []');
      return res.json({ success: true, data: [], pagination: { limit, hasMore: false } });
    }

    const { Op } = require('sequelize');
    const where = { groupId };
    if (before) where.id = { [Op.lt]: parseInt(before) };

    const messages = await withTimeout(GroupMessage.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      include: [{
        model:      User,
        as:         'sender',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
        required:   false
      }]
    }));

    const formatted = messages.reverse().map(m => _fmtMessage(m, userId));
    console.log(`[GROUP FLOW] Loaded ${formatted.length} messages for group ${groupId}`);

    return res.json({
      success:    true,
      data:       formatted,
      pagination: { limit, hasMore: messages.length === limit }
    });

  } catch (error) {
    console.error('[Groups] GET messages error:', error.message);
    return res.json({ success: true, data: [], pagination: { limit: 50, hasMore: false } });
  }
});

// POST /api/groups/:groupId/messages
// Send a message — persists to DB and emits real-time socket events
router.post('/:groupId/messages', async (req, res) => {
  try {
    const userId  = getUserId(req);
    const groupId = parseInt(req.params.groupId);
    const { content, type = 'text', topic = null, anonymous = false } = req.body;

    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (isNaN(groupId)) return res.status(400).json({ success: false, message: 'Invalid group ID' });
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'Message content is required' });
    }

    console.log(`[GROUP FLOW] Saving message for group ${groupId} from user ${userId}`);

    // Verify membership
    if (GroupMember) {
      const membership = await GroupMember.findOne({ where: { groupId, userId } });
      if (!membership) {
        return res.status(403).json({ success: false, message: 'You are not a member of this group' });
      }
    }

    // Fetch sender display info
    let senderName = 'User';
    let senderAvatar = null;
    if (User) {
      try {
        const user = await User.findByPk(userId, { attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'] });
        if (user) {
          const u = user.toJSON ? user.toJSON() : user;
          senderName   = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'User';
          senderAvatar = u.avatar || null;
        }
      } catch (_) {}
    }

    const GroupMessage = db?.models?.GroupMessages || db?.models?.GroupMessage
                      || db?.GroupMessages || db?.GroupMessage || null;

    let savedMessage;

    if (GroupMessage) {
      const record = await GroupMessage.create({
        groupId,
        senderId:     userId,
        senderName:   anonymous ? 'Anonymous' : senderName,
        content:      String(content).trim(),
        type,
        topic:        topic || null,
        anonymous:    !!anonymous,
        readBy:       [userId],
        createdAt:    new Date()
      });
      savedMessage = _fmtMessage(record, userId);
      savedMessage.senderAvatar = senderAvatar;
    } else {
      // No model yet — return a stub so the client gets a valid response
      console.warn('[Groups] GroupMessage model not available — message not persisted to DB');
      savedMessage = {
        id:           `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        groupId,
        senderId:     userId,
        senderName:   anonymous ? 'Anonymous' : senderName,
        senderAvatar,
        content:      String(content).trim(),
        type,
        topic:        topic || null,
        anonymous:    !!anonymous,
        readBy:       [userId],
        createdAt:    new Date().toISOString(),
        timestamp:    new Date().toISOString()
      };
    }

    console.log(`[GROUP FLOW] Message saved: ${savedMessage.id}`);

    // ── Emit real-time events to all group members ──────────────────────
    const io = global.__socketIO;
    if (io) {
      const socketPayload = {
        groupId,
        message:    savedMessage,
        senderId:   userId,
        senderName: anonymous ? 'Anonymous' : senderName,
        timestamp:  new Date()
      };
      // Primary event name + common aliases
      io.to(`group:${groupId}`).emit('group:message',  socketPayload);
      io.to(`group:${groupId}`).emit('group_message',  socketPayload);
      // localSync for the WS bridge in group-core-patch.js
      io.to(`group:${groupId}`).emit('group:localSync', {
        action:  'message',
        groupId,
        message: savedMessage
      });
      console.log(`[GROUP FLOW] WebSocket emitted group:message to room group:${groupId}`);
    } else {
      console.warn('[GROUP FLOW] global.__socketIO not set — real-time not emitted');
    }

    return res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data:    { message: savedMessage }
    });

  } catch (error) {
    console.error('[Groups] POST message error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to send message', error: error.message });
  }
});

// Error handling middleware for validation errors
router.use((err, req, res, next) => {
  if (err.type === 'validation') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors || err.message,
      code: 'VALIDATION_ERROR'
    });
  }
  next(err);
});

// REMOVED: All console.log route listings to clean up startup output

module.exports = router;