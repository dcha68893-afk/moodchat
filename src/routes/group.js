const express = require('express');
const router = express.Router();
const sequelize = require('sequelize');
const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, Chat, Message, GroupInvite } = require('../models');

router.use(authMiddleware);

console.log('✅ Group routes initialized');

router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        role = 'all',
        search,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = {
        chatType: 'group',
        '$participants.id$': req.user.id,
        isArchived: false,
      };

      if (role === 'admin') {
        where['$admins.id$'] = req.user.id;
      } else if (role === 'member') {
        where['$admins.id$'] = { [sequelize.Op.ne]: req.user.id };
      }

      if (search && search.trim()) {
        where.chatName = { [sequelize.Op.iLike]: `%${search}%` };
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
        groups.map(async group => {
          const groupObj = group.toJSON();
          const isAdmin = group.admins.some(admin => admin.id === req.user.id);
          const participantCount = group.participants ? group.participants.length : 0;
          const onlineCount = group.participants ? group.participants.filter(p => p.online).length : 0;
          const userUnread = await group.getUnreadCount(req.user.id);

          return {
            ...groupObj,
            isAdmin,
            participantCount,
            onlineCount,
            unreadCount: userUnread || 0,
          };
        })
      );

      res.status(200).json({
        status: 'success',
        data: {
          groups: groupsWithMetadata,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching groups:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch groups'
      });
    }
  })
);

router.post(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const {
        name,
        description,
        avatar,
        participantIds,
        isPublic = false,
        joinSettings = 'invite_only',
      } = req.body;

      if (!name || !name.trim()) {
        throw new ValidationError('Group name is required');
      }

      if (name.length > 100) {
        throw new ValidationError('Group name must be less than 100 characters');
      }

      const allParticipants = [req.user.id];
      if (Array.isArray(participantIds) && participantIds.length > 0) {
        const uniqueParticipants = [...new Set(participantIds.filter(id => id !== req.user.id))];

        if (uniqueParticipants.length > 0) {
          const participants = await User.findAll({
            where: { id: uniqueParticipants },
            attributes: ['id', 'username', 'blockedUsers']
          });

          if (participants.length !== uniqueParticipants.length) {
            throw new NotFoundError('One or more participants not found');
          }

          const currentUser = await User.findByPk(req.user.id, {
            include: [{
              model: User,
              as: 'blockedUsers',
              attributes: ['id']
            }]
          });

          const blockedParticipants = participants.filter(p =>
            currentUser.blockedUsers.some(bu => bu.id === p.id) ||
            p.blockedUsers.some(bu => bu.id === req.user.id)
          );

          if (blockedParticipants.length > 0) {
            throw new AuthorizationError('Cannot add blocked users to group');
          }

          allParticipants.push(...participants.map(p => p.id));
        }
      }

      const group = await Chat.create({
        chatType: 'group',
        chatName: name.trim(),
        description: description?.trim(),
        avatar,
        createdBy: req.user.id,
        isPublic,
        joinSettings,
        settings: {
          allowMemberInvites: true,
          allowMessageDeletion: true,
          requireAdminApproval: false,
          maxParticipants: 1000,
        },
      });

      await group.setParticipants(allParticipants);
      await group.setAdmins([req.user.id]);

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

      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        const notificationData = {
          group: populatedGroup.toJSON(),
          createdBy: {
            id: currentUser.id,
            username: currentUser.username,
            avatar: currentUser.avatar,
          },
        };

        populatedGroup.participants.forEach(participant => {
          if (participant.socketIds && participant.socketIds.length > 0) {
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
      console.error('Error creating group:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to create group'
      });
    }
  })
);

router.get(
  '/:groupId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
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
        throw new NotFoundError('Group not found or access denied');
      }

      const groupData = group.toJSON();
      groupData.isAdmin = group.admins.some(admin => admin.id === req.user.id);
      groupData.participantCount = group.participants.length;
      groupData.onlineCount = group.participants.filter(p => p.online).length;
      const userUnread = await group.getUnreadCount(req.user.id);
      groupData.unreadCount = userUnread || 0;

      res.status(200).json({
        status: 'success',
        data: { group: groupData },
      });
    } catch (error) {
      console.error('Error fetching group:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch group'
      });
    }
  })
);

router.patch(
  '/:groupId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;
      const { name, description, avatar, joinSettings, settings } = req.body;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          '$admins.id$': req.user.id,
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
        throw new NotFoundError('Group not found or admin access required');
      }

      const updates = {};
      if (name && name.trim()) updates.chatName = name.trim();
      if (description !== undefined) updates.description = description?.trim();
      if (avatar !== undefined) updates.avatar = avatar;
      if (joinSettings) updates.joinSettings = joinSettings;

      if (settings && typeof settings === 'object') {
        updates.settings = { ...group.settings, ...settings };
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

      if (req.io) {
        updatedGroup.participants.forEach(participant => {
          if (participant.socketIds && participant.socketIds.length > 0) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:updated', {
                groupId: group.id,
                updates,
                updatedBy: {
                  id: req.user.id,
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
      console.error('Error updating group:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update group'
      });
    }
  })
);

router.post(
  '/:groupId/members',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new ValidationError('User IDs are required');
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          '$admins.id$': req.user.id,
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
        throw new NotFoundError('Group not found or admin access required');
      }

      const maxParticipants = group.settings?.maxParticipants || 1000;
      if (group.participants.length + userIds.length > maxParticipants) {
        throw new ValidationError(`Group cannot have more than ${maxParticipants} members`);
      }

      const usersToAdd = await User.findAll({
        where: { id: userIds },
        attributes: ['id', 'username', 'socketIds', 'blockedUsers']
      });

      if (usersToAdd.length !== userIds.length) {
        throw new NotFoundError('One or more users not found');
      }

      const currentUser = await User.findByPk(req.user.id, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      const blockedUsers = usersToAdd.filter(user =>
        currentUser.blockedUsers.some(bu => bu.id === user.id) ||
        user.blockedUsers.some(bu => bu.id === req.user.id)
      );

      if (blockedUsers.length > 0) {
        throw new AuthorizationError('Cannot add blocked users to group');
      }

      const existingMemberIds = group.participants.map(p => p.id);
      const newMembers = usersToAdd.filter(user => !existingMemberIds.includes(user.id));

      if (newMembers.length === 0) {
        throw new ValidationError('All users are already members of the group');
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

      const currentUserFull = await User.findByPk(req.user.id);

      if (req.io) {
        newMembers.forEach(member => {
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:joined', {
                group: updatedGroup.toJSON(),
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
          if (member.socketIds && member.socketIds.length > 0) {
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
      console.error('Error adding members:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to add members'
      });
    }
  })
);

router.delete(
  '/:groupId/members/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId, userId } = req.params;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
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
        throw new NotFoundError('Group not found or access denied');
      }

      const isAdmin = group.admins.some(admin => admin.id === req.user.id);
      const isSelfRemoval = userId === req.user.id;

      if (!isAdmin && !isSelfRemoval) {
        throw new AuthorizationError('Only admins can remove other members');
      }

      const isMember = group.participants.some(p => p.id === userId);
      if (!isMember) {
        throw new ValidationError('User is not a member of this group');
      }

      if (group.admins.some(admin => admin.id === userId) && group.admins.length === 1) {
        throw new ValidationError('Cannot remove the last admin');
      }

      await group.removeParticipant(userId);

      if (group.admins.some(admin => admin.id === userId)) {
        await group.removeAdmin(userId);
      }

      const removedUser = await User.findByPk(userId);
      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        if (removedUser.socketIds && removedUser.socketIds.length > 0) {
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
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:member-removed', {
                groupId: group.id,
                removedUserId: userId,
                removedUsername: removedUser.username,
                removedBy: {
                  id: req.user.id,
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
      console.error('Error removing member:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove member'
      });
    }
  })
);

router.post(
  '/:groupId/admins/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId, userId } = req.params;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          '$admins.id$': req.user.id,
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
        throw new NotFoundError('Group not found or admin access required');
      }

      const isMember = group.participants.some(p => p.id === userId);
      if (!isMember) {
        throw new ValidationError('User is not a member of this group');
      }

      const isAlreadyAdmin = group.admins.some(admin => admin.id === userId);
      if (isAlreadyAdmin) {
        throw new ConflictError('User is already an admin');
      }

      await group.addAdmin(userId);

      const promotedUser = await User.findByPk(userId);
      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        if (promotedUser.socketIds && promotedUser.socketIds.length > 0) {
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
            id: group.participants
              .filter(p => p.id !== userId && p.id !== req.user.id)
              .map(p => p.id)
          },
          attributes: ['id', 'socketIds']
        });

        otherMembers.forEach(member => {
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:admin-added', {
                groupId: group.id,
                userId: userId,
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
      console.error('Error promoting to admin:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to promote user to admin'
      });
    }
  })
);

router.delete(
  '/:groupId/admins/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId, userId } = req.params;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          '$admins.id$': req.user.id,
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
        throw new NotFoundError('Group not found or admin access required');
      }

      const isAdmin = group.admins.some(admin => admin.id === userId);
      if (!isAdmin) {
        throw new ValidationError('User is not an admin');
      }

      if (userId === req.user.id) {
        throw new ValidationError('Cannot demote yourself');
      }

      if (group.admins.length === 1) {
        throw new ValidationError('Cannot demote the last admin');
      }

      await group.removeAdmin(userId);

      const demotedUser = await User.findByPk(userId);
      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        if (demotedUser.socketIds && demotedUser.socketIds.length > 0) {
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
            id: group.participants
              .filter(p => p.id !== userId && p.id !== req.user.id)
              .map(p => p.id)
          },
          attributes: ['id', 'socketIds']
        });

        otherMembers.forEach(member => {
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:admin-removed', {
                groupId: group.id,
                userId: userId,
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
      console.error('Error demoting admin:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to demote admin'
      });
    }
  })
);

router.post(
  '/:groupId/leave',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
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
        throw new NotFoundError('Group chat not found or access denied');
      }

      const isAdmin = group.admins.some(admin => admin.id === req.user.id);
      if (isAdmin && group.admins.length === 1) {
        throw new ValidationError('Cannot leave as the last admin. Transfer ownership first.');
      }

      await group.removeParticipant(req.user.id);

      if (isAdmin) {
        await group.removeAdmin(req.user.id);
      }

      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        const remainingUsers = await User.findAll({
          where: { id: group.participants.map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        remainingUsers.forEach(member => {
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:left', {
                groupId: group.id,
                groupName: group.chatName,
                userId: currentUser.id,
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
      console.error('Error leaving group:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to leave group'
      });
    }
  })
);

router.post(
  '/:groupId/transfer-ownership',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;
      const { newOwnerId } = req.body;

      if (!newOwnerId) {
        throw new ValidationError('New owner ID is required');
      }

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          '$admins.id$': req.user.id,
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
        throw new NotFoundError('Group not found or admin access required');
      }

      const isMember = group.participants.some(p => p.id === newOwnerId);
      if (!isMember) {
        throw new ValidationError('New owner must be a member of the group');
      }

      await group.update({ createdBy: newOwnerId });

      if (!group.admins.some(admin => admin.id === newOwnerId)) {
        await group.addAdmin(newOwnerId);
      }

      const newOwner = await User.findByPk(newOwnerId);
      const currentUser = await User.findByPk(req.user.id);

      if (req.io) {
        if (newOwner.socketIds && newOwner.socketIds.length > 0) {
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
          where: { id: group.participants.map(p => p.id) },
          attributes: ['id', 'socketIds']
        });

        allMembers.forEach(member => {
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:owner-changed', {
                groupId: group.id,
                previousOwnerId: currentUser.id,
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
      console.error('Error transferring ownership:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to transfer ownership'
      });
    }
  })
);

router.post(
  '/:groupId/invite/link',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;
      const { expiresIn = '7d', maxUses = null } = req.body;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          '$admins.id$': req.user.id,
          isArchived: false
        }
      });

      if (!group) {
        throw new NotFoundError('Group not found or admin access required');
      }

      const inviteCode = crypto.randomBytes(16).toString('hex');

      const expiresAt = new Date();
      const expiresInDays = parseInt(expiresIn) || 7;
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      const invite = await GroupInvite.create({
        groupId: group.id,
        code: inviteCode,
        createdBy: req.user.id,
        expiresAt,
        maxUses,
        usedBy: [],
      });

      const inviteLink = `${process.env.CLIENT_URL}/groups/join/${inviteCode}`;

      res.status(201).json({
        status: 'success',
        data: {
          inviteLink,
          code: inviteCode,
          expiresAt: invite.expiresAt,
          maxUses: invite.maxUses,
        },
      });
    } catch (error) {
      console.error('Error generating invite link:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to generate invite link'
      });
    }
  })
);

router.post(
  '/join/:inviteCode',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { inviteCode } = req.params;

      const invite = await GroupInvite.findOne({
        where: {
          code: inviteCode,
          expiresAt: { [sequelize.Op.gt]: new Date() },
          [sequelize.Op.or]: [
            { maxUses: null },
            sequelize.literal('(SELECT COUNT(*) FROM unnest("usedBy") AS u) < "maxUses"')
          ]
        },
        include: [{
          model: Chat,
          as: 'group'
        }]
      });

      if (!invite) {
        throw new NotFoundError('Invalid or expired invite code');
      }

      const group = invite.group;

      const isMember = await group.hasParticipant(req.user.id);
      if (isMember) {
        throw new ConflictError('Already a member of this group');
      }

      const maxParticipants = group.settings?.maxParticipants || 1000;
      const participantCount = await group.countParticipants();
      if (participantCount >= maxParticipants) {
        throw new ValidationError('Group is full');
      }

      const currentUser = await User.findByPk(req.user.id);
      const groupMembers = await User.findAll({
        where: {
          id: group.participants.map(p => p.id)
        },
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id']
        }]
      });

      const isBlocked = groupMembers.some(member =>
        member.blockedUsers.some(bu => bu.id === req.user.id)
      );

      if (isBlocked) {
        throw new AuthorizationError('Cannot join group - blocked by a member');
      }

      await group.addParticipant(req.user.id);

      const usedBy = invite.usedBy || [];
      usedBy.push({
        user: req.user.id,
        usedAt: new Date(),
      });
      await invite.update({ usedBy });

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

      if (req.io) {
        if (currentUser.socketIds && currentUser.socketIds.length > 0) {
          currentUser.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:joined', {
              group: updatedGroup.toJSON(),
              joinedVia: 'invite',
            });
          });
        }

        const existingMembers = await User.findAll({
          where: {
            id: group.participants
              .filter(p => p.id !== req.user.id)
              .map(p => p.id)
          },
          attributes: ['id', 'socketIds']
        });

        existingMembers.forEach(member => {
          if (member.socketIds && member.socketIds.length > 0) {
            member.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('group:member-joined', {
                groupId: group.id,
                userId: currentUser.id,
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
      console.error('Error joining group:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to join group'
      });
    }
  })
);

router.get(
  '/:groupId/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { groupId } = req.params;

      const group = await Chat.findOne({
        where: {
          id: groupId,
          chatType: 'group',
          '$participants.id$': req.user.id,
          isArchived: false
        }
      });

      if (!group) {
        throw new NotFoundError('Group not found or access denied');
      }

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const messageStats = await Message.findAll({
        where: {
          chatId: group.id,
          createdAt: { [sequelize.Op.gte]: thirtyDaysAgo },
          isDeleted: false
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('createdAt')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('senderId'))), 'senders']
        ],
        group: [sequelize.fn('DATE', sequelize.col('createdAt'))],
        order: [[sequelize.fn('DATE', sequelize.col('createdAt')), 'ASC']],
        raw: true
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const activeMembers = await Message.findAll({
        where: {
          chatId: group.id,
          createdAt: { [sequelize.Op.gte]: sevenDaysAgo },
          isDeleted: false
        },
        attributes: [[sequelize.fn('DISTINCT', sequelize.col('senderId')), 'senderId']],
        raw: true
      });

      const onlineMembers = await User.count({
        where: {
          id: group.participants.map(p => p.id),
          online: true
        }
      });

      res.status(200).json({
        status: 'success',
        data: {
          totalMembers: group.participants.length,
          onlineMembers,
          activeMembers: activeMembers.length,
          messageStats: messageStats.map(stat => ({
            _id: stat.date,
            count: parseInt(stat.count),
            senders: parseInt(stat.senders)
          })),
          created: group.createdAt,
          lastActive: group.updatedAt,
        },
      });
    } catch (error) {
      console.error('Error fetching group statistics:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch group statistics'
      });
    }
  })
);

module.exports = router;