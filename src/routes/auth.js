const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Public routes
router.post('/register', authLimiter, authValidation.register, (req, res) => {
  try {
    const result = authController.register(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || 'Registration failed'
    });
  }
});

router.post('/login', authLimiter, authValidation.login, (req, res) => {
  try {
    const result = authController.login(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || 'Login failed'
    });
  }
});

router.post('/refresh-token', authValidation.refreshToken, (req, res) => {
  try {
    const result = authController.refreshToken(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || 'Token refresh failed'
    });
  }
});

router.post('/logout', (req, res) => {
  try {
    const result = authController.logout(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || 'Logout failed'
    });
  }
});

router.get('/verify-email', (req, res) => {
  try {
    const result = authController.verifyEmail(req.query);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || 'Email verification failed'
    });
  }
});

router.post('/request-password-reset', authLimiter, (req, res) => {
  try {
    const result = authController.requestPasswordReset(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || 'Password reset request failed'
    });
  }
});

router.post('/reset-password', (req, res) => {
  try {
    const result = authController.resetPassword(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || 'Password reset failed'
    });
  }
});

router.get('/validate-token', (req, res) => {
  try {
    const result = authController.validateToken(req.query);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || 'Token validation failed'
    });
  }
});

// Protected routes
router.get('/me', authenticate, (req, res) => {
  try {
    const result = authController.getCurrentUser(req.user);
    res.json(result);
  } catch (error) {
    res.status(error.status || 401).json({
      error: error.message || 'Failed to fetch user data'
    });
  }
});

module.exports = router;