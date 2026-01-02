const { Op } = require('sequelize');
const { Server } = require('socket.io');
const config = require('../config');
const logger = require('../utils/logger');
const redisClient = require('../utils/redisClient');
const { socketAuthenticate } = require('../middleware/auth');

class WebSocketService {
  constructor() {
    this.io = null;
    this.userSockets = new Map(); // userId -> Set of socketIds
    this.socketUsers = new Map(); // socketId -> userId
  }

  initialize(server) {
    this.io = new Server(server, {
      cors: config.websocket.cors,
      pingInterval: config.websocket.pingInterval,
      pingTimeout: config.websocket.pingTimeout,
      transports: ['websocket', 'polling'],
    });

    // Authentication middleware
    this.io.use(socketAuthenticate);

    this.io.on('connection', socket => {
      this.handleConnection(socket);

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });

      socket.on('error', error => {
        this.handleError(socket, error);
      });

      // Register event handlers
      this.registerEventHandlers(socket);
    });

    logger.info('WebSocket server initialized');
  }

  handleConnection(socket) {
    const userId = socket.user.id;
    const socketId = socket.id;

    // Track user connection
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(socketId);
    this.socketUsers.set(socketId, userId);

    // Add user to online users set in Redis
    redisClient.sadd('online-users', userId.toString());

    // Update user status
    this.updateUserStatus(userId, 'online');

    // Notify friends about online status
    this.notifyStatusChangeToFriends(userId, 'online');

    // Send connection confirmation
    socket.emit('connected', {
      userId,
      socketId,
      timestamp: new Date().toISOString(),
    });

    logger.info(`User ${userId} connected (socket: ${socketId})`);
  }

  handleDisconnect(socket) {
    const socketId = socket.id;
    const userId = this.socketUsers.get(socketId);

    if (userId) {
      // Remove socket tracking
      const userSockets = this.userSockets.get(userId);
      if (userSockets) {
        userSockets.delete(socketId);
        if (userSockets.size === 0) {
          this.userSockets.delete(userId);

          // Remove user from online users after delay
          setTimeout(async () => {
            const currentSockets = this.userSockets.get(userId);
            if (!currentSockets || currentSockets.size === 0) {
              await redisClient.srem('online-users', userId.toString());
              this.updateUserStatus(userId, 'offline');
              this.notifyStatusChangeToFriends(userId, 'offline');
            }
          }, 5000); // 5 second delay
        }
      }
      this.socketUsers.delete(socketId);
    }

    logger.info(`User ${userId} disconnected (socket: ${socketId})`);
  }

  handleError(socket, error) {
    logger.error(`Socket error for user ${socket.user?.id}:`, error);
  }

  registerEventHandlers(socket) {
    // Typing indicators
    socket.on('typing_start', data => {
      this.handleTypingStart(socket, data);
    });

    socket.on('typing_end', data => {
      this.handleTypingEnd(socket, data);
    });

    // Message events
    socket.on('message_sent', data => {
      this.handleMessageSent(socket, data);
    });

    socket.on('message_read', data => {
      this.handleMessageRead(socket, data);
    });

    // Call events
    socket.on('call_offer', data => {
      this.handleCallOffer(socket, data);
    });

    socket.on('call_answer', data => {
      this.handleCallAnswer(socket, data);
    });

    socket.on('ice_candidate', data => {
      this.handleIceCandidate(socket, data);
    });

    // Presence
    socket.on('presence_update', data => {
      this.handlePresenceUpdate(socket, data);
    });

    // Subscribe to channels
    socket.on('subscribe', channels => {
      this.handleSubscribe(socket, channels);
    });

    socket.on('unsubscribe', channels => {
      this.handleUnsubscribe(socket, channels);
    });
  }

  async handleTypingStart(socket, data) {
    try {
      const { chatId } = data;
      const userId = socket.user.id;

      // Update typing indicator in database
      const typingService = require('./typingService');
      await typingService.startTyping(chatId, userId);

      // Notify other participants
      this.notifyTypingStart(chatId, userId);
    } catch (error) {
      logger.error('Handle typing start error:', error);
    }
  }

  async handleTypingEnd(socket, data) {
    try {
      const { chatId } = data;
      const userId = socket.user.id;

      // Update typing indicator in database
      const typingService = require('./typingService');
      await typingService.stopTyping(chatId, userId);

      // Notify other participants
      this.notifyTypingEnd(chatId, userId);
    } catch (error) {
      logger.error('Handle typing end error:', error);
    }
  }

  async handleMessageSent(socket, data) {
    try {
      const { chatId, messageId } = data;
      const userId = socket.user.id;

      // Mark message as delivered to other participants
      const messageService = require('./messageService');
      await messageService.markAsDelivered(messageId, userId);

      // Update unread counts for other participants
      this.updateUnreadCounts(chatId, userId);
    } catch (error) {
      logger.error('Handle message sent error:', error);
    }
  }

  async handleMessageRead(socket, data) {
    try {
      const { messageId } = data;
      const userId = socket.user.id;

      // Mark message as read
      const messageService = require('./messageService');
      await messageService.markAsRead(messageId, userId);
    } catch (error) {
      logger.error('Handle message read error:', error);
    }
  }

  handleCallOffer(socket, data) {
    const { callId, targetUserId, offer } = data;
    const userId = socket.user.id;

    // Forward offer to target user
    this.sendToUser(targetUserId, 'call_offer', {
      callId,
      fromUserId: userId,
      offer,
    });
  }

  handleCallAnswer(socket, data) {
    const { callId, targetUserId, answer } = data;
    const userId = socket.user.id;

    // Forward answer to target user
    this.sendToUser(targetUserId, 'call_answer', {
      callId,
      fromUserId: userId,
      answer,
    });
  }

  handleIceCandidate(socket, data) {
    const { callId, targetUserId, candidate } = data;
    const userId = socket.user.id;

    // Forward ICE candidate to target user
    this.sendToUser(targetUserId, 'ice_candidate', {
      callId,
      fromUserId: userId,
      candidate,
    });
  }

  async handlePresenceUpdate(socket, data) {
    try {
      const { status } = data;
      const userId = socket.user.id;

      // Update user status
      const userService = require('./userService');
      await userService.updateStatus(userId, status);

      // Notify friends
      this.notifyStatusChangeToFriends(userId, status);
    } catch (error) {
      logger.error('Handle presence update error:', error);
    }
  }

  handleSubscribe(socket, channels) {
    channels.forEach(channel => {
      socket.join(channel);
    });
  }

  handleUnsubscribe(socket, channels) {
    channels.forEach(channel => {
      socket.leave(channel);
    });
  }

  // Public notification methods
  notifyNewMessage(chatId, message) {
    this.io.to(`chat:${chatId}`).emit('new_message', {
      chatId,
      message,
    });
  }

  notifyMessageUpdate(chatId, event, data) {
    this.io.to(`chat:${chatId}`).emit('message_update', {
      event,
      chatId,
      ...data,
    });
  }

  notifyMessageDeleted(chatId, messageId) {
    this.io.to(`chat:${chatId}`).emit('message_deleted', {
      chatId,
      messageId,
    });
  }

  notifyChatUpdate(chatId, event, data) {
    this.io.to(`chat:${chatId}`).emit('chat_update', {
      event,
      chatId,
      ...data,
    });
  }

  notifyNewChat(userId, chatData) {
    this.sendToUser(userId, 'new_chat', chatData);
  }

  notifyFriendRequest(userId, requestData) {
    this.sendToUser(userId, 'friend_request', requestData);
  }

  notifyFriendRequestAccepted(userId, data) {
    this.sendToUser(userId, 'friend_request_accepted', data);
  }

  notifyUnfriend(userId, friendId) {
    this.sendToUser(userId, 'unfriend', { friendId });
  }

  notifyStatusChange(userId, friendId, status) {
    this.sendToUser(userId, 'friend_status_change', {
      friendId,
      status,
    });
  }

  notifyCallInitiated(userId, callData) {
    this.sendToUser(userId, 'call_initiated', callData);
  }

  notifyCallAnswered(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('call_answered', data);
  }

  notifyCallRejected(targetId, data) {
    if (typeof targetId === 'number') {
      this.sendToUser(targetId, 'call_rejected', data);
    } else {
      this.io.to(`chat:${targetId}`).emit('call_rejected', data);
    }
  }

  notifyCallCancelled(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('call_cancelled', data);
  }

  notifyCallEnded(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('call_ended', data);
  }

  notifyCallJoined(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('call_joined', data);
  }

  notifyCallLeft(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('call_left', data);
  }

  notifyCallMissed(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('call_missed', data);
  }

  forwardIceCandidate(chatId, data) {
    this.io.to(`chat:${chatId}`).emit('ice_candidate', data);
  }

  notifyMoodShared(userId, data) {
    this.sendToUser(userId, 'mood_shared', data);
  }

  notifyFriendMood(userId, data) {
    this.sendToUser(userId, 'friend_mood', data);
  }

  notifyTypingStart(chatId, userId) {
    this.io.to(`chat:${chatId}`).except(userId.toString()).emit('typing_start', {
      chatId,
      userId,
    });
  }

  notifyTypingEnd(chatId, userId) {
    this.io.to(`chat:${chatId}`).except(userId.toString()).emit('typing_end', {
      chatId,
      userId,
    });
  }

  notifyLeftChat(userId, chatId) {
    this.sendToUser(userId, 'left_chat', { chatId });
  }

  sendNotification(userId, notification) {
    this.sendToUser(userId, 'notification', notification);
  }

  // Utility methods
  sendToUser(userId, event, data) {
    const userSockets = this.userSockets.get(userId);
    if (userSockets) {
      userSockets.forEach(socketId => {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit(event, data);
        }
      });
    }
  }

  broadcastToRoom(room, event, data) {
    this.io.to(room).emit(event, data);
  }

  async updateUserStatus(userId, status) {
    try {
      const User = require('../models').User;
      await User.update({ status, lastSeen: new Date() }, { where: { id: userId } });
    } catch (error) {
      logger.error('Update user status error:', error);
    }
  }

  async notifyStatusChangeToFriends(userId, status) {
    try {
      const friendService = require('./friendService');
      const friends = await friendService.getFriends(userId);

      friends.forEach(friend => {
        this.notifyStatusChange(friend.id, userId, status);
      });
    } catch (error) {
      logger.error('Notify status change to friends error:', error);
    }
  }

  async updateUnreadCounts(chatId, excludedUserId) {
    try {
      // Get chat participants except sender
      const ChatParticipant = require('../models').ChatParticipant;
      const participants = await ChatParticipant.findAll({
        where: {
          chatId,
          userId: { [Op.ne]: excludedUserId },
        },
        attributes: ['userId'],
      });

      // Send updated unread counts
      participants.forEach(participant => {
        this.sendToUser(participant.userId, 'unread_count_update', { chatId });
      });
    } catch (error) {
      logger.error('Update unread counts error:', error);
    }
  }

  getOnlineUsers() {
    return Array.from(this.userSockets.keys());
  }

  isUserOnline(userId) {
    return this.userSockets.has(userId);
  }

  getUserSockets(userId) {
    return this.userSockets.get(userId) || new Set();
  }
}

module.exports = new WebSocketService();
