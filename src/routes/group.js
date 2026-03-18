const express = require('express');
const router = express.Router();

// Import database models
const db = require('../models');
const User = db.User || db.Users;
const Chat = db.Chat;
const Message = db.Message;
const GroupInvite = db.GroupInvite;

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } =require('../middleware/rateLimiter');

// Use the unified authentication middleware
router.use(authenticateToken);

console.log('✅ Group routes initialized');

// Helper function to check authentication
const checkAuth = (req, res) => {
  if (!req.user || (!req.user.userId && !req.user.id)) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
  const userId = req.user.userId || req.user.id;
  return { userId };
};

// Helper function to check database models
const checkModels = (res) => {
  if (!db || !User || !Chat || !Message) {
    return res.status(503).json({
      status: 'error',
      message: 'Database service not available'
    });
  }
  return true;
};

// GET /groups/user - safe response
router.get(
  '/user',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: []
      });
    } catch (error) {
      console.error('Error in groups/user endpoint:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user groups'
      });
    }
  })
);

// GET /groups/invites - safe response
router.get(
  '/invites',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: []
      });
    } catch (error) {
      console.error('Error in groups/invites endpoint:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch invites'
      });
    }
  })
);

// GET /groups/purposes - safe response
router.get(
  '/purposes',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: []
      });
    } catch (error) {
      console.error('Error in groups/purposes endpoint:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch purposes'
      });
    }
  })
);

// GET /groups/moods - safe response
router.get(
  '/moods',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: []
      });
    } catch (error) {
      console.error('Error in groups/moods endpoint:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch moods'
      });
    }
  })
);

// GET /groups/notes - safe response
router.get(
  '/notes',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: []
      });
    } catch (error) {
      console.error('Error in groups/notes endpoint:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch notes'
      });
    }
  })
);

// GET /groups/ping - debug endpoint
router.get(
  '/ping',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      res.json({ ok: true, route: "groups" });
    } catch (error) {
      console.error('Ping error:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  })
);

// GET /groups - get all groups
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const {
        page = 1,
        limit = 20,
        role = 'all',
        search,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = {
        chatType: 'group',
        '$participants.id$': userId,
        isArchived: false,
      };

      if (role === 'admin') {
        where['$admins.id$'] = userId;
      } else if (role === 'member') {
        where['$admins.id$'] = { [Op.ne]: userId };
      }

      if (search && search.trim()) {
        where.chatName = { [Op.iLike]: `%${search}%` };
      }

      const { count, rows: groups } = await Chat.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status'],
            through: { attributes: [] },
            limit: 5
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          },
          {
            model: Message,
            as: 'lastMessage',
            attributes: ['content', 'senderId', 'createdAt', 'messageType']
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          }
        ],
        order: [['updatedAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        distinct: true
      });

      const groupsWithMetadata = await Promise.all(
        (groups || []).map(async group => {
          const groupObj = group.toJSON ? group.toJSON() : group;
          const isAdmin = group.admins && group.admins.some(admin => admin.id === userId);
          const participantCount = group.participants ? group.participants.length : 0;
          const onlineCount = group.participants ? group.participants.filter(p => p.online).length : 0;
          
          let userUnread = 0;
          if (group.getUnreadCount) {
            userUnread = await group.getUnreadCount(userId) || 0;
          }

          return {
            ...groupObj,
            isAdmin,
            participantCount,
            onlineCount,
            unreadCount: userUnread,
          };
        })
      );

      res.status(200).json({
        status: 'success',
        data: {
          groups: groupsWithMetadata,
          pagination: {
            total: count || 0,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: count ? Math.ceil(count / parseInt(limit)) : 0,
          },
        },
      });
    } catch (error) {
      console.error('Error fetching groups:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch groups'
      });
    }
  })
);

// POST /groups - create group
router.post(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const {
        name,
        description,
        avatar,
        participantIds,
        isPublic = false,
        joinSettings = 'invite_only',
      } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({
          status: 'error',
          message: 'Group name is required'
        });
      }

      if (name.length > 100) {
        return res.status(400).json({
          status: 'error',
          message: 'Group name must be less than 100 characters'
        });
      }

      const allParticipants = [userId];
      if (Array.isArray(participantIds) && participantIds.length > 0) {
        const uniqueParticipants = [...new Set(participantIds.filter(id => id !== userId))];

        if (uniqueParticipants.length > 0) {
          const participants = await User.findAll({
            where: { id: uniqueParticipants },
            attributes: ['id', 'username', 'blockedUsers']
          });

          if (participants.length !== uniqueParticipants.length) {
            return res.status(404).json({
              status: 'error',
              message: 'One or more participants not found'
            });
          }

          const currentUser = await User.findByPk(userId, {
            include: [{
              model: User,
              as: 'blockedUsers',
              attributes: ['id']
            }]
          });

          if (!currentUser) {
            return res.status(404).json({
              status: 'error',
              message: 'User not found'
            });
          }

          const blockedParticipants = participants.filter(p =>
            (currentUser.blockedUsers && currentUser.blockedUsers.some(bu => bu.id === p.id)) ||
            (p.blockedUsers && p.blockedUsers.some(bu => bu.id === userId))
          );

          if (blockedParticipants.length > 0) {
            return res.status(403).json({
              status: 'error',
              message: 'Cannot add blocked users to group'
            });
          }

          allParticipants.push(...participants.map(p => p.id));
        }
      }

      const group = await Chat.create({
        chatType: 'group',
        chatName: name.trim(),
        description: description?.trim(),
        avatar,
        createdBy: userId,
        isPublic,
        joinSettings,
        settings: {
          allowMemberInvites: true,
          allowMessageDeletion: true,
          requireAdminApproval: false,
          maxParticipants: 1000,
        },
      });

      if (!group) {
        return res.status(500).json({
          status: 'error',
          message: 'Failed to create group'
        });
      }

      await group.setParticipants(allParticipants);
      await group.setAdmins([userId]);

      const populatedGroup = await Chat.findByPk(group.id, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'socketIds'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          }
        ]
      });

      const currentUser = await User.findByPk(userId);

      if (req.io && currentUser && populatedGroup && populatedGroup.participants) {
        const notificationData = {
          group: populatedGroup.toJSON ? populatedGroup.toJSON() : populatedGroup,
          createdBy: {
            id: currentUser.id,
            username: currentUser.username,
            avatar: currentUser.avatar,
          },
        };

        populatedGroup.participants.forEach(participant => {
          if (participant.socketIds && Array.isArray(participant.socketIds) && participant.socketIds.length > 0) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:created', notificationData);
            });
          }
        });
      }

      res.status(201).json({
        status: 'success',
        message: 'Group created successfully',
        data: { group: populatedGroup },
      });
    } catch (error) {
      console.error('Error creating group:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to create group'
      });
    }
  })
);

// GET /groups/:groupId - get group by ID
router.get(
  '/:groupId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': userId,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'online', 'status', 'lastActive'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar', 'displayName']
          },
          {
            model: User,
            as: 'createdByUser',
            attributes: ['username', 'avatar']
          },
          {
            model: Message,
            as: 'lastMessage',
            attributes: ['content', 'senderId', 'createdAt', 'messageType']
          }
        ]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or access denied'
        });
      }

      const groupData = group.toJSON ? group.toJSON() : group;
      groupData.isAdmin = group.admins && group.admins.some(admin => admin.id === userId);
      groupData.participantCount = group.participants ? group.participants.length : 0;
      groupData.onlineCount = group.participants ? group.participants.filter(p => p.online).length : 0;
      
      let userUnread = 0;
      if (group.getUnreadCount) {
        userUnread = await group.getUnreadCount(userId) || 0;
      }
      groupData.unreadCount = userUnread;

      res.status(200).json({
        status: 'success',
        data: { group: groupData },
      });
    } catch (error) {
      console.error('Error fetching group:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch group'
      });
    }
  })
);

// PATCH /groups/:groupId - update group
router.patch(
  '/:groupId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;
      const { name, description, avatar, joinSettings, settings } = req.body;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': userId,
          '$admins.id$': userId,
          isArchived: false
        },
        include: [{
          model: User,
          as: 'admins',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or admin access required'
        });
      }

      const updates = {};
      if (name && name.trim()) updates.chatName = name.trim();
      if (description !== undefined) updates.description = description?.trim();
      if (avatar !== undefined) updates.avatar = avatar;
      if (joinSettings) updates.joinSettings = joinSettings;

      if (settings && typeof settings === 'object') {
        updates.settings = { ...(group.settings || {}), ...settings };
      }

      await group.update(updates);

      const updatedGroup = await Chat.findByPk(groupId, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'socketIds'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          }
        ]
      });

      if (req.io && updatedGroup && updatedGroup.participants) {
        updatedGroup.participants.forEach(participant => {
          if (participant.socketIds && Array.isArray(participant.socketIds) && participant.socketIds.length > 0) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:updated', {
                groupId: group.id,
                updates,
                updatedBy: {
                  id: userId,
                  username: req.user.username,
                },
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Group updated successfully',
        data: { group: updatedGroup },
      });
    } catch (error) {
      console.error('Error updating group:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update group'
      });
    }
  })
);

// POST /groups/:groupId/members - add members
router.post(
  '/:groupId/members',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;
      const { userIds } = req.body;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'User IDs are required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': userId,
          '$admins.id$': userId,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or admin access required'
        });
      }

      const maxParticipants = group.settings?.maxParticipants || 1000;
      if ((group.participants || []).length + userIds.length > maxParticipants) {
        return res.status(400).json({
          status: 'error',
          message: `Group cannot have more than ${maxParticipants} members`
        });
      }

      const usersToAdd = await User.findAll({
        where: { id: userIds },
        attributes: ['id', 'username', 'socketIds', 'blockedUsers']
      });

      if (usersToAdd.length !== userIds.length) {
        return res.status(404).json({
          status: 'error',
          message: 'One or more users not found'
        });
      }

      const currentUser = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      if (!currentUser) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const blockedUsers = usersToAdd.filter(user =>
        (currentUser.blockedUsers && currentUser.blockedUsers.some(bu => bu.id === user.id)) ||
        (user.blockedUsers && user.blockedUsers.some(bu => bu.id === userId))
      );

      if (blockedUsers.length > 0) {
        return res.status(403).json({
          status: 'error',
          message: 'Cannot add blocked users to group'
        });
      }

      const existingMemberIds = (group.participants || []).map(p => p.id);
      const newMembers = usersToAdd.filter(user => !existingMemberIds.includes(user.id));

      if (newMembers.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'All users are already members of the group'
        });
      }

      await group.addParticipants(newMembers.map(m => m.id));

      const updatedGroup = await Chat.findByPk(groupId, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'displayName', 'socketIds'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          }
        ]
      });

      const currentUserFull = await User.findByPk(userId);

      if (req.io && currentUserFull && updatedGroup && updatedGroup.participants) {
        newMembers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:joined', {
                group: updatedGroup.toJSON ? updatedGroup.toJSON() : updatedGroup,
                addedBy: {
                  id: currentUserFull.id,
                  username: currentUserFull.username,
                  avatar: currentUserFull.avatar,
                },
              });
            });
          }
        });

        const existingMembers = await User.findAll({
          where: { id: existingMemberIds },
          attributes: ['id', 'socketIds']
        });

        existingMembers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:members-added', {
                groupId: group.id,
                addedMembers: newMembers.map(m => ({
                  id: m.id,
                  username: m.username,
                  avatar: m.avatar,
                })),
                addedBy: {
                  id: currentUserFull.id,
                  username: currentUserFull.username,
                },
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Members added successfully',
        data: {
          group: updatedGroup,
          addedCount: newMembers.length,
        },
      });
    } catch (error) {
      console.error('Error adding members:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to add members'
      });
    }
  })
);

// DELETE /groups/:groupId/members/:userId - remove member
router.delete(
  '/:groupId/members/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const currentUserId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId, userId: targetUserId } = req.params;

      if (!groupId || !targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID and User ID are required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': currentUserId,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or access denied'
        });
      }

      const isAdmin = group.admins && group.admins.some(admin => admin.id === currentUserId);
      const isSelfRemoval = targetUserId === currentUserId;

      if (!isAdmin && !isSelfRemoval) {
        return res.status(403).json({
          status: 'error',
          message: 'Only admins can remove other members'
        });
      }

      const isMember = group.participants && group.participants.some(p => p.id === targetUserId);
      if (!isMember) {
        return res.status(400).json({
          status: 'error',
          message: 'User is not a member of this group'
        });
      }

      if (group.admins && group.admins.some(admin => admin.id === targetUserId) && group.admins.length === 1) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot remove the last admin'
        });
      }

      await group.removeParticipant(targetUserId);

      if (group.admins && group.admins.some(admin => admin.id === targetUserId)) {
        await group.removeAdmin(targetUserId);
      }

      const removedUser = await User.findByPk(targetUserId);
      const currentUser = await User.findByPk(currentUserId);

      if (req.io && removedUser && currentUser) {
        if (removedUser.socketIds && Array.isArray(removedUser.socketIds) && removedUser.socketIds.length > 0) {
          removedUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:removed', {
              groupId: group.id,
              groupName: group.chatName,
              removedBy: isSelfRemoval
                ? 'self'
                : {
                    id: currentUser.id,
                    username: currentUser.username,
                  },
            });
          });
        }

        const remainingUsers = await User.findAll({
          where: { id: group.participants.map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        remainingUsers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:member-removed', {
                groupId: group.id,
                removedUserId: targetUserId,
                removedUsername: removedUser.username,
                removedBy: {
                  id: currentUserId,
                  username: currentUser.username,
                },
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Member removed successfully',
      });
    } catch (error) {
      console.error('Error removing member:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove member'
      });
    }
  })
);

// POST /groups/:groupId/admins/:userId - promote to admin
router.post(
  '/:groupId/admins/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const currentUserId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId, userId: targetUserId } = req.params;

      if (!groupId || !targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID and User ID are required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': currentUserId,
          '$admins.id$': currentUserId,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or admin access required'
        });
      }

      const isMember = group.participants && group.participants.some(p => p.id === targetUserId);
      if (!isMember) {
        return res.status(400).json({
          status: 'error',
          message: 'User is not a member of this group'
        });
      }

      const isAlreadyAdmin = group.admins && group.admins.some(admin => admin.id === targetUserId);
      if (isAlreadyAdmin) {
        return res.status(409).json({
          status: 'error',
          message: 'User is already an admin'
        });
      }

      await group.addAdmin(targetUserId);

      const promotedUser = await User.findByPk(targetUserId);
      const currentUser = await User.findByPk(currentUserId);

      if (req.io && promotedUser && currentUser) {
        if (promotedUser.socketIds && Array.isArray(promotedUser.socketIds) && promotedUser.socketIds.length > 0) {
          promotedUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:admin-promoted', {
              groupId: group.id,
              groupName: group.chatName,
              promotedBy: {
                id: currentUser.id,
                username: currentUser.username,
              },
            });
          });
        }

        const otherMembers = await User.findAll({
          where: {
            id: (group.participants || [])
              .filter(p => p.id !== targetUserId && p.id !== currentUserId)
              .map(p => p.id)
          },
          attributes: ['id', 'socketIds']
        });

        otherMembers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:admin-added', {
                groupId: group.id,
                userId: targetUserId,
                username: promotedUser.username,
                promotedBy: {
                  id: currentUser.id,
                  username: currentUser.username,
                },
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'User promoted to admin successfully',
      });
    } catch (error) {
      console.error('Error promoting to admin:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to promote user to admin'
      });
    }
  })
);

// DELETE /groups/:groupId/admins/:userId - demote from admin
router.delete(
  '/:groupId/admins/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const currentUserId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId, userId: targetUserId } = req.params;

      if (!groupId || !targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID and User ID are required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': currentUserId,
          '$admins.id$': currentUserId,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or admin access required'
        });
      }

      const isAdmin = group.admins && group.admins.some(admin => admin.id === targetUserId);
      if (!isAdmin) {
        return res.status(400).json({
          status: 'error',
          message: 'User is not an admin'
        });
      }

      if (targetUserId === currentUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot demote yourself'
        });
      }

      if (group.admins.length === 1) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot demote the last admin'
        });
      }

      await group.removeAdmin(targetUserId);

      const demotedUser = await User.findByPk(targetUserId);
      const currentUser = await User.findByPk(currentUserId);

      if (req.io && demotedUser && currentUser) {
        if (demotedUser.socketIds && Array.isArray(demotedUser.socketIds) && demotedUser.socketIds.length > 0) {
          demotedUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:admin-demoted', {
              groupId: group.id,
              groupName: group.chatName,
              demotedBy: {
                id: currentUser.id,
                username: currentUser.username,
              },
            });
          });
        }

        const otherMembers = await User.findAll({
          where: {
            id: (group.participants || [])
              .filter(p => p.id !== targetUserId && p.id !== currentUserId)
              .map(p => p.id)
          },
          attributes: ['id', 'socketIds']
        });

        otherMembers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:admin-removed', {
                groupId: group.id,
                userId: targetUserId,
                username: demotedUser.username,
                demotedBy: {
                  id: currentUser.id,
                  username: currentUser.username,
                },
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Admin demoted successfully',
      });
    } catch (error) {
      console.error('Error demoting admin:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to demote admin'
      });
    }
  })
);

// POST /groups/:groupId/leave - leave group
router.post(
  '/:groupId/leave',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': userId,
          isArchived: false
        },
        include: [{
          model: User,
          as: 'admins',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group chat not found or access denied'
        });
      }

      const isAdmin = group.admins && group.admins.some(admin => admin.id === userId);
      if (isAdmin && group.admins.length === 1) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot leave as the last admin. Transfer ownership first.'
        });
      }

      await group.removeParticipant(userId);

      if (isAdmin) {
        await group.removeAdmin(userId);
      }

      const currentUser = await User.findByPk(userId);

      if (req.io && currentUser) {
        const remainingUsers = await User.findAll({
          where: { id: (group.participants || []).map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        remainingUsers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:left', {
                groupId: group.id,
                groupName: group.chatName,
                userId: userId,
                username: currentUser.username,
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Left group successfully',
      });
    } catch (error) {
      console.error('Error leaving group:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to leave group'
      });
    }
  })
);

// POST /groups/:groupId/transfer-ownership - transfer ownership
router.post(
  '/:groupId/transfer-ownership',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const currentUserId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;
      const { newOwnerId } = req.body;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      if (!newOwnerId) {
        return res.status(400).json({
          status: 'error',
          message: 'New owner ID is required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': currentUserId,
          '$admins.id$': currentUserId,
          isArchived: false
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['id'],
            through: { attributes: [] }
          }
        ]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or admin access required'
        });
      }

      const isMember = group.participants && group.participants.some(p => p.id === newOwnerId);
      if (!isMember) {
        return res.status(400).json({
          status: 'error',
          message: 'New owner must be a member of the group'
        });
      }

      await group.update({ createdBy: newOwnerId });

      if (!group.admins || !group.admins.some(admin => admin.id === newOwnerId)) {
        await group.addAdmin(newOwnerId);
      }

      const newOwner = await User.findByPk(newOwnerId);
      const currentUser = await User.findByPk(currentUserId);

      if (req.io && newOwner && currentUser) {
        if (newOwner.socketIds && Array.isArray(newOwner.socketIds) && newOwner.socketIds.length > 0) {
          newOwner.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:ownership-transferred', {
              groupId: group.id,
              groupName: group.chatName,
              previousOwner: {
                id: currentUser.id,
                username: currentUser.username,
              },
            });
          });
        }

        const allMembers = await User.findAll({
          where: { id: (group.participants || []).map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        allMembers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:owner-changed', {
                groupId: group.id,
                previousOwnerId: currentUserId,
                newOwnerId: newOwnerId,
                newOwnerUsername: newOwner.username,
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Group ownership transferred successfully',
      });
    } catch (error) {
      console.error('Error transferring ownership:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to transfer ownership'
      });
    }
  })
);

// POST /groups/:groupId/invite/link - generate invite link
router.post(
  '/:groupId/invite/link',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;
      const { expiresIn = '7d', maxUses = null } = req.body;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': userId,
          '$admins.id$': userId,
          isArchived: false
        }
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or admin access required'
        });
      }

      const inviteCode = crypto.randomBytes(16).toString('hex');

      const expiresAt = new Date();
      const expiresInDays = parseInt(expiresIn) || 7;
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      let invite = null;
      if (GroupInvite) {
        invite = await GroupInvite.create({
          groupId: group.id,
          code: inviteCode,
          createdBy: userId,
          expiresAt,
          maxUses,
          usedBy: [],
        });
      }

      const inviteLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/groups/join/${inviteCode}`;

      res.status(201).json({
        status: 'success',
        data: {
          inviteLink,
          code: inviteCode,
          expiresAt: invite ? invite.expiresAt : expiresAt,
          maxUses: invite ? invite.maxUses : maxUses,
        },
      });
    } catch (error) {
      console.error('Error generating invite link:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to generate invite link'
      });
    }
  })
);

// POST /groups/join/:inviteCode - join via invite
router.post(
  '/join/:inviteCode',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { inviteCode } = req.params;

      if (!inviteCode) {
        return res.status(400).json({
          status: 'error',
          message: 'Invite code is required'
        });
      }

      let invite = null;
      if (GroupInvite) {
        invite = await GroupInvite.findOne({
          where: {
            code: inviteCode,
            expiresAt: { [Op.gt]: new Date() },
            [Op.or]: [
              { maxUses: null },
              Sequelize.literal('(SELECT COUNT(*) FROM unnest("usedBy") AS u) < "maxUses"')
            ]
          },
          include: [{
            model: Chat,
            as: 'group'
          }]
        });
      }

      if (!invite || !invite.group) {
        return res.status(404).json({
          status: 'error',
          message: 'Invalid or expired invite code'
        });
      }

      const group = invite.group;

      const isMember = await group.hasParticipant(userId);
      if (isMember) {
        return res.status(409).json({
          status: 'error',
          message: 'Already a member of this group'
        });
      }

      const maxParticipants = group.settings?.maxParticipants || 1000;
      const participantCount = await group.countParticipants();
      if (participantCount >= maxParticipants) {
        return res.status(400).json({
          status: 'error',
          message: 'Group is full'
        });
      }

      const currentUser = await User.findByPk(userId);
      const groupMembers = await User.findAll({
        where: {
          id: (group.participants || []).map(p => p.id)
        },
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      const isBlocked = groupMembers.some(member =>
        member.blockedUsers && member.blockedUsers.some(bu => bu.id === userId)
      );

      if (isBlocked) {
        return res.status(403).json({
          status: 'error',
          message: 'Cannot join group - blocked by a member'
        });
      }

      await group.addParticipant(userId);

      if (invite) {
        const usedBy = invite.usedBy || [];
        usedBy.push({
          user: userId,
          usedAt: new Date(),
        });
        await invite.update({ usedBy });
      }

      const updatedGroup = await Chat.findByPk(group.id, {
        include: [
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'socketIds'],
            through: { attributes: [] }
          },
          {
            model: User,
            as: 'admins',
            attributes: ['username', 'avatar']
          }
        ]
      });

      if (req.io && currentUser && updatedGroup && updatedGroup.participants) {
        if (currentUser.socketIds && Array.isArray(currentUser.socketIds) && currentUser.socketIds.length > 0) {
          currentUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:joined', {
              group: updatedGroup.toJSON ? updatedGroup.toJSON() : updatedGroup,
              joinedVia: 'invite',
            });
          });
        }

        const existingMembers = await User.findAll({
          where: {
            id: (group.participants || [])
              .filter(p => p.id !== userId)
              .map(p => p.id)
          },
          attributes: ['id', 'socketIds']
        });

        existingMembers.forEach(member => {
          if (member.socketIds && Array.isArray(member.socketIds) && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:member-joined', {
                groupId: group.id,
                userId: userId,
                username: currentUser.username,
                joinedVia: 'invite',
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Joined group successfully',
        data: { group: updatedGroup },
      });
    } catch (error) {
      console.error('Error joining group:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to join group'
      });
    }
  })
);

// GET /groups/:groupId/stats - group statistics
router.get(
  '/:groupId/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (auth.status) return auth;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { groupId } = req.params;

      if (!groupId) {
        return res.status(400).json({
          status: 'error',
          message: 'Group ID is required'
        });
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': userId,
          isArchived: false
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id']
        }]
      });

      if (!group) {
        return res.status(404).json({
          status: 'error',
          message: 'Group not found or access denied'
        });
      }

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const messageStats = await Message.findAll({
        where: {
          chatId: group.id,
          createdAt: { [Op.gte]: thirtyDaysAgo },
          isDeleted: false
        },
        attributes: [
          [Sequelize.fn('DATE', Sequelize.col('createdAt')), 'date'],
          [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
          [Sequelize.fn('COUNT', Sequelize.fn('DISTINCT', Sequelize.col('senderId'))), 'senders']
        ],
        group: [Sequelize.fn('DATE', Sequelize.col('createdAt'))],
        order: [[Sequelize.fn('DATE', Sequelize.col('createdAt')), 'ASC']],
        raw: true
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const activeMembers = await Message.findAll({
        where: {
          chatId: group.id,
          createdAt: { [Op.gte]: sevenDaysAgo },
          isDeleted: false
        },
        attributes: [[Sequelize.fn('DISTINCT', Sequelize.col('senderId')), 'senderId']],
        raw: true
      });

      const onlineMembers = await User.count({
        where: {
          id: (group.participants || []).map(p => p.id),
          online: true
        }
      });

      res.status(200).json({
        status: 'success',
        data: {
          totalMembers: (group.participants || []).length,
          onlineMembers: onlineMembers || 0,
          activeMembers: (activeMembers || []).length,
          messageStats: (messageStats || []).map(stat => ({
            _id: stat.date,
            count: parseInt(stat.count || 0),
            senders: parseInt(stat.senders || 0)
          })),
          created: group.createdAt,
          lastActive: group.updatedAt,
        },
      });
    } catch (error) {
      console.error('Error fetching group statistics:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch group statistics'
      });
    }
  })
);

module.exports = router;