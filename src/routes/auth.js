
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Public routes
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/refresh-token', authLimiter, authController.refreshToken);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Auth service is healthy',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint (for development only)
if (process.env.NODE_ENV === 'development') {
  router.post('/test-register', (req, res) => {
    console.log('🧪 Test registration endpoint called');
    res.json({
      success: true,
      message: 'Test endpoint is working',
      data: req.body
    });
  });
}

console.log('✅ Auth routes initialized');

module.exports = router;
