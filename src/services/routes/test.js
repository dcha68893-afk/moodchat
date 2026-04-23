const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { User, sequelize } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { Op } = require('sequelize');
const Message = require('../models').Message || require('../models').Messages;
const Chat = require('../models').Chat || require('../models').Chats;

console.log('[Test Route] initialized');

// Harden test endpoints: disable in production and require auth elsewhere.
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  return next();
});

router.use(authenticateToken);

// Simple test DB endpoint
router.get('/db', asyncHandler(async (req, res) => {
  try {
    const [result] = await sequelize.query('SELECT NOW() as current_time, version() as db_version');
    res.json({
      success: true,
      data: result[0],
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Test DB error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
}));

// Test user listing
router.get('/users', asyncHandler(async (req, res) => {
  try {
    const users = await User.findAll({
      limit: 10,
      attributes: ['id', 'username', 'email', 'createdAt']
    });

    res.json({
      success: true,
      data: {
        count: users.length,
        users: users
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Test users error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
}));

// Test environment
router.get('/env', (req, res) => {
  res.json({
    success: true,
    data: {
      nodeEnv: process.env.NODE_ENV,
      port: process.env.PORT,
      redisEnabled: process.env.REDIS_ENABLED,
      dbHost: process.env.DB_HOST ? 'Set' : 'Not set',
      jwtSecret: process.env.JWT_SECRET ? 'Set' : 'Not set'
    },
    timestamp: new Date().toISOString()
  });
});

// Test real-time messaging between users
router.post('/messaging-test', asyncHandler(async (req, res) => {
  try {
    const { senderEmail, receiverEmail, message } = req.body;
    
    if (!senderEmail || !receiverEmail || !message) {
      return res.status(400).json({
        success: false,
        error: 'senderEmail, receiverEmail, and message are required'
      });
    }
    
    // Find users
    const [sender, receiver] = await Promise.all([
      User.findOne({ where: { email: senderEmail } }),
      User.findOne({ where: { email: receiverEmail } })
    ]);
    
    if (!sender || !receiver) {
      return res.status(404).json({
        success: false,
        error: 'One or both users not found'
      });
    }
    
    // Find or create chat
    let chat = await Chat.findOne({
      where: {
        type: 'private',
        [Op.or]: [
          { user1Id: sender.id, user2Id: receiver.id },
          { user1Id: receiver.id, user2Id: sender.id }
        ]
      }
    });
    
    if (!chat) {
      chat = await Chat.create({
        type: 'private',
        user1Id: sender.id,
        user2Id: receiver.id,
        lastMessage: message,
        lastMessageTime: new Date()
      });
    }
    
    // Create message
    const newMessage = await Message.create({
      chatId: chat.id,
      senderId: sender.id,
      receiverId: receiver.id,
      content: message,
      type: 'text',
      status: 'sent',
      timestamp: new Date()
    });
    
    // Update chat
    await chat.update({
      lastMessage: message,
      lastMessageTime: new Date()
    });
    
    // Get WebSocket service to emit real-time event
    try {
      const wsService = require('../services/webSocketService');
      if (wsService && wsService.sendToUser) {
        // Send to receiver
        await wsService.sendToUser(receiver.id, 'message:received', {
          id: newMessage.id,
          chatId: chat.id,
          sender: {
            id: sender.id,
            email: sender.email,
            username: sender.username
          },
          content: message,
          type: 'text',
          timestamp: newMessage.timestamp
        });
        
        // Send confirmation to sender
        await wsService.sendToUser(sender.id, 'message:sent', {
          id: newMessage.id,
          chatId: chat.id,
          receiver: {
            id: receiver.id,
            email: receiver.email,
            username: receiver.username
          },
          content: message,
          type: 'text',
          timestamp: newMessage.timestamp
        });
        
        console.log(`✅ Real-time message sent from ${senderEmail} to ${receiverEmail}`);
      }
    } catch (wsError) {
      console.warn('WebSocket service not available:', wsError.message);
    }
    
    res.json({
      success: true,
      data: {
        messageId: newMessage.id,
        chatId: chat.id,
        sender: { id: sender.id, email: sender.email },
        receiver: { id: receiver.id, email: receiver.email },
        message: message,
        timestamp: newMessage.timestamp
      }
    });
    
  } catch (error) {
    console.error('Messaging test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}));

// Get recent messages for testing
router.get('/messages/:chatId', asyncHandler(async (req, res) => {
  try {
    const { chatId } = req.params;
    
    const messages = await Message.findAll({
      where: { chatId },
      order: [['timestamp', 'DESC']],
      limit: 10
    });
    
    res.json({
      success: true,
      data: {
        messages: messages,
        count: messages.length
      }
    });
    
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}));

// Simple test endpoint
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Test route working',
    timestamp: new Date().toISOString(),
    endpoints: {
      db: 'GET /test/db',
      users: 'GET /test/users',
      env: 'GET /test/env',
      'messaging-test': 'POST /test/messaging-test',
      'messages': 'GET /test/messages/:chatId'
    }
  });
});

module.exports = router;
