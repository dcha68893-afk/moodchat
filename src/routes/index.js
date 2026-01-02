const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('./auth');
const userRoutes = require('./users');
const friendRoutes = require('./friends');
const chatRoutes = require('./chats');
const messageRoutes = require('./messages');
const callRoutes = require('./calls');
const moodRoutes = require('./moods');
const mediaRoutes = require('./media');
const notificationRoutes = require('./notifications');

// Mount routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/friends', friendRoutes);
router.use('/chats', chatRoutes);
router.use('/messages', messageRoutes);
router.use('/calls', callRoutes);
router.use('/moods', moodRoutes);
router.use('/media', mediaRoutes);
router.use('/notifications', notificationRoutes);

// API info endpoint
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'MoodChat API v1',
    version: '1.0.0',
    documentation: '/api/docs',
    endpoints: {
      auth: '/api/auth',
      users: '/api/users',
      friends: '/api/friends',
      chats: '/api/chats',
      messages: '/api/messages',
      calls: '/api/calls',
      moods: '/api/moods',
      media: '/api/media',
      notifications: '/api/notifications',
    },
  });
});

module.exports = router;
