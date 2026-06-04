import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import chatService from '../../../src/services/chatService';
import Chat from '../../../src/models/Chat';
import User from '../../../src/models/User';
import Message from '../../../src/models/Message';
import redisClient from '../../../src/config/redis';
import mongoose from 'mongoose';

jest.mock('../../../src/models/Chat');
jest.mock('../../../src/models/User');
jest.mock('../../../src/models/Message');
jest.mock('../../../src/config/redis');

describe('Chat Service', () => {
  let mockChat;
  let mockUser;
  let mockMessage;
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
      chats: [],
      save: jest.fn().mockResolvedValue(true),
    };

    mockChat = {
      _id: '507f1f77bcf86cd799439021',
      participants: [
        { user: '507f1f77bcf86cd799439011', joinedAt: new Date() },
        { user: '507f1f77bcf86cd799439012', joinedAt: new Date() },
      ],
      type: 'private',
      name: null,
      description: null,
      createdBy: '507f1f77bcf86cd799439011',
      admins: ['507f1f77bcf86cd799439011'],
      messages: [],
      lastMessage: null,
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue({
        ...mockChat,
        participants: [
          { user: mockUser, joinedAt: new Date() },
          { user: { _id: '507f1f77bcf86cd799439012', username: 'user2' }, joinedAt: new Date() },
        ],
      }),
    };

    mockMessage = {
      _id: '507f1f77bcf86cd799439031',
      chat: '507f1f77bcf86cd799439021',
      sender: '507f1f77bcf86cd799439011',
      content: 'Hello World',
      type: 'text',
      status: 'sent',
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };

    mongoose.startSession.mockResolvedValue(mockSession);
  });

  describe('createChat', () => {
    it('should create private chat successfully', async () => {
      const creatorId = '507f1f77bcf86cd799439011';
      const participantIds = ['507f1f77bcf86cd799439012'];
      const type = 'private';

      User.find.mockResolvedValue([mockUser, { _id: '507f1f77bcf86cd799439012' }]);
      Chat.findOne.mockResolvedValue(null);
      Chat.create.mockResolvedValue(mockChat);

      const result = await chatService.createChat(creatorId, participantIds, type);

      expect(User.find).toHaveBeenCalledWith({ _id: { $in: participantIds } });
      expect(Chat.findOne).toHaveBeenCalledWith({
        type: 'private',
        'participants.user': { $all: [creatorId, ...participantIds] },
        'participants.0': { $exists: true },
      });
      expect(Chat.create).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.chat).toBeDefined();
    });

    it('should create group chat successfully', async () => {
      const creatorId = '507f1f77bcf86cd799439011';
      const participantIds = ['507f1f77bcf86cd799439012', '507f1f77bcf86cd799439013'];
      const type = 'group';
      const name = 'Group Chat';

      User.find.mockResolvedValue([
        mockUser,
        { _id: '507f1f77bcf86cd799439012' },
        { _id: '507f1f77bcf86cd799439013' },
      ]);
      Chat.create.mockResolvedValue(mockChat);

      const result = await chatService.createChat(creatorId, participantIds, type, name);

      expect(Chat.create).toHaveBeenCalledWith({
        type: 'group',
        name,
        participants: expect.any(Array),
        createdBy: creatorId,
        admins: [creatorId],
      });
      expect(result.success).toBe(true);
    });

    it('should return existing private chat', async () => {
      const creatorId = '507f1f77bcf86cd799439011';
      const participantIds = ['507f1f77bcf86cd799439012'];

      Chat.findOne.mockResolvedValue(mockChat);

      const result = await chatService.createChat(creatorId, participantIds, 'private');

      expect(Chat.create).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.chat._id).toBe(mockChat._id);
    });

    it('should fail if participants not found', async () => {
      const creatorId = '507f1f77bcf86cd799439011';
      const participantIds = ['nonexistent'];

      User.find.mockResolvedValue([]);

      const result = await chatService.createChat(creatorId, participantIds, 'private');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Participants not found');
    });
  });

  describe('getUserChats', () => {
    it('should get user chats with pagination', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const page = 1;
      const limit = 10;

      const mockChats = [mockChat, { ...mockChat, _id: '507f1f77bcf86cd799439022' }];

      Chat.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockChats),
      });

      Chat.countDocuments.mockResolvedValue(2);

      const result = await chatService.getUserChats(userId, page, limit);

      expect(Chat.find).toHaveBeenCalledWith({
        'participants.user': userId,
        'participants.leftAt': { $exists: false },
      });
      expect(result.success).toBe(true);
      expect(result.chats).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
    });

    it('should filter archived chats', async () => {
      const userId = '507f1f77bcf86cd799439011';

      Chat.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await chatService.getUserChats(userId, 1, 10, true);

      expect(Chat.find).toHaveBeenCalledWith({
        'participants.user': userId,
        'participants.leftAt': { $exists: true },
      });
    });
  });

  describe('getChatById', () => {
    it('should get chat by id successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.getChatById(chatId, userId);

      expect(Chat.findById).toHaveBeenCalledWith(chatId);
      expect(result.success).toBe(true);
      expect(result.chat).toBeDefined();
    });

    it('should fail if user not in chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = 'unauthorizedUserId';

      const unauthorizedChat = {
        ...mockChat,
        participants: [{ user: '507f1f77bcf86cd799439012' }],
      };

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(unauthorizedChat),
      });

      const result = await chatService.getChatById(chatId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a participant');
    });

    it('should fail if chat not found', async () => {
      const chatId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await chatService.getChatById(chatId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('updateChat', () => {
    it('should update group chat info successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const updates = { name: 'Updated Group Name', description: 'New description' };

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.updateChat(chatId, userId, updates);

      expect(mockChat.name).toBe(updates.name);
      expect(mockChat.description).toBe(updates.description);
      expect(mockChat.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if user is not admin', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = 'notAdminId';
      const updates = { name: 'Updated Name' };

      const nonAdminChat = {
        ...mockChat,
        admins: ['507f1f77bcf86cd799439012'],
      };

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(nonAdminChat),
      });

      const result = await chatService.updateChat(chatId, userId, updates);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorized');
    });
  });

  describe('addParticipants', () => {
    it('should add participants to group chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const participantIds = ['507f1f77bcf86cd799439013'];

      User.find.mockResolvedValue([{ _id: '507f1f77bcf86cd799439013' }]);
      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.addParticipants(chatId, userId, participantIds);

      expect(mockChat.participants).toHaveLength(3);
      expect(mockChat.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if user already in chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const participantIds = ['507f1f77bcf86cd799439012']; // Already in chat

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.addParticipants(chatId, userId, participantIds);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already in chat');
    });
  });

  describe('removeParticipant', () => {
    it('should remove participant from group chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const adminId = '507f1f77bcf86cd799439011';
      const participantId = '507f1f77bcf86cd799439012';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.removeParticipant(chatId, adminId, participantId);

      const participant = mockChat.participants.find(p => p.user === participantId);
      expect(participant.leftAt).toBeDefined();
      expect(mockChat.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should allow self-removal', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.removeParticipant(chatId, userId, userId);

      expect(result.success).toBe(true);
    });
  });

  describe('updateParticipantRole', () => {
    it('should promote participant to admin', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const adminId = '507f1f77bcf86cd799439011';
      const participantId = '507f1f77bcf86cd799439012';
      const role = 'admin';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.updateParticipantRole(chatId, adminId, participantId, role);

      expect(mockChat.admins).toContain(participantId);
      expect(mockChat.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should demote admin to participant', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const adminId = '507f1f77bcf86cd799439011';
      const participantId = '507f1f77bcf86cd799439011'; // Self demotion
      const role = 'participant';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.updateParticipantRole(chatId, adminId, participantId, role);

      expect(mockChat.admins).not.toContain(participantId);
      expect(result.success).toBe(true);
    });
  });

  describe('leaveChat', () => {
    it('should leave chat successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.leaveChat(chatId, userId);

      const participant = mockChat.participants.find(p => p.user === userId);
      expect(participant.leftAt).toBeDefined();
      expect(mockChat.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should transfer ownership if last admin leaves', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      const singleAdminChat = {
        ...mockChat,
        admins: [userId],
        participants: [
          { user: userId, joinedAt: new Date() },
          { user: '507f1f77bcf86cd799439012', joinedAt: new Date() },
          { user: '507f1f77bcf86cd799439013', joinedAt: new Date() },
        ],
      };

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(singleAdminChat),
      });

      const result = await chatService.leaveChat(chatId, userId);

      expect(singleAdminChat.admins).toContain('507f1f77bcf86cd799439012');
      expect(singleAdminChat.createdBy).toBe('507f1f77bcf86cd799439012');
      expect(result.success).toBe(true);
    });
  });

  describe('deleteChat', () => {
    it('should delete chat successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      Message.deleteMany.mockResolvedValue({ deletedCount: 10 });

      const result = await chatService.deleteChat(chatId, userId);

      expect(Chat.findByIdAndDelete).toHaveBeenCalledWith(chatId);
      expect(Message.deleteMany).toHaveBeenCalledWith({ chat: chatId });
      expect(result.success).toBe(true);
    });

    it('should archive chat instead of deleting', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      const result = await chatService.deleteChat(chatId, userId, true);

      expect(Chat.findByIdAndDelete).not.toHaveBeenCalled();
      expect(mockChat.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('getChatMessages', () => {
    it('should get chat messages with pagination', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const page = 1;
      const limit = 20;

      const mockMessages = [mockMessage, { ...mockMessage, _id: '507f1f77bcf86cd799439032' }];

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockMessages),
      });

      Message.countDocuments.mockResolvedValue(2);

      const result = await chatService.getChatMessages(chatId, userId, page, limit);

      expect(Message.find).toHaveBeenCalledWith({ chat: chatId });
      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(2);
    });

    it('should filter messages by type', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockChat),
      });

      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await chatService.getChatMessages(chatId, userId, 1, 20, 'image');

      expect(Message.find).toHaveBeenCalledWith({
        chat: chatId,
        type: 'image',
      });
    });
  });
});