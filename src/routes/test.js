const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { User, sequelize } = require('../models');

console.log('✅ Test routes initialized');

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

// Test user creation
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

// Simple test endpoint
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Test route working',
    timestamp: new Date().toISOString(),
    endpoints: {
      db: 'GET /test/db',
      users: 'GET /test/users',
      env: 'GET /test/env'
    }
  });
});

module.exports = router;