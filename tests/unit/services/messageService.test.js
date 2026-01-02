import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import messageService from '../../../src/services/messageService';
import Message from '../../../src/models/Message';
import Chat from '../../../src/models/Chat';
import User from '../../../src/models/User';
import redisClient from '../../../src/config/redis';
import mongoose from 'mongoose';

jest.mock('../../../src/models/Message');
jest.mock('../../../src/models/Chat');
jest.mock('../../../src/models/User');
jest.mock('../../../src/config/redis');

describe('Message Service', () => {
  let mockMessage;
  let mockChat;
  let mockUser;
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
    };

    mockChat = {
      _id: '507f1f77bcf86cd799439021',
      participants: [
        { user: '507f1f77bcf86cd799439011' },
        { user: '507f1f77bcf86cd799439012' },
      ],
      lastMessage: null,
      save: jest.fn().mockResolvedValue(true),
    };

    mockMessage = {
      _id: '507f1f77bcf86cd799439031',
      chat: '507f1f77bcf86cd799439021',
      sender: '507f1f77bcf86cd799439011',
      content: 'Hello World',
      type: 'text',
      status: 'sent',
      metadata: {},
      reactions: [],
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue({
        ...mockMessage,
        sender: mockUser,
        chat: mockChat,
      }),
    };

    mongoose.startSession.mockResolvedValue(mockSession);
  });

  describe('sendMessage', () => {
    it('should send text message successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const senderId = '507f1f77bcf86cd799439011';
      const content = 'Hello, how are you?';
      const type = 'text';

      Chat.findById.mockResolvedValue(mockChat);
      Message.create.mockResolvedValue(mockMessage);
      redisClient.publish.mockResolvedValue(1);

      const result = await messageService.sendMessage(chatId, senderId, content, type);

      expect(Chat.findById).toHaveBeenCalledWith(chatId);
      expect(Message.create).toHaveBeenCalledWith({
        chat: chatId,
        sender: senderId,
        content,
        type,
        status: 'sent',
      });
      expect(mockChat.lastMessage).toBe(mockMessage._id);
      expect(mockChat.save).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('should send file message successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const senderId = '507f1f77bcf86cd799439011';
      const fileData = {
        url: 'https://example.com/file.jpg',
        filename: 'photo.jpg',
        size: 1024,
        mimeType: 'image/jpeg',
      };
      const type = 'image';

      Chat.findById.mockResolvedValue(mockChat);
      Message.create.mockResolvedValue({
        ...mockMessage,
        content: fileData.url,
        metadata: {
          filename: fileData.filename,
          size: fileData.size,
          mimeType: fileData.mimeType,
        },
      });

      const result = await messageService.sendMessage(chatId, senderId, fileData, type);

      expect(Message.create).toHaveBeenCalledWith({
        chat: chatId,
        sender: senderId,
        content: fileData.url,
        type,
        status: 'sent',
        metadata: {
          filename: fileData.filename,
          size: fileData.size,
          mimeType: fileData.mimeType,
        },
      });
      expect(result.success).toBe(true);
    });

    it('should fail if sender not in chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const senderId = 'unauthorizedUser';
      const content = 'Hello';

      const unauthorizedChat = {
        ...mockChat,
        participants: [{ user: '507f1f77bcf86cd799439012' }],
      };

      Chat.findById.mockResolvedValue(unauthorizedChat);

      const result = await messageService.sendMessage(chatId, senderId, content);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a participant');
    });

    it('should fail if chat not found', async () => {
      const chatId = 'nonexistent';
      const senderId = '507f1f77bcf86cd799439011';
      const content = 'Hello';

      Chat.findById.mockResolvedValue(null);

      const result = await messageService.sendMessage(chatId, senderId, content);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('editMessage', () => {
    it('should edit message successfully', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const newContent = 'Edited message';

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMessage),
      });

      const result = await messageService.editMessage(messageId, userId, newContent);

      expect(Message.findById).toHaveBeenCalledWith(messageId);
      expect(mockMessage.content).toBe(newContent);
      expect(mockMessage.editedAt).toBeDefined();
      expect(mockMessage.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if message not found', async () => {
      const messageId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';
      const newContent = 'Edited message';

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await messageService.editMessage(messageId, userId, newContent);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail if user not the sender', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = 'notTheSender';
      const newContent = 'Edited message';

      const otherUserMessage = {
        ...mockMessage,
        sender: '507f1f77bcf86cd799439012',
      };

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(otherUserMessage),
      });

      const result = await messageService.editMessage(messageId, userId, newContent);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorized');
    });

    it('should fail if message is too old to edit', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const newContent = 'Edited message';

      const oldMessage = {
        ...mockMessage,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
      };

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(oldMessage),
      });

      const result = await messageService.editMessage(messageId, userId, newContent);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be edited');
    });
  });

  describe('deleteMessage', () => {
    it('should delete message successfully', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMessage),
      });

      const result = await messageService.deleteMessage(messageId, userId);

      expect(mockMessage.deleted).toBe(true);
      expect(mockMessage.deletedAt).toBeDefined();
      expect(mockMessage.deletedBy).toBe(userId);
      expect(mockMessage.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should permanently delete message', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMessage),
      });

      const result = await messageService.deleteMessage(messageId, userId, true);

      expect(Message.findByIdAndDelete).toHaveBeenCalledWith(messageId);
      expect(result.success).toBe(true);
    });
  });

  describe('markAsRead', () => {
    it('should mark messages as read', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const messageIds = ['507f1f77bcf86cd799439031', '507f1f77bcf86cd799439032'];

      Message.updateMany.mockResolvedValue({ modifiedCount: 2 });

      const result = await messageService.markAsRead(chatId, userId, messageIds);

      expect(Message.updateMany).toHaveBeenCalledWith(
        {
          _id: { $in: messageIds },
          chat: chatId,
          sender: { $ne: userId },
          status: 'delivered',
        },
        { $set: { status: 'read', readAt: expect.any(Date) } }
      );
      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(2);
    });

    it('should mark all messages as read', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Message.updateMany.mockResolvedValue({ modifiedCount: 5 });

      const result = await messageService.markAsRead(chatId, userId);

      expect(Message.updateMany).toHaveBeenCalledWith(
        {
          chat: chatId,
          sender: { $ne: userId },
          status: { $in: ['sent', 'delivered'] },
        },
        { $set: { status: 'read', readAt: expect.any(Date) } }
      );
      expect(result.success).toBe(true);
    });
  });

  describe('markAsDelivered', () => {
    it('should mark messages as delivered', async () => {
      const messageIds = ['507f1f77bcf86cd799439031', '507f1f77bcf86cd799439032'];
      const userId = '507f1f77bcf86cd799439011';

      Message.find.mockResolvedValue([mockMessage]);
      Message.updateMany.mockResolvedValue({ modifiedCount: 2 });

      const result = await messageService.markAsDelivered(messageIds, userId);

      expect(Message.updateMany).toHaveBeenCalledWith(
        {
          _id: { $in: messageIds },
          sender: { $ne: userId },
          status: 'sent',
        },
        { $set: { status: 'delivered', deliveredAt: expect.any(Date) } }
      );
      expect(result.success).toBe(true);
    });
  });

  describe('addReaction', () => {
    it('should add reaction to message', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const emoji = '👍';

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMessage),
      });

      const result = await messageService.addReaction(messageId, userId, emoji);

      expect(mockMessage.reactions).toContainEqual({
        user: userId,
        emoji,
        createdAt: expect.any(Date),
      });
      expect(mockMessage.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should update existing reaction', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const emoji = '❤️';

      const messageWithReaction = {
        ...mockMessage,
        reactions: [{ user: userId, emoji: '👍', createdAt: new Date() }],
      };

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(messageWithReaction),
      });

      const result = await messageService.addReaction(messageId, userId, emoji);

      expect(messageWithReaction.reactions[0].emoji).toBe(emoji);
      expect(result.success).toBe(true);
    });
  });

  describe('removeReaction', () => {
    it('should remove reaction from message', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const emoji = '👍';

      const messageWithReaction = {
        ...mockMessage,
        reactions: [{ user: userId, emoji, createdAt: new Date() }],
      };

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(messageWithReaction),
      });

      const result = await messageService.removeReaction(messageId, userId, emoji);

      expect(messageWithReaction.reactions).toHaveLength(0);
      expect(result.success).toBe(true);
    });
  });

  describe('forwardMessage', () => {
    it('should forward message to multiple chats', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const chatIds = ['507f1f77bcf86cd799439022', '507f1f77bcf86cd799439023'];

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMessage),
      });

      Chat.find.mockResolvedValue([
        { _id: '507f1f77bcf86cd799439022', participants: [{ user: userId }] },
        { _id: '507f1f77bcf86cd799439023', participants: [{ user: userId }] },
      ]);

      Message.create.mockResolvedValue(mockMessage);

      const result = await messageService.forwardMessage(messageId, userId, chatIds);

      expect(Message.create).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.forwardedCount).toBe(2);
    });
  });

  describe('getMessageThread', () => {
    it('should get message thread with context', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const userId = '507f1f77bcf86cd799439011';
      const limit = 10;

      Message.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMessage),
      });

      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockMessage]),
      });

      const result = await messageService.getMessageThread(messageId, userId, limit);

      expect(Message.find).toHaveBeenCalledWith({
        chat: mockMessage.chat._id,
        _id: { $ne: messageId },
      });
      expect(result.success).toBe(true);
      expect(result.messages).toBeDefined();
    });
  });

  describe('searchMessages', () => {
    it('should search messages in chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const query = 'hello';
      const page = 1;
      const limit = 10;

      Chat.findById.mockResolvedValue(mockChat);

      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockMessage]),
      });

      Message.countDocuments.mockResolvedValue(1);

      const result = await messageService.searchMessages(chatId, userId, query, page, limit);

      expect(Message.find).toHaveBeenCalledWith({
        chat: chatId,
        content: { $regex: query, $options: 'i' },
        deleted: { $ne: true },
      });
      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(1);
    });

    it('should search across all user chats', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const query = 'important';
      const page = 1;
      const limit = 10;

      Chat.find.mockResolvedValue([mockChat]);

      Message.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockMessage]),
      });

      const result = await messageService.searchMessages(null, userId, query, page, limit);

      expect(Message.find).toHaveBeenCalledWith({
        chat: { $in: [mockChat._id] },
        content: { $regex: query, $options: 'i' },
        deleted: { $ne: true },
      });
      expect(result.success).toBe(true);
    });
  });
});