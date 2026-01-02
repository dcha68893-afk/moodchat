const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Import middleware and utilities
const {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const Chat = require('../models/Chat');
const User = require('../models/User');
const GroupInvite = require('../models/Group');

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get all groups user is member of
 */
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      role = 'all', // 'admin', 'member', 'all'
      search,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build query
    const query = {
      chatType: 'group',
      participants: req.user.id,
      isArchived: false,
    };

    // Filter by role
    if (role === 'admin') {
      query.admins = req.user.id;
    } else if (role === 'member') {
      query.admins = { $ne: req.user.id };
    }

    // Search by group name
    if (search && search.trim()) {
      query.chatName = { $regex: search, $options: 'i' };
    }

    // Get groups with populated data
    const [groups, total] = await Promise.all([
      Chat.find(query)
        .populate({
          path: 'participants',
          select: 'username avatar displayName online status',
          perDocumentLimit: 5, // Show only 5 participants initially
        })
        .populate({
          path: 'admins',
          select: 'username avatar',
        })
        .populate({
          path: 'lastMessage',
          select: 'content sender createdAt messageType',
        })
        .populate({
          path: 'createdBy',
          select: 'username avatar',
        })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Chat.countDocuments(query),
    ]);

    // Add metadata for each group
    const groupsWithMetadata = groups.map(group => {
      const isAdmin = group.admins.some(admin => admin._id.toString() === req.user.id);

      const participantCount = group.participants ? group.participants.length : 0;
      const onlineCount = group.participants ? group.participants.filter(p => p.online).length : 0;

      return {
        ...group,
        isAdmin,
        participantCount,
        onlineCount,
        unreadCount: group.unreadCounts?.get(req.user.id.toString()) || 0,
      };
    });

    res.status(200).json({
      status: 'success',
      data: {
        groups: groupsWithMetadata,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  })
);

/**
 * Create a new group
 */
router.post(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const {
      name,
      description,
      avatar,
      participantIds,
      isPublic = false,
      joinSettings = 'invite_only', // 'invite_only', 'link', 'public'
    } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      throw new ValidationError('Group name is required');
    }

    if (name.length > 100) {
      throw new ValidationError('Group name must be less than 100 characters');
    }

    // Validate participant IDs
    const allParticipants = [req.user.id];
    if (Array.isArray(participantIds) && participantIds.length > 0) {
      // Check for duplicates and remove self
      const uniqueParticipants = [...new Set(participantIds.filter(id => id !== req.user.id))];

      if (uniqueParticipants.length > 0) {
        // Check if all participants exist
        const participants = await User.find({
          _id: { $in: uniqueParticipants },
        }).select('_id username blockedUsers');

        if (participants.length !== uniqueParticipants.length) {
          throw new NotFoundError('One or more participants not found');
        }

        // Check for blocked users
        const currentUser = await User.findById(req.user.id);
        const blockedParticipants = participants.filter(
          p => currentUser.blockedUsers?.includes(p._id) || p.blockedUsers?.includes(req.user.id)
        );

        if (blockedParticipants.length > 0) {
          throw new AuthorizationError('Cannot add blocked users to group');
        }

        allParticipants.push(...participants.map(p => p._id));
      }
    }

    // Create group chat
    const group = await Chat.create({
      chatType: 'group',
      chatName: name.trim(),
      description: description?.trim(),
      avatar,
      participants: allParticipants,
      admins: [req.user.id],
      createdBy: req.user.id,
      isPublic,
      joinSettings,
      settings: {
        allowMemberInvites: true,
        allowMessageDeletion: true,
        requireAdminApproval: false,
        maxParticipants: 1000,
      },
      unreadCounts: new Map(allParticipants.map(participantId => [participantId.toString(), 0])),
    });

    // Populate the created group
    const populatedGroup = await Chat.findById(group._id)
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status socketIds',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      })
      .populate({
        path: 'createdBy',
        select: 'username avatar',
      });

    // Get current user info
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications to all participants
    if (req.io) {
      const notificationData = {
        group: populatedGroup.toObject(),
        createdBy: {
          id: currentUser._id,
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
  })
);

/**
 * Get group details
 */
router.get(
  '/:groupId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;

    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      isArchived: false,
    })
      .populate({
        path: 'participants',
        select: 'username avatar displayName online status lastActive',
      })
      .populate({
        path: 'admins',
        select: 'username avatar displayName',
      })
      .populate({
        path: 'createdBy',
        select: 'username avatar',
      })
      .populate({
        path: 'lastMessage',
        select: 'content sender createdAt messageType',
      });

    if (!group) {
      throw new NotFoundError('Group not found or access denied');
    }

    // Add metadata
    const groupData = group.toObject();
    groupData.isAdmin = group.admins.some(admin => admin._id.toString() === req.user.id);
    groupData.participantCount = group.participants.length;
    groupData.onlineCount = group.participants.filter(p => p.online).length;
    groupData.unreadCount = group.unreadCounts?.get(req.user.id.toString()) || 0;

    res.status(200).json({
      status: 'success',
      data: { group: groupData },
    });
  })
);

/**
 * Update group settings
 */
router.patch(
  '/:groupId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const { name, description, avatar, joinSettings, settings } = req.body;

    // Find group and verify admin access
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      admins: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or admin access required');
    }

    // Prepare updates
    const updates = {};
    if (name && name.trim()) updates.chatName = name.trim();
    if (description !== undefined) updates.description = description?.trim();
    if (avatar !== undefined) updates.avatar = avatar;
    if (joinSettings) updates.joinSettings = joinSettings;

    // Update settings object if provided
    if (settings && typeof settings === 'object') {
      updates.settings = { ...group.settings, ...settings };
    }

    const updatedGroup = await Chat.findByIdAndUpdate(groupId, updates, {
      new: true,
      runValidators: true,
    })
      .populate({
        path: 'participants',
        select: 'username avatar socketIds',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      });

    // Send WebSocket notification to all participants
    if (req.io) {
      updatedGroup.participants.forEach(participant => {
        if (participant.socketIds && participant.socketIds.length > 0) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:updated', {
              groupId: group._id,
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
  })
);

/**
 * Add members to group
 */
router.post(
  '/:groupId/members',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new ValidationError('User IDs are required');
    }

    // Find group and verify admin access
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      admins: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or admin access required');
    }

    // Check if group is full
    const maxParticipants = group.settings?.maxParticipants || 1000;
    if (group.participants.length + userIds.length > maxParticipants) {
      throw new ValidationError(`Group cannot have more than ${maxParticipants} members`);
    }

    // Get users to add
    const usersToAdd = await User.find({
      _id: { $in: userIds },
    }).select('_id username socketIds blockedUsers');

    if (usersToAdd.length !== userIds.length) {
      throw new NotFoundError('One or more users not found');
    }

    // Check for blocked users
    const currentUser = await User.findById(req.user.id);
    const blockedUsers = usersToAdd.filter(
      user =>
        currentUser.blockedUsers?.includes(user._id) || user.blockedUsers?.includes(req.user.id)
    );

    if (blockedUsers.length > 0) {
      throw new AuthorizationError('Cannot add blocked users to group');
    }

    // Filter out existing members
    const existingMemberIds = group.participants.map(p => p.toString());
    const newMembers = usersToAdd.filter(user => !existingMemberIds.includes(user._id.toString()));

    if (newMembers.length === 0) {
      throw new ValidationError('All users are already members of the group');
    }

    // Add new members
    group.participants.push(...newMembers.map(m => m._id));

    // Initialize unread counts for new members
    newMembers.forEach(member => {
      group.unreadCounts.set(member._id.toString(), 0);
    });

    await group.save();

    // Populate updated group
    const updatedGroup = await Chat.findById(groupId)
      .populate({
        path: 'participants',
        select: 'username avatar displayName socketIds',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      });

    // Send WebSocket notifications
    if (req.io) {
      // Notify new members
      newMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:joined', {
              group: updatedGroup.toObject(),
              addedBy: {
                id: currentUser._id,
                username: currentUser.username,
                avatar: currentUser.avatar,
              },
            });
          });
        }
      });

      // Notify existing members
      const existingMembers = await User.find({
        _id: { $in: existingMemberIds },
      }).select('socketIds');

      existingMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:members-added', {
              groupId: group._id,
              addedMembers: newMembers.map(m => ({
                id: m._id,
                username: m.username,
                avatar: m.avatar,
              })),
              addedBy: {
                id: currentUser._id,
                username: currentUser.username,
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
  })
);

/**
 * Remove member from group
 */
router.delete(
  '/:groupId/members/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId, userId } = req.params;

    // Find group
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or access denied');
    }

    // Check permissions
    const isAdmin = group.admins.includes(req.user.id);
    const isSelfRemoval = userId === req.user.id;

    if (!isAdmin && !isSelfRemoval) {
      throw new AuthorizationError('Only admins can remove other members');
    }

    // Check if user to remove is in the group
    if (!group.participants.includes(userId)) {
      throw new ValidationError('User is not a member of this group');
    }

    // Cannot remove the last admin
    if (group.admins.includes(userId) && group.admins.length === 1) {
      throw new ValidationError('Cannot remove the last admin');
    }

    // Remove user from participants
    group.participants = group.participants.filter(p => p.toString() !== userId);

    // Remove from admins if they were an admin
    group.admins = group.admins.filter(admin => admin.toString() !== userId);

    // Remove unread count
    group.unreadCounts.delete(userId);

    await group.save();

    // Get user info
    const removedUser = await User.findById(userId);
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify removed user
      if (removedUser.socketIds && removedUser.socketIds.length > 0) {
        removedUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('group:removed', {
            groupId: group._id,
            groupName: group.chatName,
            removedBy: isSelfRemoval
              ? 'self'
              : {
                  id: currentUser._id,
                  username: currentUser.username,
                },
          });
        });
      }

      // Notify remaining members
      const remainingMembers = await User.find({
        _id: { $in: group.participants },
      }).select('socketIds');

      remainingMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:member-removed', {
              groupId: group._id,
              removedUserId: userId,
              removedUsername: removedUser.username,
              removedBy: {
                id: currentUser._id,
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
  })
);

/**
 * Promote member to admin
 */
router.post(
  '/:groupId/admins/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId, userId } = req.params;

    // Find group and verify current user is admin
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      admins: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or admin access required');
    }

    // Check if user to promote is a member
    if (!group.participants.includes(userId)) {
      throw new ValidationError('User is not a member of this group');
    }

    // Check if user is already admin
    if (group.admins.includes(userId)) {
      throw new ConflictError('User is already an admin');
    }

    // Promote to admin
    group.admins.push(userId);
    await group.save();

    // Get user info
    const promotedUser = await User.findById(userId);
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify promoted user
      if (promotedUser.socketIds && promotedUser.socketIds.length > 0) {
        promotedUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('group:admin-promoted', {
            groupId: group._id,
            groupName: group.chatName,
            promotedBy: {
              id: currentUser._id,
              username: currentUser.username,
            },
          });
        });
      }

      // Notify other members
      const otherMembers = await User.find({
        _id: {
          $in: group.participants.filter(
            p => p.toString() !== userId && p.toString() !== req.user.id
          ),
        },
      }).select('socketIds');

      otherMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:admin-added', {
              groupId: group._id,
              userId: userId,
              username: promotedUser.username,
              promotedBy: {
                id: currentUser._id,
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
  })
);

/**
 * Demote admin to member
 */
router.delete(
  '/:groupId/admins/:userId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId, userId } = req.params;

    // Find group and verify current user is admin
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      admins: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or admin access required');
    }

    // Check if user to demote is an admin
    if (!group.admins.includes(userId)) {
      throw new ValidationError('User is not an admin');
    }

    // Cannot demote yourself
    if (userId === req.user.id) {
      throw new ValidationError('Cannot demote yourself');
    }

    // Cannot demote the last admin
    if (group.admins.length === 1) {
      throw new ValidationError('Cannot demote the last admin');
    }

    // Demote admin
    group.admins = group.admins.filter(admin => admin.toString() !== userId);
    await group.save();

    // Get user info
    const demotedUser = await User.findById(userId);
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify demoted user
      if (demotedUser.socketIds && demotedUser.socketIds.length > 0) {
        demotedUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('group:admin-demoted', {
            groupId: group._id,
            groupName: group.chatName,
            demotedBy: {
              id: currentUser._id,
              username: currentUser.username,
            },
          });
        });
      }

      // Notify other members
      const otherMembers = await User.find({
        _id: {
          $in: group.participants.filter(
            p => p.toString() !== userId && p.toString() !== req.user.id
          ),
        },
      }).select('socketIds');

      otherMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:admin-removed', {
              groupId: group._id,
              userId: userId,
              username: demotedUser.username,
              demotedBy: {
                id: currentUser._id,
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
  })
);

/**
 * Leave group
 */
router.post(
  '/:groupId/leave',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;

    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or access denied');
    }

    // Check if user is the last admin
    if (group.admins.includes(req.user.id) && group.admins.length === 1) {
      throw new ValidationError('Cannot leave as the last admin. Transfer ownership first.');
    }

    // Remove user from participants
    group.participants = group.participants.filter(p => p.toString() !== req.user.id);

    // Remove from admins if they were an admin
    group.admins = group.admins.filter(admin => admin.toString() !== req.user.id);

    // Remove unread count
    group.unreadCounts.delete(req.user.id);

    await group.save();

    // Get current user info
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify remaining members
      const remainingMembers = await User.find({
        _id: { $in: group.participants },
      }).select('socketIds');

      remainingMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:left', {
              groupId: group._id,
              groupName: group.chatName,
              userId: currentUser._id,
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
  })
);

/**
 * Transfer group ownership
 */
router.post(
  '/:groupId/transfer-ownership',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const { newOwnerId } = req.body;

    if (!newOwnerId) {
      throw new ValidationError('New owner ID is required');
    }

    // Find group and verify current user is admin
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      admins: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or admin access required');
    }

    // Check if new owner is a member
    if (!group.participants.includes(newOwnerId)) {
      throw new ValidationError('New owner must be a member of the group');
    }

    // Update createdBy field
    group.createdBy = newOwnerId;

    // Ensure new owner is an admin
    if (!group.admins.includes(newOwnerId)) {
      group.admins.push(newOwnerId);
    }

    await group.save();

    // Get user info
    const newOwner = await User.findById(newOwnerId);
    const currentUser = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify new owner
      if (newOwner.socketIds && newOwner.socketIds.length > 0) {
        newOwner.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('group:ownership-transferred', {
            groupId: group._id,
            groupName: group.chatName,
            previousOwner: {
              id: currentUser._id,
              username: currentUser.username,
            },
          });
        });
      }

      // Notify all members
      const allMembers = await User.find({
        _id: { $in: group.participants },
      }).select('socketIds');

      allMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:owner-changed', {
              groupId: group._id,
              previousOwnerId: currentUser._id,
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
  })
);

/**
 * Generate invite link
 */
router.post(
  '/:groupId/invite/link',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const { expiresIn = '7d', maxUses = null } = req.body;

    // Find group and verify admin access
    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      admins: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or admin access required');
    }

    // Generate unique invite code
    const inviteCode = require('crypto').randomBytes(16).toString('hex');

    // Calculate expiration date
    const expiresAt = new Date();
    const expiresInDays = parseInt(expiresIn) || 7;
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    // Create invite
    const invite = await GroupInvite.create({
      group: groupId,
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
  })
);

/**
 * Join group via invite link
 */
router.post(
  '/join/:inviteCode',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { inviteCode } = req.params;

    // Find valid invite
    const invite = await GroupInvite.findOne({
      code: inviteCode,
      expiresAt: { $gt: new Date() },
      $or: [{ maxUses: null }, { $expr: { $lt: [{ $size: '$usedBy' }, '$maxUses'] } }],
    }).populate('group');

    if (!invite) {
      throw new NotFoundError('Invalid or expired invite code');
    }

    const group = invite.group;

    // Check if user is already a member
    if (group.participants.includes(req.user.id)) {
      throw new ConflictError('Already a member of this group');
    }

    // Check if group is full
    const maxParticipants = group.settings?.maxParticipants || 1000;
    if (group.participants.length >= maxParticipants) {
      throw new ValidationError('Group is full');
    }

    // Check for blocked users
    const currentUser = await User.findById(req.user.id);
    const groupMembers = await User.find({
      _id: { $in: group.participants },
    }).select('blockedUsers');

    const isBlocked = groupMembers.some(member => member.blockedUsers?.includes(req.user.id));

    if (isBlocked) {
      throw new AuthorizationError('Cannot join group - blocked by a member');
    }

    // Add user to group
    group.participants.push(req.user.id);
    group.unreadCounts.set(req.user.id.toString(), 0);
    await group.save();

    // Record invite usage
    invite.usedBy.push({
      user: req.user.id,
      usedAt: new Date(),
    });
    await invite.save();

    // Populate updated group
    const updatedGroup = await Chat.findById(group._id)
      .populate({
        path: 'participants',
        select: 'username avatar socketIds',
      })
      .populate({
        path: 'admins',
        select: 'username avatar',
      });

    // Send WebSocket notifications
    if (req.io) {
      // Notify new member
      if (currentUser.socketIds && currentUser.socketIds.length > 0) {
        currentUser.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('group:joined', {
            group: updatedGroup.toObject(),
            joinedVia: 'invite',
          });
        });
      }

      // Notify existing members
      const existingMembers = await User.find({
        _id: { $in: group.participants.filter(p => p.toString() !== req.user.id) },
      }).select('socketIds');

      existingMembers.forEach(member => {
        if (member.socketIds && member.socketIds.length > 0) {
          member.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('group:member-joined', {
              groupId: group._id,
              userId: currentUser._id,
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
  })
);

/**
 * Get group statistics
 */
router.get(
  '/:groupId/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;

    const group = await Chat.findOne({
      _id: groupId,
      chatType: 'group',
      participants: req.user.id,
      isArchived: false,
    });

    if (!group) {
      throw new NotFoundError('Group not found or access denied');
    }

    // Get message statistics for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const Message = require('../models/Message');

    const messageStats = await Message.aggregate([
      {
        $match: {
          chat: group._id,
          createdAt: { $gte: thirtyDaysAgo },
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
          senders: { $addToSet: '$sender' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // Get active members (sent messages in last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const activeMembers = await Message.distinct('sender', {
      chat: group._id,
      createdAt: { $gte: sevenDaysAgo },
      isDeleted: false,
    });

    // Get online members
    const onlineMembers = await User.countDocuments({
      _id: { $in: group.participants },
      online: true,
    });

    res.status(200).json({
      status: 'success',
      data: {
        totalMembers: group.participants.length,
        onlineMembers,
        activeMembers: activeMembers.length,
        messageStats,
        created: group.createdAt,
        lastActive: group.updatedAt,
      },
    });
  })
);

module.exports = router;
