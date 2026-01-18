const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth'); // CHANGED from '../middlewares/auth'
const { authLimiter } = require('../middleware/rateLimiter'); // CHANGED from '../middlewares/rateLimiter'

// ========== AUTHENTICATION ROUTES ==========
// Register new user - rate limited
router.post('/register', authLimiter, authController.register);

// Login user - rate limited
router.post('/login', authLimiter, authController.login);

// Refresh access token - rate limited
router.post('/refresh-token', authLimiter, authController.refreshToken);

// Logout user - requires authentication
router.post('/logout', authenticate, authController.logout);

// Get current user profile - requires authentication
router.get('/me', authenticate, authController.getCurrentUser);

// ========== HEALTH CHECK ==========
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Auth service is healthy',
    timestamp: new Date().toISOString(),
    endpoints: {
      register: 'POST /api/auth/register',
      login: 'POST /api/auth/login',
      refreshToken: 'POST /api/auth/refresh-token',
      logout: 'POST /api/auth/logout',
      me: 'GET /api/auth/me',
      health: 'GET /api/auth/health'
    }
  });
});

// ========== DEVELOPMENT TEST ENDPOINTS ==========
if (process.env.NODE_ENV === 'development') {
  // Test registration endpoint (bypasses validation for testing)
  router.post('/test-register', (req, res) => {
    console.log('🧪 Test registration endpoint called with body:', req.body);
    
    // Simple test response
    res.json({
      success: true,
      message: 'Test registration endpoint is working',
      data: {
        received: req.body,
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
      }
    });
  });

  // Test authentication endpoint
  router.get('/test-auth', authenticate, (req, res) => {
    res.json({
      success: true,
      message: 'Authentication test successful',
      user: req.user,
      timestamp: new Date().toISOString()
    });
  });
}

// ========== COMPATIBILITY ROUTES (keep existing) ==========
// These routes are kept for backward compatibility with existing frontend code
router.post('/compat/register', authLimiter, authController.register);
router.post('/compat/login', authLimiter, authController.login);
router.get('/compat/profile', authenticate, authController.getCurrentUser);

console.log('✅ auths initialized with:', {
  register: 'POST /api/auth/register',
  login: 'POST /api/auth/login',
  refreshToken: 'POST /api/auth/refresh-token',
  logout: 'POST /api/auth/logout',
  me: 'GET /api/auth/me',
  health: 'GET /api/auth/health'
});

module.exports = router;