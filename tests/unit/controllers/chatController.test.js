const chatController = require('../../../src/controllers/chatController');
const chatService = require('../../../src/services/chatService');
const { validationResult } = require('express-validator');

jest.mock('../../../src/services/chatService');
jest.mock('express-validator');

describe('Chat Controller', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      user: { id: '123' },
      params: {},
      body: {},
      query: {},
      io: {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn()
      }
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
    validationResult.mockReturnValue({
      isEmpty: jest.fn().mockReturnValue(true),
      array: jest.fn().mockReturnValue([])
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getChats', () => {
    it('should get chats list successfully', async () => {
      const chats = [
        { id: 'chat1', name: 'Chat 1', lastMessage: 'Hello' },
        { id: 'chat2', name: 'Chat 2', lastMessage: 'Hi' }
      ];

      req.query = { page: '1', limit: '20', archived: 'false' };
      chatService.getUserChats.mockResolvedValue({
        chats,
        total: 2,
        page: 1,
        limit: 20
      });

      await chatController.getChats(req, res, next);

      expect(chatService.getUserChats).toHaveBeenCalledWith('123', {
        page: 1,
        limit: 20,
        archived: false
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          chats,
          pagination: {
            page: 1,
            limit: 20,
            total: 2,
            hasMore: false
          }
        }
      });
    });

    it('should handle service error', async () => {
      chatService.getUserChats.mockRejectedValue(new Error('Database error'));

      await chatController.getChats(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('createChat', () => {
    it('should create direct chat successfully', async () => {
      const mockChat = {
        id: 'chat123',
        type: 'direct',
        members: ['123', '456']
      };

      req.body = {
        type: 'direct',
        userIds: ['456']
      };

      chatService.createChat.mockResolvedValue(mockChat);

      await chatController.createChat(req, res, next);

      expect(chatService.createChat).toHaveBeenCalledWith({
        creatorId: '123',
        type: 'direct',
        userIds: ['456']
      });
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('456');
        expect(req.io.emit).toHaveBeenCalledWith('chat_created', expect.any(Object));
      }
      
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockChat,
        message: 'Chat created successfully'
      });
    });

    it('should create group chat successfully', async () => {
      const mockChat = {
        id: 'chat123',
        type: 'group',
        name: 'Group Chat',
        members: ['123', '456', '789']
      };

      req.body = {
        type: 'group',
        name: 'Group Chat',
        userIds: ['456', '789']
      };

      chatService.createChat.mockResolvedValue(mockChat);

      await chatController.createChat(req, res, next);

      expect(chatService.createChat).toHaveBeenCalledWith({
        creatorId: '123',
        type: 'group',
        name: 'Group Chat',
        userIds: ['456', '789']
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should handle validation errors', async () => {
      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'userIds', message: 'At least one user is required' }])
      });

      await chatController.createChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle self-chat creation', async () => {
      req.body = {
        type: 'direct',
        userIds: ['123'] // Same as current user
      };

      await chatController.createChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot create chat with yourself'
      });
    });
  });

  describe('getChat', () => {
    it('should get chat details successfully', async () => {
      const mockChat = {
        id: 'chat123',
        name: 'Test Chat',
        members: [{ id: '123' }, { id: '456' }]
      };

      req.params = { chatId: 'chat123' };
      chatService.getChatById.mockResolvedValue(mockChat);

      await chatController.getChat(req, res, next);

      expect(chatService.getChatById).toHaveBeenCalledWith('chat123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockChat
      });
    });

    it('should handle chat not found', async () => {
      const error = new Error('Chat not found');
      chatService.getChatById.mockRejectedValue(error);

      await chatController.getChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Chat not found'
      });
    });

    it('should handle unauthorized access', async () => {
      const error = new Error('Not authorized to access this chat');
      chatService.getChatById.mockRejectedValue(error);

      await chatController.getChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('updateChat', () => {
    it('should update chat successfully', async () => {
      const updatedChat = {
        id: 'chat123',
        name: 'Updated Chat Name',
        description: 'Updated description'
      };

      req.params = { chatId: 'chat123' };
      req.body = {
        name: 'Updated Chat Name',
        description: 'Updated description'
      };

      chatService.updateChat.mockResolvedValue(updatedChat);

      await chatController.updateChat(req, res, next);

      expect(chatService.updateChat).toHaveBeenCalledWith('chat123', '123', {
        name: 'Updated Chat Name',
        description: 'Updated description'
      });
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('chat_updated', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedChat,
        message: 'Chat updated successfully'
      });
    });

    it('should handle insufficient permissions', async () => {
      const error = new Error('Insufficient permissions');
      chatService.updateChat.mockRejectedValue(error);

      await chatController.updateChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('deleteChat', () => {
    it('should delete chat successfully', async () => {
      req.params = { chatId: 'chat123' };
      chatService.deleteChat.mockResolvedValue();

      await chatController.deleteChat(req, res, next);

      expect(chatService.deleteChat).toHaveBeenCalledWith('chat123', '123');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('chat_deleted', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Chat deleted successfully'
      });
    });
  });

  describe('getChatMessages', () => {
    it('should get chat messages successfully', async () => {
      const messages = [
        { id: 'msg1', content: 'Hello', senderId: '123' },
        { id: 'msg2', content: 'Hi', senderId: '456' }
      ];

      req.params = { chatId: 'chat123' };
      req.query = { page: '1', limit: '50', before: '2023-01-01' };

      chatService.getChatMessages.mockResolvedValue({
        messages,
        total: 2,
        page: 1,
        limit: 50,
        hasMore: false
      });

      await chatController.getChatMessages(req, res, next);

      expect(chatService.getChatMessages).toHaveBeenCalledWith('chat123', '123', {
        page: 1,
        limit: 50,
        before: '2023-01-01'
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          messages,
          pagination: {
            page: 1,
            limit: 50,
            total: 2,
            hasMore: false,
            totalPages: expect.any(Number)
          }
        }
      });
    });
  });

  describe('getChatMembers', () => {
    it('should get chat members successfully', async () => {
      const members = [
        { id: '123', username: 'user1', role: 'admin' },
        { id: '456', username: 'user2', role: 'member' }
      ];

      req.params = { chatId: 'chat123' };
      chatService.getChatMembers.mockResolvedValue(members);

      await chatController.getChatMembers(req, res, next);

      expect(chatService.getChatMembers).toHaveBeenCalledWith('chat123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: members
      });
    });
  });

  describe('addMember', () => {
    it('should add member successfully', async () => {
      const updatedChat = {
        id: 'chat123',
        members: ['123', '456', '789']
      };

      req.params = { chatId: 'chat123' };
      req.body = { userIds: ['789'] };

      chatService.addMember.mockResolvedValue(updatedChat);

      await chatController.addMember(req, res, next);

      expect(chatService.addMember).toHaveBeenCalledWith('chat123', '123', ['789']);
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('789');
        expect(req.io.emit).toHaveBeenCalledWith('member_added', expect.any(Object));
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('chat_updated', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedChat,
        message: 'Member added successfully'
      });
    });

    it('should handle adding existing member', async () => {
      const error = new Error('User is already a member');
      chatService.addMember.mockRejectedValue(error);

      await chatController.addMember(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'User is already a member'
      });
    });
  });

  describe('removeMember', () => {
    it('should remove member successfully', async () => {
      req.params = { chatId: 'chat123', userId: '456' };

      chatService.removeMember.mockResolvedValue();

      await chatController.removeMember(req, res, next);

      expect(chatService.removeMember).toHaveBeenCalledWith('chat123', '123', '456');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('456');
        expect(req.io.emit).toHaveBeenCalledWith('member_removed', expect.any(Object));
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('chat_updated', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Member removed successfully'
      });
    });

    it('should handle self-removal from group', async () => {
      req.params = { chatId: 'chat123', userId: '123' };

      await chatController.removeMember(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Use leave chat instead'
      });
    });
  });

  describe('leaveChat', () => {
    it('should leave chat successfully', async () => {
      req.params = { chatId: 'chat123' };

      chatService.leaveChat.mockResolvedValue();

      await chatController.leaveChat(req, res, next);

      expect(chatService.leaveChat).toHaveBeenCalledWith('chat123', '123');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('member_removed', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Left chat successfully'
      });
    });

    it('should handle leaving direct chat', async () => {
      const error = new Error('Cannot leave direct chat');
      chatService.leaveChat.mockRejectedValue(error);

      await chatController.leaveChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('setTypingStatus', () => {
    it('should set typing status successfully', async () => {
      req.params = { chatId: 'chat123' };
      req.body = { isTyping: true };

      await chatController.setTypingStatus(req, res, next);

      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('typing_status', {
          chatId: 'chat123',
          userId: '123',
          isTyping: true
        });
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Typing status updated'
      });
    });
  });

  describe('getUnreadCount', () => {
    it('should get unread count successfully', async () => {
      req.params = { chatId: 'chat123' };
      chatService.getUnreadCount.mockResolvedValue(5);

      await chatController.getUnreadCount(req, res, next);

      expect(chatService.getUnreadCount).toHaveBeenCalledWith('chat123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { count: 5 }
      });
    });
  });

  describe('markAsRead', () => {
    it('should mark chat as read successfully', async () => {
      req.params = { chatId: 'chat123' };

      chatService.markChatAsRead.mockResolvedValue();

      await chatController.markAsRead(req, res, next);

      expect(chatService.markChatAsRead).toHaveBeenCalledWith('chat123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Chat marked as read'
      });
    });
  });

  describe('toggleMute', () => {
    it('should toggle mute status successfully', async () => {
      const result = { muted: true };

      req.params = { chatId: 'chat123' };
      req.body = { mute: true };

      chatService.toggleMute.mockResolvedValue(result);

      await chatController.toggleMute(req, res, next);

      expect(chatService.toggleMute).toHaveBeenCalledWith('chat123', '123', true);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: result,
        message: 'Chat muted'
      });
    });
  });

  describe('toggleArchive', () => {
    it('should toggle archive status successfully', async () => {
      const result = { archived: true };

      req.params = { chatId: 'chat123' };
      req.body = { archive: true };

      chatService.toggleArchive.mockResolvedValue(result);

      await chatController.toggleArchive(req, res, next);

      expect(chatService.toggleArchive).toHaveBeenCalledWith('chat123', '123', true);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: result,
        message: 'Chat archived'
      });
    });
  });

  describe('getDirectChat', () => {
    it('should get or create direct chat successfully', async () => {
      const mockChat = {
        id: 'chat123',
        type: 'direct',
        members: ['123', '456']
      };

      req.params = { userId: '456' };
      chatService.getOrCreateDirectChat.mockResolvedValue(mockChat);

      await chatController.getDirectChat(req, res, next);

      expect(chatService.getOrCreateDirectChat).toHaveBeenCalledWith('123', '456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockChat
      });
    });

    it('should handle blocked user', async () => {
      const error = new Error('User is blocked');
      chatService.getOrCreateDirectChat.mockRejectedValue(error);

      await chatController.getDirectChat(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('generateInviteLink', () => {
    it('should generate invite link successfully', async () => {
      const inviteLink = {
        code: 'invite123',
        expiresAt: new Date(Date.now() + 86400000)
      };

      req.params = { chatId: 'chat123' };
      chatService.generateInviteLink.mockResolvedValue(inviteLink);

      await chatController.generateInviteLink(req, res, next);

      expect(chatService.generateInviteLink).toHaveBeenCalledWith('chat123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: inviteLink
      });
    });

    it('should handle non-group chat', async () => {
      const error = new Error('Only group chats can have invite links');
      chatService.generateInviteLink.mockRejectedValue(error);

      await chatController.generateInviteLink(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('joinWithInvite', () => {
    it('should join chat with invite successfully', async () => {
      const chat = {
        id: 'chat123',
        name: 'Test Group'
      };

      req.params = { inviteCode: 'invite123' };
      chatService.joinWithInvite.mockResolvedValue(chat);

      await chatController.joinWithInvite(req, res, next);

      expect(chatService.joinWithInvite).toHaveBeenCalledWith('invite123', '123');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('member_added', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: chat,
        message: 'Joined chat successfully'
      });
    });

    it('should handle expired invite', async () => {
      const error = new Error('Invite link has expired');
      chatService.joinWithInvite.mockRejectedValue(error);

      await chatController.joinWithInvite(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('pinMessage', () => {
    it('should pin message successfully', async () => {
      const pinnedMessage = {
        id: 'msg123',
        content: 'Important message',
        pinnedAt: new Date()
      };

      req.params = { chatId: 'chat123', messageId: 'msg123' };
      chatService.pinMessage.mockResolvedValue(pinnedMessage);

      await chatController.pinMessage(req, res, next);

      expect(chatService.pinMessage).toHaveBeenCalledWith('chat123', 'msg123', '123');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('chat_updated', expect.any(Object));
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: pinnedMessage,
        message: 'Message pinned'
      });
    });
  });

  describe('unpinMessage', () => {
    it('should unpin message successfully', async () => {
      req.params = { chatId: 'chat123', messageId: 'msg123' };
      chatService.unpinMessage.mockResolvedValue();

      await chatController.unpinMessage(req, res, next);

      expect(chatService.unpinMessage).toHaveBeenCalledWith('chat123', 'msg123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Message unpinned'
      });
    });
  });

  describe('getPinnedMessages', () => {
    it('should get pinned messages successfully', async () => {
      const pinnedMessages = [
        { id: 'msg1', content: 'Important 1' },
        { id: 'msg2', content: 'Important 2' }
      ];

      req.params = { chatId: 'chat123' };
      req.query = { page: '1', limit: '10' };

      chatService.getPinnedMessages.mockResolvedValue({
        messages: pinnedMessages,
        total: 2,
        page: 1,
        limit: 10
      });

      await chatController.getPinnedMessages(req, res, next);

      expect(chatService.getPinnedMessages).toHaveBeenCalledWith('chat123', '123', {
        page: 1,
        limit: 10
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          messages: pinnedMessages,
          pagination: {
            page: 1,
            limit: 10,
            total: 2,
            hasMore: false
          }
        }
      });
    });
  });
});