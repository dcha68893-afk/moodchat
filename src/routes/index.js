// src/routes/index.js - FIXED VERSION
const express = require('express');
const router = express.Router();

// Import all route modules
const authRoutes = require('./auth');
const userRoutes = require('./users');
const friendRoutes = require('./friends');
const chatRoutes = require('./chats');
const messageRoutes = require('./messages');
const callRoutes = require('./calls');
const moodRoutes = require('./moods');
const mediaRoutes = require('./media');
const notificationRoutes = require('./notifications');
const statusRoutes = require('./status');
const testRoutes = require('./test');

// Import middleware
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Apply global middleware to all routes
router.use(apiRateLimiter);

// Mount routes with their respective paths
router.use('/auth', authRoutes);
router.use('/users', authenticate, userRoutes);
router.use('/friends', authenticate, friendRoutes);
router.use('/chats', authenticate, chatRoutes);
router.use('/messages', authenticate, messageRoutes);
router.use('/calls', authenticate, callRoutes);
router.use('/moods', authenticate, moodRoutes);
router.use('/media', authenticate, mediaRoutes);
router.use('/notifications', authenticate, notificationRoutes);
router.use('/status', authenticate, statusRoutes);

// Test routes (development only)
if (process.env.NODE_ENV === 'development') {
  router.use('/test', testRoutes);
  console.log('✅ Test routes enabled for development');
}

// Health check endpoint (no auth required)
router.get('/health', (req, res) => {
  const dbStatus = req.app.locals.dbConnected ? 'connected' : 'disconnected';
  const memoryUsers = req.app.locals.users ? req.app.locals.users.length : 0;
  
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: dbStatus,
    memoryUsers: memoryUsers,
    service: 'moodchat-api',
    version: '1.0.0'
  });
});

// Main API documentation endpoint
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'MoodChat API v1',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    documentation: '/api/docs',
    authenticationRequired: {
      users: true,
      friends: true,
      chats: true,
      messages: true,
      calls: true,
      moods: true,
      media: true,
      notifications: true,
      status: true
    },
    endpoints: {
      health: 'GET /api/health',
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout',
        refreshToken: 'POST /api/auth/refresh-token',
        profile: 'GET /api/auth/me',
        health: 'GET /api/auth/health'
      },
      users: {
        getAll: 'GET /api/users',
        getProfile: 'GET /api/users/profile',
        updateProfile: 'PUT /api/users/profile',
        search: 'GET /api/users/search?query=',
        getUser: 'GET /api/users/:id',
        updateStatus: 'PUT /api/users/status',
        getSettings: 'GET /api/users/settings',
        updateSettings: 'PUT /api/users/settings',
        changePassword: 'PUT /api/users/password',
        updateAvatar: 'PUT /api/users/avatar',
        deactivate: 'DELETE /api/users/deactivate'
      },
      friends: 'GET /api/friends',
      chats: {
        rooms: 'GET /api/chats/rooms',
        createRoom: 'POST /api/chats/rooms',
        roomMessages: 'GET /api/chats/rooms/:roomId/messages'
      },
      messages: {
        send: 'POST /api/messages',
        getConversation: 'GET /api/messages/conversation/:userId',
        deleteMessage: 'DELETE /api/messages/:id'
      },
      calls: {
        start: 'POST /api/calls',
        join: 'POST /api/calls/:callId/join',
        end: 'POST /api/calls/:callId/end'
      },
      moods: {
        track: 'POST /api/moods',
        history: 'GET /api/moods/history',
        analytics: 'GET /api/moods/analytics'
      },
      media: {
        upload: 'POST /api/media/upload',
        getMedia: 'GET /api/media/:id'
      },
      notifications: {
        getAll: 'GET /api/notifications',
        markRead: 'PUT /api/notifications/:id/read',
        markAllRead: 'PUT /api/notifications/read-all',
        delete: 'DELETE /api/notifications/:id'
      },
      status: {
        get: 'GET /api/status/me',
        update: 'PUT /api/status/me',
        friends: 'GET /api/status/friends'
      }
    },
    statusCodes: {
      200: 'Success',
      201: 'Created',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      429: 'Too Many Requests',
      500: 'Internal Server Error'
    }
  });
});

// API documentation endpoint (if you have documentation)
router.get('/docs', (req, res) => {
  res.json({
    success: true,
    message: 'API Documentation',
    timestamp: new Date().toISOString(),
    quickStart: {
      registration: {
        method: 'POST',
        endpoint: '/api/auth/register',
        body: {
          username: 'string (required)',
          email: 'string (required)',
          password: 'string (required)',
          firstName: 'string (optional)',
          lastName: 'string (optional)'
        }
      },
      authentication: {
        login: {
          method: 'POST',
          endpoint: '/api/auth/login',
          body: {
            identifier: 'string (email or username)',
            password: 'string'
          }
        },
        profile: {
          method: 'GET',
          endpoint: '/api/auth/me',
          headers: {
            'Authorization': 'Bearer <token>'
          }
        }
      }
    },
    authentication: 'All protected endpoints require JWT token in Authorization header: Bearer <token>',
    rateLimiting: 'API is rate limited. Check response headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    support: {
      email: 'support@moodchat.com',
      documentation: 'https://docs.moodchat.com/api'
    }
  });
});

// 404 handler for API routes that don't exist
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
    suggestion: 'Check the /api endpoint for available routes'
  });
});

// Error handling middleware for this router
router.use((err, req, res, next) => {
  console.error('API Route Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

console.log('✅ Main API routes initialized with proper router');

module.exports = router;