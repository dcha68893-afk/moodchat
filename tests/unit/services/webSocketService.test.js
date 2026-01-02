import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import WebSocket from 'ws';
import webSocketService from '../../../src/services/webSocketService';
import User from '../../../src/models/User';
import Chat from '../../../src/models/Chat';
import redisClient from '../../../src/config/redis';

jest.mock('../../../src/models/User');
jest.mock('../../../src/models/Chat');
jest.mock('../../../src/config/redis');
jest.mock('ws');

describe('WebSocket Service', () => {
  let mockWebSocket;
  let mockUser;
  let mockChat;

  beforeEach(() => {
    jest.clearAllMocks();

    mockWebSocket = {
      send: jest.fn(),
      close: jest.fn(),
      readyState: WebSocket.OPEN,
      on: jest.fn(),
    };

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
      status: 'online',
      lastSeen: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };

    mockChat = {
      _id: '507f1f77bcf86cd799439021',
      participants: [
        { user: '507f1f77bcf86cd799439011' },
        { user: '507f1f77bcf86cd799439012' },
      ],
    };

    // Reset singleton instance
    webSocketService.constructor();
  });

  describe('handleConnection', () => {
    it('should handle new connection successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const token = 'valid-token';

      User.findById.mockResolvedValue(mockUser);
      redisClient.set.mockResolvedValue('OK');
      redisClient.sadd.mockResolvedValue(1);

      await webSocketService.handleConnection(mockWebSocket, userId, token);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(redisClient.set).toHaveBeenCalledWith(`ws:${userId}`, expect.any(String));
      expect(redisClient.sadd).toHaveBeenCalledWith('online_users', userId);
      expect(mockUser.status).toBe('online');
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockWebSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'connection_established' })
      );
    });

    it('should reject invalid connection', async () => {
      const userId = 'nonexistent';
      const token = 'invalid-token';

      User.findById.mockResolvedValue(null);

      await webSocketService.handleConnection(mockWebSocket, userId, token);

      expect(mockWebSocket.close).toHaveBeenCalled();
    });

    it('should handle duplicate connection', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const token = 'valid-token';

      User.findById.mockResolvedValue(mockUser);
      redisClient.get.mockResolvedValue('existing-connection-id');

      await webSocketService.handleConnection(mockWebSocket, userId, token);

      expect(mockWebSocket.close).toHaveBeenCalled();
    });
  });

  describe('handleDisconnection', () => {
    it('should handle disconnection', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const connectionId = 'connection-123';

      redisClient.get.mockResolvedValue(connectionId);
      redisClient.del.mockResolvedValue(1);
      redisClient.srem.mockResolvedValue(1);
      User.findById.mockResolvedValue(mockUser);

      await webSocketService.handleDisconnection(userId);

      expect(redisClient.get).toHaveBeenCalledWith(`ws:${userId}`);
      expect(redisClient.del).toHaveBeenCalledWith(`ws:${userId}`);
      expect(redisClient.srem).toHaveBeenCalledWith('online_users', userId);
      expect(mockUser.status).toBe('offline');
      expect(mockUser.lastSeen).toBeDefined();
      expect(mockUser.save).toHaveBeenCalled();
    });
  });

  describe('sendToUser', () => {
    it('should send message to user', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const message = { type: 'notification', data: 'test' };
      const connectionId = 'connection-123';

      redisClient.get.mockResolvedValue(connectionId);

      // Mock WebSocketServer connections
      const mockConnection = {
        id: connectionId,
        ws: { send: jest.fn(), readyState: WebSocket.OPEN },
      };
      webSocketService.connections.set(connectionId, mockConnection);

      const result = await webSocketService.sendToUser(userId, message);

      expect(redisClient.get).toHaveBeenCalledWith(`ws:${userId}`);
      expect(mockConnection.ws.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(result.success).toBe(true);
    });

    it('should handle user not connected', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const message = { type: 'notification' };

      redisClient.get.mockResolvedValue(null);

      const result = await webSocketService.sendToUser(userId, message);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });

    it('should handle closed connection', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const message = { type: 'notification' };
      const connectionId = 'connection-123';

      redisClient.get.mockResolvedValue(connectionId);

      const mockConnection = {
        id: connectionId,
        ws: { send: jest.fn(), readyState: WebSocket.CLOSED },
      };
      webSocketService.connections.set(connectionId, mockConnection);

      const result = await webSocketService.sendToUser(userId, message);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });
  });

  describe('broadcastToChat', () => {
    it('should broadcast message to chat participants', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const message = { type: 'new_message', chatId };
      const excludeUserId = '507f1f77bcf86cd799439011';

      Chat.findById.mockResolvedValue(mockChat);
      redisClient.get.mockImplementation((key) => {
        if (key === 'ws:507f1f77bcf86cd799439012') return 'connection-456';
        return null;
      });

      const mockConnection = {
        id: 'connection-456',
        ws: { send: jest.fn(), readyState: WebSocket.OPEN },
      };
      webSocketService.connections.set('connection-456', mockConnection);

      const result = await webSocketService.broadcastToChat(chatId, message, excludeUserId);

      expect(Chat.findById).toHaveBeenCalledWith(chatId);
      expect(mockConnection.ws.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(result.success).toBe(true);
      expect(result.sentTo).toContain('507f1f77bcf86cd799439012');
    });

    it('should handle chat not found', async () => {
      const chatId = 'nonexistent';
      const message = { type: 'new_message' };

      Chat.findById.mockResolvedValue(null);

      const result = await webSocketService.broadcastToChat(chatId, message);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('notifyUser', () => {
    it('should send notification to user', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const notification = {
        type: 'friend_request',
        title: 'Friend Request',
        body: 'You have a new friend request',
      };

      const sendToUserSpy = jest.spyOn(webSocketService, 'sendToUser').mockResolvedValue({
        success: true,
      });

      const result = await webSocketService.notifyUser(userId, notification);

      expect(sendToUserSpy).toHaveBeenCalledWith(userId, {
        type: 'notification',
        data: notification,
      });
      expect(result.success).toBe(true);

      sendToUserSpy.mockRestore();
    });
  });

  describe('getOnlineUsers', () => {
    it('should get online users', async () => {
      const userIds = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];

      redisClient.smembers.mockResolvedValue(userIds);

      const result = await webSocketService.getOnlineUsers();

      expect(redisClient.smembers).toHaveBeenCalledWith('online_users');
      expect(result.success).toBe(true);
      expect(result.users).toEqual(userIds);
    });

    it('should check if specific user is online', async () => {
      const userId = '507f1f77bcf86cd799439011';

      redisClient.sismember.mockResolvedValue(1);

      const result = await webSocketService.getOnlineUsers(userId);

      expect(redisClient.sismember).toHaveBeenCalledWith('online_users', userId);
      expect(result.success).toBe(true);
      expect(result.isOnline).toBe(true);
    });
  });

  describe('updateUserStatus', () => {
    it('should update user status', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const status = 'away';
      const customStatus = 'In a meeting';

      User.findById.mockResolvedValue(mockUser);
      redisClient.publish.mockResolvedValue(1);

      const result = await webSocketService.updateUserStatus(userId, status, customStatus);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.status).toBe(status);
      expect(mockUser.customStatus).toBe(customStatus);
      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalledWith(
        'user_status',
        JSON.stringify({ userId, status, customStatus })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('handleTypingIndicator', () => {
    it('should broadcast typing indicator', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const isTyping = true;

      const broadcastSpy = jest.spyOn(webSocketService, 'broadcastToChat').mockResolvedValue({
        success: true,
        sentTo: ['507f1f77bcf86cd799439012'],
      });

      const result = await webSocketService.handleTypingIndicator(chatId, userId, isTyping);

      expect(broadcastSpy).toHaveBeenCalledWith(
        chatId,
        {
          type: 'typing_indicator',
          chatId,
          userId,
          isTyping,
          timestamp: expect.any(Date),
        },
        userId
      );
      expect(result.success).toBe(true);

      broadcastSpy.mockRestore();
    });
  });

  describe('handleMessageDelivery', () => {
    it('should notify message delivery', async () => {
      const messageId = '507f1f77bcf86cd799439031';
      const chatId = '507f1f77bcf86cd799439021';
      const senderId = '507f1f77bcf86cd799439011';
      const status = 'delivered';

      const broadcastSpy = jest.spyOn(webSocketService, 'broadcastToChat').mockResolvedValue({
        success: true,
        sentTo: ['507f1f77bcf86cd799439012'],
      });

      const result = await webSocketService.handleMessageDelivery(
        messageId,
        chatId,
        senderId,
        status
      );

      expect(broadcastSpy).toHaveBeenCalledWith(
        chatId,
        {
          type: 'message_status',
          messageId,
          chatId,
          senderId,
          status,
          timestamp: expect.any(Date),
        },
        senderId
      );
      expect(result.success).toBe(true);

      broadcastSpy.mockRestore();
    });
  });

  describe('handleCallNotification', () => {
    it('should notify about incoming call', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const chatId = '507f1f77bcf86cd799439021';
      const callerId = '507f1f77bcf86cd799439011';
      const callType = 'video';

      const broadcastSpy = jest.spyOn(webSocketService, 'broadcastToChat').mockResolvedValue({
        success: true,
        sentTo: ['507f1f77bcf86cd799439012'],
      });

      const result = await webSocketService.handleCallNotification(
        callId,
        chatId,
        callerId,
        callType
      );

      expect(broadcastSpy).toHaveBeenCalledWith(
        chatId,
        {
          type: 'incoming_call',
          callId,
          chatId,
          callerId,
          callType,
          timestamp: expect.any(Date),
        },
        callerId
      );
      expect(result.success).toBe(true);

      broadcastSpy.mockRestore();
    });
  });

  describe('cleanupStaleConnections', () => {
    it('should cleanup stale connections', async () => {
      const staleConnectionId = 'stale-connection';
      const activeConnectionId = 'active-connection';

      const staleConnection = {
        id: staleConnectionId,
        ws: { readyState: WebSocket.CLOSED, close: jest.fn() },
        userId: '507f1f77bcf86cd799439011',
        connectedAt: Date.now() - 3600000, // 1 hour ago
      };

      const activeConnection = {
        id: activeConnectionId,
        ws: { readyState: WebSocket.OPEN },
        userId: '507f1f77bcf86cd799439012',
        connectedAt: Date.now() - 60000, // 1 minute ago
      };

      webSocketService.connections.set(staleConnectionId, staleConnection);
      webSocketService.connections.set(activeConnectionId, activeConnection);

      redisClient.get.mockResolvedValue(staleConnectionId);

      const result = await webSocketService.cleanupStaleConnections();

      expect(staleConnection.ws.close).toHaveBeenCalled();
      expect(webSocketService.connections.has(staleConnectionId)).toBe(false);
      expect(webSocketService.connections.has(activeConnectionId)).toBe(true);
      expect(result.success).toBe(true);
      expect(result.cleanedUp).toBe(1);
    });
  });

  describe('getConnectionStats', () => {
    it('should get connection statistics', async () => {
      const connection1 = {
        id: 'conn1',
        userId: 'user1',
        connectedAt: Date.now() - 300000, // 5 minutes ago
        lastActivity: Date.now() - 60000, // 1 minute ago
      };

      const connection2 = {
        id: 'conn2',
        userId: 'user2',
        connectedAt: Date.now() - 600000, // 10 minutes ago
        lastActivity: Date.now() - 120000, // 2 minutes ago
      };

      webSocketService.connections.set('conn1', connection1);
      webSocketService.connections.set('conn2', connection2);
      redisClient.scard.mockResolvedValue(2);

      const result = await webSocketService.getConnectionStats();

      expect(result.success).toBe(true);
      expect(result.totalConnections).toBe(2);
      expect(result.onlineUsers).toBe(2);
      expect(result.connections).toHaveLength(2);
    });
  });
});