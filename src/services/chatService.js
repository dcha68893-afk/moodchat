const mongoose = require('mongoose');

// Import models
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');

// Import utilities
const { logger } = require('../middleware/errorHandler');
const {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthorizationError,
} = require('../middleware/errorHandler');

// Environment variables
const MAX_CHAT_PARTICIPANTS = parseInt(process.env.MAX_CHAT_PARTICIPANTS) || 1000;
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH) || 5000;
const MESSAGE_RETENTION_DAYS = parseInt(process.env.MESSAGE_RETENTION_DAYS) || 365;
const DEFAULT_CHAT_SETTINGS = {
  allowMemberInvites: true,
  allowMessageDeletion: true,
  requireAdminApproval: false,
  maxParticipants: 1000,
  joinSettings: 'invite_only',
};

/**
 * Chat Service - Handles all chat-related business logic
 */
class ChatService {
  /**
   * Create a direct chat between two users
   */
  static async createDirectChat(userId, targetUserId) {
    try {
      if (!userId || !targetUserId) {
        throw new ValidationError('Both user IDs are required');
      }

      if (userId === targetUserId) {
        throw new ValidationError('Cannot create chat with yourself');
      }

      // Check if users exist and are not blocked
      const [user, targetUser] = await Promise.all([
        User.findById(userId).select('blockedUsers'),
        User.findById(targetUserId).select('blockedUsers'),
      ]);

      if (!user || !targetUser) {
        throw new NotFoundError('One or both users not found');
      }

      // Check for blocked relationships
      if (user.blockedUsers?.includes(targetUserId) || targetUser.blockedUsers?.includes(userId)) {
        throw new AuthorizationError('Cannot create chat with blocked user');
      }

      // Check if chat already exists
      const existingChat = await Chat.findOne({
        chatType: 'direct',
        participants: { $all: [userId, targetUserId], $size: 2 },
        isArchived: false,
      });

      if (existingChat) {
        // Return existing chat with populated data
        const populatedChat = await Chat.findById(existingChat._id)
          .populate({
            path: 'participants',
            select: 'username avatar displayName online status',
          })
          .populate({
            path: 'lastMessage',
            select: 'content sender createdAt',
          });

        return {
          chat: populatedChat,
          isNew: false,
        };
      }

      // Create new direct chat
      const chat = await Chat.create({
        chatType: 'direct',
        participants: [userId, targetUserId],
        createdBy: userId,
        unreadCounts: new Map([
          [userId.toString(), 0],
          [targetUserId.toString(), 0],
        ]),
      });

      // Populate the created chat
      const populatedChat = await Chat.findById(chat._id)
        .populate({
          path: 'participants',
          select: 'username avatar displayName online status',
        })
        .populate({
          path: 'createdBy',
          select: 'username avatar',
        });

      return {
        chat: populatedChat,
        isNew: true,
      };
    } catch (error) {
      logger.error('Create direct chat failed:', error);
      throw error;
    }
  }

  /**
   * Create a group chat
   */
  static async createGroupChat(userId, groupData) {
    try {
      const { name, description, avatar, participantIds, settings = {} } = groupData;

      if (!name || !name.trim()) {
        throw new ValidationError('Group name is required');
      }

      if (name.length > 100) {
        throw new ValidationError('Group name must be less than 100 characters');
      }

      // Prepare participants list (always include creator)
      const allParticipants = [userId];

      if (Array.isArray(participantIds) && participantIds.length > 0) {
        // Remove duplicates and self
        const uniqueParticipants = [...new Set(participantIds.filter(id => id !== userId))];

        if (uniqueParticipants.length > 0) {
          // Verify all participants exist
          const participants = await User.find({
            _id: { $in: uniqueParticipants },
          }).select('_id username blockedUsers');

          if (participants.length !== uniqueParticipants.length) {
            throw new NotFoundError('One or more users not found');
          }

          // Check for blocked relationships
          const currentUser = await User.findById(userId);
          const blockedParticipants = participants.filter(
            p => currentUser.blockedUsers?.includes(p._id) || p.blockedUsers?.includes(userId)
          );

          if (blockedParticipants.length > 0) {
            throw new AuthorizationError('Cannot add blocked users to group');
          }

          allParticipants.push(...participants.map(p => p._id));
        }
      }

      // Check participant limit
      if (allParticipants.length > MAX_CHAT_PARTICIPANTS) {
        throw new ValidationError(
          `Group cannot have more than ${MAX_CHAT_PARTICIPANTS} participants`
        );
      }

      // Merge settings with defaults
      const groupSettings = { ...DEFAULT_CHAT_SETTINGS, ...settings };

      // Create the group
      const chat = await Chat.create({
        chatType: 'group',
        chatName: name.trim(),
        description: description?.trim(),
        avatar,
        participants: allParticipants,
        admins: [userId],
        createdBy: userId,
        settings: groupSettings,
        unreadCounts: new Map(allParticipants.map(id => [id.toString(), 0])),
      });

      // Populate response
      const populatedChat = await Chat.findById(chat._id)
        .populate({
          path: 'participants',
          select: 'username avatar displayName online status',
        })
        .populate({
          path: 'admins',
          select: 'username avatar',
        })
        .populate({
          path: 'createdBy',
          select: 'username avatar',
        });

      return populatedChat;
    } catch (error) {
      logger.error('Create group chat failed:', error);
      throw error;
    }
  }

  /**
   * Get user's chats with pagination and filtering
   */
  static async getUserChats(userId, options = {}) {
    try {
      const {
        page = 1,
        limit = 20,
        chatType = 'all', // 'direct', 'group', 'all'
        unreadOnly = false,
        search = '',
        sortBy = 'updatedAt',
        sortOrder = 'desc',
      } = options;

      const skip = (page - 1) * limit;

      // Build query
      const query = {
        participants: userId,
        isArchived: false,
      };

      // Filter by chat type
      if (chatType !== 'all') {
        query.chatType = chatType;
      }

      // Filter unread chats
      if (unreadOnly) {
        query['unreadCounts.' + userId] = { $gt: 0 };
      }

      // Search in chat names or participant names
      if (search && search.trim()) {
        const searchRegex = new RegExp(search, 'i');

        if (chatType === 'direct' || chatType === 'all') {
          // Get users matching search
          const matchingUsers = await User.find({
            $or: [{ username: searchRegex }, { displayName: searchRegex }],
          }).select('_id');

          const matchingUserIds = matchingUsers.map(user => user._id);

          query.$or = [{ chatName: searchRegex }, { participants: { $in: matchingUserIds } }];
        } else {
          query.chatName = searchRegex;
        }
      }

      // Determine sort criteria
      const sortCriteria = {};
      switch (sortBy) {
        case 'lastMessage':
          sortCriteria.lastMessage = sortOrder === 'asc' ? 1 : -1;
          break;
        case 'createdAt':
          sortCriteria.createdAt = sortOrder === 'asc' ? 1 : -1;
          break;
        case 'updatedAt':
        default:
          sortCriteria.updatedAt = sortOrder === 'asc' ? 1 : -1;
          break;
      }

      // Get chats with populated data
      const [chats, total] = await Promise.all([
        Chat.find(query)
          .populate({
            path: 'participants',
            select: 'username avatar displayName online status',
            match: { _id: { $ne: userId } },
          })
          .populate({
            path: 'lastMessage',
            select: 'content sender createdAt messageType',
            populate: {
              path: 'sender',
              select: 'username avatar',
            },
          })
          .populate({
            path: 'createdBy',
            select: 'username avatar',
          })
          .sort(sortCriteria)
          .skip(skip)
          .limit(limit)
          .lean(),
        Chat.countDocuments(query),
      ]);

      // Process chats to add metadata
      const processedChats = await Promise.all(
        chats.map(async chat => {
          const chatObj = { ...chat };

          // Get unread count for current user
          if (chatObj.unreadCounts && chatObj.unreadCounts[userId]) {
            chatObj.unreadCount = chatObj.unreadCounts[userId];
          } else {
            chatObj.unreadCount = 0;
          }

          // For direct chats, get the other participant
          if (chatObj.chatType === 'direct') {
            const otherParticipant = chatObj.participants?.find(p => p._id.toString() !== userId);
            chatObj.otherParticipant = otherParticipant || null;

            // Get chat name from participant if not set
            if (!chatObj.chatName && otherParticipant) {
              chatObj.chatName = otherParticipant.displayName || otherParticipant.username;
            }
          }

          // For group chats, add admin status
          if (chatObj.chatType === 'group') {
            chatObj.isAdmin =
              chatObj.admins?.some(admin => admin._id.toString() === userId) || false;

            chatObj.participantCount = chatObj.participants?.length || 0;
            chatObj.onlineCount = chatObj.participants?.filter(p => p.online).length || 0;
          }

          // Remove sensitive data
          delete chatObj.unreadCounts;

          return chatObj;
        })
      );

      return {
        chats: processedChats,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Get user chats failed:', error);
      throw error;
    }
  }

  /**
   * Get chat details
   */
  static async getChatDetails(chatId, userId) {
    try {
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
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
          select: 'username avatar displayName',
        })
        .populate({
          path: 'lastMessage',
          select: 'content sender createdAt messageType',
          populate: {
            path: 'sender',
            select: 'username avatar',
          },
        });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      // Add metadata
      const chatData = chat.toObject();

      // Add unread count
      chatData.unreadCount = chat.unreadCounts?.get(userId) || 0;

      // For direct chats, get the other participant
      if (chat.chatType === 'direct') {
        const otherParticipant = chat.participants.find(p => p._id.toString() !== userId);
        chatData.otherParticipant = otherParticipant || null;

        if (!chatData.chatName && otherParticipant) {
          chatData.chatName = otherParticipant.displayName || otherParticipant.username;
        }
      }

      // For group chats, add admin status and counts
      if (chat.chatType === 'group') {
        chatData.isAdmin = chat.admins.some(admin => admin._id.toString() === userId);
        chatData.participantCount = chat.participants.length;
        chatData.onlineCount = chat.participants.filter(p => p.online).length;
      }

      // Remove sensitive data
      delete chatData.unreadCounts;

      return chatData;
    } catch (error) {
      logger.error('Get chat details failed:', error);
      throw error;
    }
  }

  /**
   * Send message to chat
   */
  static async sendMessage(chatId, userId, messageData) {
    try {
      const { content, replyTo, messageType = 'text' } = messageData;

      // Validate content
      if (messageType === 'text' && (!content || content.trim().length === 0)) {
        throw new ValidationError('Message content is required');
      }

      if (messageType === 'text' && content.length > MAX_MESSAGE_LENGTH) {
        throw new ValidationError(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
      }

      // Verify chat access
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
        isArchived: false,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      // Check if user is muted/banned (extend based on your requirements)
      // if (chat.mutedUsers?.includes(userId)) {
      //   throw new AuthorizationError('You are muted in this chat');
      // }

      // Validate reply if provided
      let replyToMessage = null;
      if (replyTo) {
        replyToMessage = await Message.findOne({
          _id: replyTo,
          chat: chatId,
          isDeleted: false,
        });

        if (!replyToMessage) {
          throw new ValidationError('Message to reply to not found');
        }
      }

      // Create message
      const message = await Message.create({
        chat: chatId,
        sender: userId,
        content: content?.trim(),
        messageType,
        repliesTo: replyToMessage?._id,
        isGroupMessage: chat.chatType === 'group',
      });

      // Populate message
      const populatedMessage = await Message.findById(message._id)
        .populate({
          path: 'sender',
          select: 'username avatar displayName',
        })
        .populate({
          path: 'repliesTo',
          select: 'content sender createdAt',
          populate: {
            path: 'sender',
            select: 'username avatar',
          },
        });

      // Update chat
      chat.lastMessage = message._id;
      chat.updatedAt = new Date();

      // Increment unread counts for all participants except sender
      chat.participants.forEach(participantId => {
        if (participantId.toString() !== userId) {
          const currentCount = chat.unreadCounts.get(participantId.toString()) || 0;
          chat.unreadCounts.set(participantId.toString(), currentCount + 1);
        }
      });

      await chat.save();

      return {
        message: populatedMessage,
        chatUpdate: {
          lastMessage: message._id,
          updatedAt: chat.updatedAt,
          unreadCounts: Object.fromEntries(chat.unreadCounts),
        },
      };
    } catch (error) {
      logger.error('Send message failed:', error);
      throw error;
    }
  }

  /**
   * Get chat messages with pagination
   */
  static async getChatMessages(chatId, userId, options = {}) {
    try {
      const { page = 1, limit = 50, before = null, after = null, senderId = null } = options;

      const skip = (page - 1) * limit;

      // Verify chat access
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      // Build query
      const query = {
        chat: chatId,
        isDeleted: false,
      };

      if (before) {
        query.createdAt = { $lt: new Date(before) };
      }

      if (after) {
        query.createdAt = { $gt: new Date(after) };
      }

      if (senderId) {
        query.sender = senderId;
      }

      // Get messages with pagination
      const [messages, total] = await Promise.all([
        Message.find(query)
          .populate({
            path: 'sender',
            select: 'username avatar displayName',
          })
          .populate({
            path: 'repliesTo',
            select: 'content sender createdAt',
            populate: {
              path: 'sender',
              select: 'username avatar',
            },
          })
          .populate({
            path: 'readBy.user',
            select: 'username avatar',
          })
          .populate({
            path: 'reactions.user',
            select: 'username avatar',
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Message.countDocuments(query),
      ]);

      // Reverse to get chronological order
      const chronologicalMessages = messages.reverse();

      // Mark messages as read for current user
      const unreadMessages = messages.filter(
        msg => !msg.readBy.some(reader => reader.user && reader.user._id.toString() === userId)
      );

      if (unreadMessages.length > 0) {
        const now = new Date();
        await Message.updateMany(
          { _id: { $in: unreadMessages.map(msg => msg._id) } },
          {
            $addToSet: {
              readBy: {
                user: userId,
                readAt: now,
              },
            },
          }
        );

        // Update chat's unread count for current user
        if (chat.unreadCounts && chat.unreadCounts.has(userId)) {
          const currentUnread = chat.unreadCounts.get(userId);
          const newUnread = Math.max(0, currentUnread - unreadMessages.length);
          chat.unreadCounts.set(userId, newUnread);
          await chat.save();
        }
      }

      return {
        messages: chronologicalMessages,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Get chat messages failed:', error);
      throw error;
    }
  }

  /**
   * Mark chat messages as read
   */
  static async markMessagesAsRead(chatId, userId, messageIds = []) {
    try {
      // Verify chat access
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      const now = new Date();
      let updatedMessageIds = [];

      if (messageIds.length > 0) {
        // Mark specific messages as read
        const result = await Message.updateMany(
          {
            _id: { $in: messageIds },
            chat: chatId,
            'readBy.user': { $ne: userId },
          },
          {
            $addToSet: {
              readBy: {
                user: userId,
                readAt: now,
              },
            },
          }
        );

        updatedMessageIds = messageIds;
      } else {
        // Mark all unread messages in chat as read
        const unreadMessages = await Message.find({
          chat: chatId,
          'readBy.user': { $ne: userId },
          isDeleted: false,
        }).select('_id');

        if (unreadMessages.length > 0) {
          await Message.updateMany(
            {
              _id: { $in: unreadMessages.map(m => m._id) },
            },
            {
              $addToSet: {
                readBy: {
                  user: userId,
                  readAt: now,
                },
              },
            }
          );

          updatedMessageIds = unreadMessages.map(m => m._id);
        }
      }

      // Update chat's unread count
      if (chat.unreadCounts && chat.unreadCounts.has(userId)) {
        const currentUnread = chat.unreadCounts.get(userId);
        const newUnread = Math.max(0, currentUnread - updatedMessageIds.length);
        chat.unreadCounts.set(userId, newUnread);
        await chat.save();
      }

      return {
        markedCount: updatedMessageIds.length,
        chatId,
        userId,
      };
    } catch (error) {
      logger.error('Mark messages as read failed:', error);
      throw error;
    }
  }

  /**
   * Edit message
   */
  static async editMessage(messageId, userId, content) {
    try {
      if (!content || content.trim().length === 0) {
        throw new ValidationError('Message content is required');
      }

      if (content.length > MAX_MESSAGE_LENGTH) {
        throw new ValidationError(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
      }

      const message = await Message.findOne({
        _id: messageId,
        sender: userId,
        isDeleted: false,
      });

      if (!message) {
        throw new NotFoundError('Message not found or not authorized to edit');
      }

      // Check edit time limit (15 minutes)
      const editWindow = 15 * 60 * 1000;
      if (Date.now() - message.createdAt.getTime() > editWindow) {
        throw new ValidationError('Message can only be edited within 15 minutes of sending');
      }

      // Update message
      message.content = content.trim();
      message.isEdited = true;
      message.editedAt = new Date();
      await message.save();

      // Populate updated message
      const updatedMessage = await Message.findById(messageId).populate({
        path: 'sender',
        select: 'username avatar',
      });

      return updatedMessage;
    } catch (error) {
      logger.error('Edit message failed:', error);
      throw error;
    }
  }

  /**
   * Delete message
   */
  static async deleteMessage(messageId, userId, deleteForEveryone = false) {
    try {
      const message = await Message.findOne({
        _id: messageId,
        isDeleted: false,
      }).populate('chat');

      if (!message) {
        throw new NotFoundError('Message not found');
      }

      // Check permissions
      const isSender = message.sender.toString() === userId;
      const isGroupAdmin =
        message.chat?.chatType === 'group' && message.chat.admins.includes(userId);

      if (!isSender && !isGroupAdmin) {
        throw new AuthorizationError('Not authorized to delete this message');
      }

      // For delete for everyone, admin permission is required unless you're the sender
      if (deleteForEveryone && !isSender && !isGroupAdmin) {
        throw new AuthorizationError('Only admins can delete messages for everyone');
      }

      // Soft delete the message
      message.isDeleted = true;
      message.deletedAt = new Date();
      message.deletedBy = userId;
      message.deleteForEveryone = deleteForEveryone;
      await message.save();

      // If this was the last message in chat, update chat's last message
      if (message.chat.lastMessage && message.chat.lastMessage.toString() === messageId) {
        const previousMessage = await Message.findOne({
          chat: message.chat._id,
          isDeleted: false,
          _id: { $ne: messageId },
        }).sort({ createdAt: -1 });

        message.chat.lastMessage = previousMessage?._id || null;
        await message.chat.save();
      }

      return {
        messageId,
        deletedAt: message.deletedAt,
        deleteForEveryone,
      };
    } catch (error) {
      logger.error('Delete message failed:', error);
      throw error;
    }
  }

  /**
   * Add reaction to message
   */
  static async addMessageReaction(messageId, userId, emoji) {
    try {
      const message = await Message.findOne({
        _id: messageId,
        isDeleted: false,
      });

      if (!message) {
        throw new NotFoundError('Message not found');
      }

      // Verify user has access to the chat
      const chat = await Chat.findOne({
        _id: message.chat,
        participants: userId,
      });

      if (!chat) {
        throw new AuthorizationError('Access denied');
      }

      // Check if reaction already exists
      const existingReactionIndex = message.reactions.findIndex(
        r => r.user.toString() === userId && r.emoji === emoji
      );

      if (existingReactionIndex >= 0) {
        // Remove existing reaction
        message.reactions.splice(existingReactionIndex, 1);
      } else {
        // Add new reaction
        message.reactions.push({
          user: userId,
          emoji,
          reactedAt: new Date(),
        });
      }

      await message.save();

      // Populate reactions
      const updatedMessage = await Message.findById(messageId).populate({
        path: 'reactions.user',
        select: 'username avatar',
      });

      return {
        reactions: updatedMessage.reactions,
        action: existingReactionIndex >= 0 ? 'removed' : 'added',
      };
    } catch (error) {
      logger.error('Add message reaction failed:', error);
      throw error;
    }
  }

  /**
   * Update group settings
   */
  static async updateGroupSettings(groupId, userId, settings) {
    try {
      // Find group and verify admin access
      const group = await Chat.findOne({
        _id: groupId,
        chatType: 'group',
        participants: userId,
        admins: userId,
        isArchived: false,
      });

      if (!group) {
        throw new NotFoundError('Group not found or admin access required');
      }

      // Update settings
      const updatedGroup = await Chat.findByIdAndUpdate(
        groupId,
        {
          $set: {
            settings: { ...group.settings, ...settings },
            updatedAt: new Date(),
          },
        },
        { new: true }
      ).populate('admins', 'username avatar');

      return updatedGroup;
    } catch (error) {
      logger.error('Update group settings failed:', error);
      throw error;
    }
  }

  /**
   * Add participants to group
   */
  static async addGroupParticipants(groupId, userId, participantIds) {
    try {
      if (!Array.isArray(participantIds) || participantIds.length === 0) {
        throw new ValidationError('Participant IDs are required');
      }

      // Find group and verify admin access
      const group = await Chat.findOne({
        _id: groupId,
        chatType: 'group',
        participants: userId,
        admins: userId,
        isArchived: false,
      });

      if (!group) {
        throw new NotFoundError('Group not found or admin access required');
      }

      // Check if group is full
      const maxParticipants = group.settings?.maxParticipants || MAX_CHAT_PARTICIPANTS;
      if (group.participants.length + participantIds.length > maxParticipants) {
        throw new ValidationError(`Group cannot have more than ${maxParticipants} members`);
      }

      // Get users to add
      const usersToAdd = await User.find({
        _id: { $in: participantIds },
      }).select('_id username blockedUsers');

      if (usersToAdd.length !== participantIds.length) {
        throw new NotFoundError('One or more users not found');
      }

      // Check for blocked relationships
      const currentUser = await User.findById(userId);
      const blockedUsers = usersToAdd.filter(
        user => currentUser.blockedUsers?.includes(user._id) || user.blockedUsers?.includes(userId)
      );

      if (blockedUsers.length > 0) {
        throw new AuthorizationError('Cannot add blocked users to group');
      }

      // Filter out existing members
      const existingMemberIds = group.participants.map(p => p.toString());
      const newMembers = usersToAdd.filter(
        user => !existingMemberIds.includes(user._id.toString())
      );

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
          select: 'username avatar displayName',
        })
        .populate({
          path: 'admins',
          select: 'username avatar',
        });

      return {
        group: updatedGroup,
        addedCount: newMembers.length,
        addedUsers: newMembers.map(m => ({
          id: m._id,
          username: m.username,
        })),
      };
    } catch (error) {
      logger.error('Add group participants failed:', error);
      throw error;
    }
  }

  /**
   * Remove participant from group
   */
  static async removeGroupParticipant(groupId, userId, targetUserId) {
    try {
      // Find group
      const group = await Chat.findOne({
        _id: groupId,
        chatType: 'group',
        participants: userId,
        isArchived: false,
      });

      if (!group) {
        throw new NotFoundError('Group not found or access denied');
      }

      // Check permissions
      const isAdmin = group.admins.includes(userId);
      const isSelfRemoval = targetUserId === userId;

      if (!isAdmin && !isSelfRemoval) {
        throw new AuthorizationError('Only admins can remove other members');
      }

      // Check if user to remove is in the group
      if (!group.participants.includes(targetUserId)) {
        throw new ValidationError('User is not a member of this group');
      }

      // Cannot remove the last admin
      if (group.admins.includes(targetUserId) && group.admins.length === 1) {
        throw new ValidationError('Cannot remove the last admin');
      }

      // Remove user from participants
      group.participants = group.participants.filter(p => p.toString() !== targetUserId);

      // Remove from admins if they were an admin
      group.admins = group.admins.filter(admin => admin.toString() !== targetUserId);

      // Remove unread count
      group.unreadCounts.delete(targetUserId);

      await group.save();

      return {
        groupId,
        removedUserId: targetUserId,
        isSelfRemoval,
      };
    } catch (error) {
      logger.error('Remove group participant failed:', error);
      throw error;
    }
  }

  /**
   * Promote member to admin
   */
  static async promoteToAdmin(groupId, userId, targetUserId) {
    try {
      // Find group and verify current user is admin
      const group = await Chat.findOne({
        _id: groupId,
        chatType: 'group',
        participants: userId,
        admins: userId,
        isArchived: false,
      });

      if (!group) {
        throw new NotFoundError('Group not found or admin access required');
      }

      // Check if user to promote is a member
      if (!group.participants.includes(targetUserId)) {
        throw new ValidationError('User is not a member of this group');
      }

      // Check if user is already admin
      if (group.admins.includes(targetUserId)) {
        throw new ConflictError('User is already an admin');
      }

      // Promote to admin
      group.admins.push(targetUserId);
      await group.save();

      return {
        groupId,
        promotedUserId: targetUserId,
      };
    } catch (error) {
      logger.error('Promote to admin failed:', error);
      throw error;
    }
  }

  /**
   * Demote admin to member
   */
  static async demoteAdmin(groupId, userId, targetUserId) {
    try {
      // Find group and verify current user is admin
      const group = await Chat.findOne({
        _id: groupId,
        chatType: 'group',
        participants: userId,
        admins: userId,
        isArchived: false,
      });

      if (!group) {
        throw new NotFoundError('Group not found or admin access required');
      }

      // Check if user to demote is an admin
      if (!group.admins.includes(targetUserId)) {
        throw new ValidationError('User is not an admin');
      }

      // Cannot demote yourself
      if (targetUserId === userId) {
        throw new ValidationError('Cannot demote yourself');
      }

      // Cannot demote the last admin
      if (group.admins.length === 1) {
        throw new ValidationError('Cannot demote the last admin');
      }

      // Demote admin
      group.admins = group.admins.filter(admin => admin.toString() !== targetUserId);
      await group.save();

      return {
        groupId,
        demotedUserId: targetUserId,
      };
    } catch (error) {
      logger.error('Demote admin failed:', error);
      throw error;
    }
  }

  /**
   * Archive chat
   */
  static async archiveChat(chatId, userId) {
    try {
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
        isArchived: false,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or already archived');
      }

      chat.isArchived = true;
      chat.archivedBy = userId;
      chat.archivedAt = new Date();
      await chat.save();

      return {
        chatId,
        archivedAt: chat.archivedAt,
      };
    } catch (error) {
      logger.error('Archive chat failed:', error);
      throw error;
    }
  }

  /**
   * Unarchive chat
   */
  static async unarchiveChat(chatId, userId) {
    try {
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
        isArchived: true,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or not archived');
      }

      chat.isArchived = false;
      chat.archivedBy = null;
      chat.archivedAt = null;
      await chat.save();

      return {
        chatId,
        unarchivedAt: new Date(),
      };
    } catch (error) {
      logger.error('Unarchive chat failed:', error);
      throw error;
    }
  }

  /**
   * Search messages in chat
   */
  static async searchChatMessages(chatId, userId, searchOptions) {
    try {
      const {
        query,
        page = 1,
        limit = 20,
        senderId,
        dateFrom,
        dateTo,
        messageType,
      } = searchOptions;

      if (!query || query.trim().length < 2) {
        throw new ValidationError('Search query must be at least 2 characters');
      }

      const skip = (page - 1) * limit;

      // Verify chat access
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      // Build search query
      const searchQuery = {
        chat: chatId,
        isDeleted: false,
        $or: [
          { content: { $regex: query, $options: 'i' } },
          { 'attachments.filename': { $regex: query, $options: 'i' } },
        ],
      };

      if (senderId) {
        searchQuery.sender = senderId;
      }

      if (messageType) {
        searchQuery.messageType = messageType;
      }

      if (dateFrom) {
        searchQuery.createdAt = { ...searchQuery.createdAt, $gte: new Date(dateFrom) };
      }

      if (dateTo) {
        searchQuery.createdAt = { ...searchQuery.createdAt, $lte: new Date(dateTo) };
      }

      // Execute search
      const [messages, total] = await Promise.all([
        Message.find(searchQuery)
          .populate({
            path: 'sender',
            select: 'username avatar displayName',
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Message.countDocuments(searchQuery),
      ]);

      return {
        messages,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error('Search chat messages failed:', error);
      throw error;
    }
  }

  /**
   * Cleanup old messages (for background job)
   */
  static async cleanupOldMessages() {
    try {
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - MESSAGE_RETENTION_DAYS);

      // Find messages older than retention period
      const oldMessages = await Message.find({
        createdAt: { $lt: retentionDate },
        isDeleted: false,
      }).select('_id chat');

      if (oldMessages.length === 0) {
        return { cleaned: 0 };
      }

      // Soft delete old messages
      await Message.updateMany(
        { _id: { $in: oldMessages.map(m => m._id) } },
        {
          $set: {
            isDeleted: true,
            deletedBy: 'system',
            deletedAt: new Date(),
            deleteForEveryone: true,
          },
        }
      );

      // Update chat last messages if needed
      const chatsToUpdate = [...new Set(oldMessages.map(m => m.chat.toString()))];

      for (const chatId of chatsToUpdate) {
        const latestMessage = await Message.findOne({
          chat: chatId,
          isDeleted: false,
        }).sort({ createdAt: -1 });

        await Chat.findByIdAndUpdate(chatId, {
          lastMessage: latestMessage?._id || null,
        });
      }

      logger.info(`Cleaned up ${oldMessages.length} old messages`);
      return { cleaned: oldMessages.length };
    } catch (error) {
      logger.error('Cleanup old messages failed:', error);
      throw error;
    }
  }

  /**
   * Get chat statistics
   */
  static async getChatStatistics(chatId, userId, period = '30d') {
    try {
      // Verify chat access
      const chat = await Chat.findOne({
        _id: chatId,
        participants: userId,
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      // Calculate date range
      let startDate = new Date();
      switch (period) {
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
        case '90d':
          startDate.setDate(startDate.getDate() - 90);
          break;
        case 'all':
          startDate = new Date(0);
          break;
      }

      // Get message statistics
      const messageStats = await Message.aggregate([
        {
          $match: {
            chat: mongoose.Types.ObjectId(chatId),
            isDeleted: false,
            createdAt: { $gte: startDate },
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

      // Get top senders
      const topSenders = await Message.aggregate([
        {
          $match: {
            chat: mongoose.Types.ObjectId(chatId),
            isDeleted: false,
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: '$sender',
            messageCount: { $sum: 1 },
            lastMessage: { $max: '$createdAt' },
          },
        },
        {
          $sort: { messageCount: -1 },
        },
        {
          $limit: 10,
        },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        {
          $unwind: '$user',
        },
        {
          $project: {
            userId: '$_id',
            username: '$user.username',
            avatar: '$user.avatar',
            messageCount: 1,
            lastMessage: 1,
          },
        },
      ]);

      // Get message type distribution
      const messageTypes = await Message.aggregate([
        {
          $match: {
            chat: mongoose.Types.ObjectId(chatId),
            isDeleted: false,
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: '$messageType',
            count: { $sum: 1 },
          },
        },
      ]);

      return {
        period,
        totalMessages: messageStats.reduce((sum, day) => sum + day.count, 0),
        activeDays: messageStats.length,
        uniqueSenders: [...new Set(messageStats.flatMap(day => day.senders))].length,
        dailyStats: messageStats,
        topSenders,
        messageTypes,
        chatInfo: {
          id: chat._id,
          chatType: chat.chatType,
          chatName: chat.chatName,
          createdAt: chat.createdAt,
        },
      };
    } catch (error) {
      logger.error('Get chat statistics failed:', error);
      throw error;
    }
  }
}

module.exports = ChatService;
