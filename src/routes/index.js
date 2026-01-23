// src/routes/index.js - MAIN ROUTER AGGREGATION (NO MODELS)
const express = require('express');
const router = express.Router();

console.log('🔄 Loading and mounting all application routers...');

// ===== EXPLICIT ROUTER IMPORTS =====
try {
  const authRouter = require('./auth');
  router.use('/auth', authRouter);
  console.log('✅ Mounted: /auth');
} catch (error) {
  console.error('❌ Failed to load auth router:', error.message);
  console.error('❌ Authentication features will be unavailable');
}

try {
  const callsRouter = require('./calls');
  router.use('/calls', callsRouter);
  console.log('✅ Mounted: /calls');
} catch (error) {
  console.error('❌ Failed to load calls router:', error.message);
  console.error('❌ Call features will be unavailable');
}

try {
  const chatsRouter = require('./chats');
  router.use('/chats', chatsRouter);
  console.log('✅ Mounted: /chats');
} catch (error) {
  console.error('❌ Failed to load chats router:', error.message);
  console.error('❌ Chat features will be unavailable');
}

try {
  const friendsRouter = require('./friends');
  router.use('/friends', friendsRouter);
  console.log('✅ Mounted: /friends');
} catch (error) {
  console.error('❌ Failed to load friends router:', error.message);
  console.error('❌ Friend features will be unavailable');
}

try {
  const groupRouter = require('./group');
  router.use('/groups', groupRouter);
  console.log('✅ Mounted: /groups');
} catch (error) {
  console.error('❌ Failed to load group router:', error.message);
  console.error('❌ Group features will be unavailable');
}

// ===== ROOT HEALTH CHECK =====
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'API Server is running',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    routes: {
      auth: '/auth',
      calls: '/calls',
      chats: '/chats',
      friends: '/friends',
      groups: '/groups'
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// ===== 404 HANDLER FOR UNKNOWN ROUTES =====
router.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
    availableRoutes: {
      auth: '/auth',
      calls: '/calls',
      chats: '/chats',
      friends: '/friends',
      groups: '/groups'
    }
  });
});

console.log('✅ All routers mounted successfully');
console.log('✅ Main router aggregation complete');

// CRITICAL: Export router only
module.exports = router;