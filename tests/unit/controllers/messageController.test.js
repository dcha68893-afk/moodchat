const messageController = require('../../../src/controllers/messageController');
const messageService = require('../../../src/services/messageService');
const { validationResult } = require('express-validator');

jest.mock('../../../src/services/messageService');
jest.mock('express-validator');

describe('Message Controller', () => {
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

  describe('sendMessage', () => {
    it('should send text message successfully', async () => {
      const mockMessage = {
        id: 'msg123',
        chatId: 'chat123',
        senderId: '123',
        content: 'Hello world',
        messageType: 'text'
      };

      req.body = {
        chatId: 'chat123',
        content: 'Hello world',
        messageType: 'text'
      };

      messageService.createMessage.mockResolvedValue(mockMessage);

      await messageController.sendMessage(req, res, next);

      expect(messageService.createMessage).toHaveBeenCalledWith({
        chatId: 'chat123',
        senderId: '123',
        content: 'Hello world',
        messageType: 'text'
      });
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('new_message', mockMessage);
      }
      
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockMessage,
        message: 'Message sent successfully'
      });
    });

    it('should send media message successfully', async () => {
      const mockMessage = {
        id: 'msg123',
        chatId: 'chat123',
        senderId: '123',
        messageType: 'image',
        mediaUrls: ['https://example.com/image.jpg']
      };

      req.body = {
        chatId: 'chat123',
        messageType: 'image',
        mediaUrls: ['https://example.com/image.jpg']
      };

      messageService.createMessage.mockResolvedValue(mockMessage);

      await messageController.sendMessage(req, res, next);

      expect(messageService.createMessage).toHaveBeenCalledWith({
        chatId: 'chat123',
        senderId: '123',
        content: undefined,
        messageType: 'image',
        mediaUrls: ['https://example.com/image.jpg']
      });
    });

    it('should handle validation errors', async () => {
      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'content', message: 'Content is required for text messages' }])
      });

      await messageController.sendMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle chat access denied', async () => {
      const error = new Error('Not authorized to send messages in this chat');
      error.code = 'CHAT_ACCESS_DENIED';

      messageService.createMessage.mockRejectedValue(error);

      await messageController.sendMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Not authorized to send messages in this chat',
        code: 'CHAT_ACCESS_DENIED'
      });
    });

    it('should handle empty content for text message', async () => {
      req.body = {
        chatId: 'chat123',
        messageType: 'text',
        content: ''
      };

      await messageController.sendMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Content is required for text messages'
      });
    });
  });

  describe('getChatMessages', () => {
    it('should get chat messages successfully', async () => {
      const messages = [
        { id: 'msg1', content: 'Message 1' },
        { id: 'msg2', content: 'Message 2' }
      ];

      req.params = { chatId: 'chat123' };
      req.query = { page: '1', limit: '50' };

      messageService.getMessagesByChatId.mockResolvedValue({
        messages,
        total: 2,
        hasMore: false
      });

      await messageController.getChatMessages(req, res, next);

      expect(messageService.getMessagesByChatId).toHaveBeenCalledWith(
        'chat123',
        { page: 1, limit: 50, before: undefined, after: undefined }
      );
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

    it('should verify chat access before fetching messages', async () => {
      const error = new Error('Not authorized to access this chat');
      messageService.verifyChatAccess.mockResolvedValue(false);

      await messageController.getChatMessages(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should handle pagination with before parameter', async () => {
      req.params = { chatId: 'chat123' };
      req.query = { before: '2023-01-01T00:00:00.000Z' };

      messageService.getMessagesByChatId.mockResolvedValue({
        messages: [],
        total: 0,
        hasMore: false
      });

      await messageController.getChatMessages(req, res, next);

      expect(messageService.getMessagesByChatId).toHaveBeenCalledWith(
        'chat123',
        expect.objectContaining({
          before: '2023-01-01T00:00:00.000Z'
        })
      );
    });
  });

  describe('editMessage', () => {
    it('should edit message successfully', async () => {
      const updatedMessage = {
        id: 'msg123',
        content: 'Edited content',
        isEdited: true,
        editedAt: expect.any(Date)
      };

      req.params = { messageId: 'msg123' };
      req.body = { content: 'Edited content' };

      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '123',
        chatId: 'chat123'
      });
      messageService.canEditMessage.mockResolvedValue(true);
      messageService.updateMessage.mockResolvedValue(updatedMessage);

      await messageController.editMessage(req, res, next);

      expect(messageService.getMessageById).toHaveBeenCalledWith('msg123');
      expect(messageService.canEditMessage).toHaveBeenCalledWith('msg123');
      expect(messageService.updateMessage).toHaveBeenCalledWith('msg123', {
        content: 'Edited content',
        editedAt: expect.any(Date),
        isEdited: true
      });
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('message_updated', updatedMessage);
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedMessage,
        message: 'Message updated successfully'
      });
    });

    it('should handle message not found', async () => {
      messageService.getMessageById.mockResolvedValue(null);

      await messageController.editMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Message not found'
      });
    });

    it('should handle unauthorized edit attempt', async () => {
      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '456' // Different user
      });

      await messageController.editMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Not authorized to edit this message'
      });
    });

    it('should handle non-editable message', async () => {
      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '123'
      });
      messageService.canEditMessage.mockResolvedValue(false);

      await messageController.editMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Message cannot be edited after 15 minutes'
      });
    });
  });

  describe('deleteMessage', () => {
    it('should delete message successfully (sender)', async () => {
      const deletedMessage = {
        id: 'msg123',
        chatId: 'chat123',
        isDeleted: true
      };

      req.params = { messageId: 'msg123' };

      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '123',
        chatId: 'chat123'
      });
      messageService.deleteMessage.mockResolvedValue(deletedMessage);

      await messageController.deleteMessage(req, res, next);

      expect(messageService.deleteMessage).toHaveBeenCalledWith('msg123', {
        deletedBy: '123',
        deleteType: 'sender'
      });
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('message_deleted', {
          messageId: 'msg123',
          chatId: 'chat123'
        });
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: deletedMessage,
        message: 'Message deleted successfully'
      });
    });

    it('should delete message successfully (admin)', async () => {
      req.user.role = 'admin';

      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '456',
        chatId: 'chat123'
      });
      messageService.deleteMessage.mockResolvedValue({});

      await messageController.deleteMessage(req, res, next);

      expect(messageService.deleteMessage).toHaveBeenCalledWith('msg123', {
        deletedBy: '123',
        deleteType: 'admin'
      });
    });

    it('should handle unauthorized deletion', async () => {
      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '456' // Different user
      });
      req.user.role = 'user'; // Not admin

      await messageController.deleteMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('getMessage', () => {
    it('should get message by ID successfully', async () => {
      const message = {
        id: 'msg123',
        content: 'Test message',
        senderId: '123',
        chatId: 'chat123'
      };

      req.params = { messageId: 'msg123' };

      messageService.getMessageById.mockResolvedValue(message);
      messageService.canAccessMessage.mockResolvedValue(true);

      await messageController.getMessage(req, res, next);

      expect(messageService.getMessageById).toHaveBeenCalledWith('msg123');
      expect(messageService.canAccessMessage).toHaveBeenCalledWith(message, '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: message
      });
    });

    it('should handle message access denied', async () => {
      const message = {
        id: 'msg123',
        chatId: 'chat123'
      };

      messageService.getMessageById.mockResolvedValue(message);
      messageService.canAccessMessage.mockResolvedValue(false);

      await messageController.getMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('markAsRead', () => {
    it('should mark message as read successfully', async () => {
      const updatedMessage = {
        id: 'msg123',
        chatId: 'chat123',
        readBy: ['123']
      };

      req.params = { messageId: 'msg123' };

      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        chatId: 'chat123'
      });
      messageService.verifyChatAccess.mockResolvedValue(true);
      messageService.markMessageAsRead.mockResolvedValue(updatedMessage);

      await messageController.markAsRead(req, res, next);

      expect(messageService.markMessageAsRead).toHaveBeenCalledWith('msg123', '123');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('message_read', {
          messageId: 'msg123',
          chatId: 'chat123',
          readBy: '123'
        });
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedMessage,
        message: 'Message marked as read'
      });
    });

    it('should handle already read message', async () => {
      const message = {
        id: 'msg123',
        readBy: ['123']
      };

      messageService.getMessageById.mockResolvedValue(message);

      await messageController.markAsRead(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: message,
        message: 'Message is already read'
      });
    });
  });

  describe('reactToMessage', () => {
    it('should add reaction successfully', async () => {
      const updatedMessage = {
        id: 'msg123',
        chatId: 'chat123',
        reactions: [{ userId: '123', reaction: '👍' }]
      };

      req.params = { messageId: 'msg123' };
      req.body = { reaction: '👍' };

      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        chatId: 'chat123'
      });
      messageService.verifyChatAccess.mockResolvedValue(true);
      messageService.addReaction.mockResolvedValue(updatedMessage);

      await messageController.reactToMessage(req, res, next);

      expect(messageService.addReaction).toHaveBeenCalledWith('msg123', '123', '👍');
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('message_reaction', {
          messageId: 'msg123',
          chatId: 'chat123',
          reaction: '👍',
          userId: '123'
        });
      }
      
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedMessage,
        message: 'Reaction added successfully'
      });
    });

    it('should handle invalid reaction', async () => {
      req.body = { reaction: 'invalid-emoji' };

      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'reaction', message: 'Invalid reaction' }])
      });

      await messageController.reactToMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('removeReaction', () => {
    it('should remove reaction successfully', async () => {
      req.params = { messageId: 'msg123' };

      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        chatId: 'chat123'
      });
      messageService.verifyChatAccess.mockResolvedValue(true);
      messageService.removeReaction.mockResolvedValue();

      await messageController.removeReaction(req, res, next);

      expect(messageService.removeReaction).toHaveBeenCalledWith('msg123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Reaction removed successfully'
      });
    });
  });

  describe('getMessageReactions', () => {
    it('should get message reactions successfully', async () => {
      const reactions = [
        { userId: '123', reaction: '👍' },
        { userId: '456', reaction: '❤️' }
      ];

      req.params = { messageId: 'msg123' };

      messageService.getMessageReactions.mockResolvedValue(reactions);

      await messageController.getMessageReactions(req, res, next);

      expect(messageService.getMessageReactions).toHaveBeenCalledWith('msg123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: reactions
      });
    });
  });

  describe('replyToMessage', () => {
    it('should reply to message successfully', async () => {
      const replyMessage = {
        id: 'msg456',
        chatId: 'chat123',
        content: 'Reply message',
        replyTo: 'msg123'
      };

      req.params = { messageId: 'msg123' };
      req.body = { content: 'Reply message' };

      messageService.replyToMessage.mockResolvedValue(replyMessage);

      await messageController.replyToMessage(req, res, next);

      expect(messageService.replyToMessage).toHaveBeenCalledWith(
        'msg123',
        '123',
        { content: 'Reply message' }
      );
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat123');
        expect(req.io.emit).toHaveBeenCalledWith('new_message', replyMessage);
      }
      
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: replyMessage,
        message: 'Reply sent successfully'
      });
    });
  });

  describe('getMessageReplies', () => {
    it('should get message replies successfully', async () => {
      const replies = [
        { id: 'msg1', content: 'Reply 1' },
        { id: 'msg2', content: 'Reply 2' }
      ];

      req.params = { messageId: 'msg123' };
      req.query = { page: '1', limit: '10' };

      messageService.getMessageReplies.mockResolvedValue({
        replies,
        total: 2,
        page: 1,
        limit: 10
      });

      await messageController.getMessageReplies(req, res, next);

      expect(messageService.getMessageReplies).toHaveBeenCalledWith('msg123', {
        page: 1,
        limit: 10
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          replies,
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

  describe('forwardMessage', () => {
    it('should forward message successfully', async () => {
      const forwardedMessages = [
        { id: 'msg456', chatId: 'chat789' },
        { id: 'msg789', chatId: 'chat012' }
      ];

      req.params = { messageId: 'msg123' };
      req.body = { chatIds: ['chat789', 'chat012'] };

      messageService.forwardMessage.mockResolvedValue(forwardedMessages);

      await messageController.forwardMessage(req, res, next);

      expect(messageService.forwardMessage).toHaveBeenCalledWith(
        'msg123',
        '123',
        ['chat789', 'chat012']
      );
      
      if (req.io) {
        expect(req.io.to).toHaveBeenCalledWith('chat789');
        expect(req.io.to).toHaveBeenCalledWith('chat012');
        expect(req.io.emit).toHaveBeenCalledWith('new_message', expect.any(Object));
      }
      
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: forwardedMessages,
        message: 'Message forwarded successfully'
      });
    });

    it('should handle invalid chat IDs', async () => {
      req.body = { chatIds: [] };

      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'chatIds', message: 'At least one chat is required' }])
      });

      await messageController.forwardMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('saveMessage', () => {
    it('should save message successfully', async () => {
      req.params = { messageId: 'msg123' };

      messageService.saveMessage.mockResolvedValue();

      await messageController.saveMessage(req, res, next);

      expect(messageService.saveMessage).toHaveBeenCalledWith('msg123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Message saved successfully'
      });
    });

    it('should handle already saved message', async () => {
      const error = new Error('Message already saved');
      messageService.saveMessage.mockRejectedValue(error);

      await messageController.saveMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('unsaveMessage', () => {
    it('should unsave message successfully', async () => {
      req.params = { messageId: 'msg123' };

      messageService.unsaveMessage.mockResolvedValue();

      await messageController.unsaveMessage(req, res, next);

      expect(messageService.unsaveMessage).toHaveBeenCalledWith('msg123', '123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Message unsaved successfully'
      });
    });
  });

  describe('getSavedMessages', () => {
    it('should get saved messages successfully', async () => {
      const savedMessages = [
        { id: 'msg1', content: 'Saved 1' },
        { id: 'msg2', content: 'Saved 2' }
      ];

      req.query = { page: '1', limit: '20' };

      messageService.getSavedMessages.mockResolvedValue({
        messages: savedMessages,
        total: 2,
        page: 1,
        limit: 20
      });

      await messageController.getSavedMessages(req, res, next);

      expect(messageService.getSavedMessages).toHaveBeenCalledWith('123', {
        page: 1,
        limit: 20
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          messages: savedMessages,
          pagination: {
            page: 1,
            limit: 20,
            total: 2,
            hasMore: false
          }
        }
      });
    });
  });

  describe('searchMessages', () => {
    it('should search messages successfully', async () => {
      const searchResults = [
        { id: 'msg1', content: 'Hello world' },
        { id: 'msg2', content: 'Hello there' }
      ];

      req.body = { query: 'hello', chatId: 'chat123' };

      messageService.searchMessages.mockResolvedValue(searchResults);

      await messageController.searchMessages(req, res, next);

      expect(messageService.searchMessages).toHaveBeenCalledWith('chat123', 'hello');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: searchResults,
        count: searchResults.length
      });
    });

    it('should handle empty search query', async () => {
      req.body = { query: '', chatId: 'chat123' };

      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'query', message: 'Search query is required' }])
      });

      await messageController.searchMessages(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle short search query', async () => {
      req.body = { query: 'a', chatId: 'chat123' };

      await messageController.searchMessages(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    });
  });

  describe('getChatMedia', () => {
    it('should get chat media successfully', async () => {
      const media = [
        { id: 'media1', type: 'image', url: 'https://example.com/image.jpg' },
        { id: 'media2', type: 'video', url: 'https://example.com/video.mp4' }
      ];

      req.params = { chatId: 'chat123' };
      req.query = { type: 'image', page: '1', limit: '20' };

      messageService.getChatMedia.mockResolvedValue({
        media,
        total: 2,
        page: 1,
        limit: 20
      });

      await messageController.getChatMedia(req, res, next);

      expect(messageService.getChatMedia).toHaveBeenCalledWith('chat123', {
        type: 'image',
        page: 1,
        limit: 20
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          media,
          summary: expect.any(Object),
          pagination: {
            page: 1,
            limit: 20,
            total: 2,
            hasMore: false,
            totalPages: expect.any(Number)
          }
        }
      });
    });

    it('should verify chat access before fetching media', async () => {
      const error = new Error('Not authorized to access this chat');
      messageService.verifyChatAccess.mockResolvedValue(false);

      await messageController.getChatMedia(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('getChatFiles', () => {
    it('should get chat files successfully', async () => {
      const files = [
        { id: 'file1', name: 'document.pdf' },
        { id: 'file2', name: 'spreadsheet.xlsx' }
      ];

      req.params = { chatId: 'chat123' };

      messageService.getChatFiles.mockResolvedValue(files);

      await messageController.getChatFiles(req, res, next);

      expect(messageService.getChatFiles).toHaveBeenCalledWith('chat123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: files
      });
    });
  });

  describe('reportMessage', () => {
    it('should report message successfully', async () => {
      req.params = { messageId: 'msg123' };
      req.body = {
        reason: 'Spam',
        details: 'This message is spam'
      };

      messageService.reportMessage.mockResolvedValue();

      await messageController.reportMessage(req, res, next);

      expect(messageService.reportMessage).toHaveBeenCalledWith('msg123', '123', {
        reason: 'Spam',
        details: 'This message is spam'
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Message reported successfully'
      });
    });

    it('should handle self-report', async () => {
      messageService.getMessageById.mockResolvedValue({
        id: 'msg123',
        senderId: '123' // Same as reporter
      });

      await messageController.reportMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot report your own message'
      });
    });

    it('should handle already reported message', async () => {
      const error = new Error('Message already reported');
      messageService.reportMessage.mockRejectedValue(error);

      await messageController.reportMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});