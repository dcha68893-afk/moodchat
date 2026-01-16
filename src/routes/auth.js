const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Public routes
router.post('/register', authLimiter, authValidation.register, authController.register);

router.post('/login', authLimiter, authValidation.login, authController.login);

router.post('/refresh-token', authValidation.refreshToken, async (req, res) => {
  try {
    const result = await authController.refreshToken(req.body);
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Token refresh failed'
    });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    const result = await authController.logout(req.user);
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Logout failed'
    });
  }
});

router.get('/verify-email', async (req, res) => {
  try {
    const result = await authController.verifyEmail(req.query);
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Email verification failed'
    });
  }
});

router.post('/request-password-reset', authLimiter, async (req, res) => {
  try {
    const result = await authController.requestPasswordReset(req.body);
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Password reset request failed'
    });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const result = await authController.resetPassword(req.body);
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Password reset failed'
    });
  }
});

router.get('/validate-token', async (req, res) => {
  try {
    const result = await authController.validateToken(req.query);
    res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Token validation failed'
    });
  }
});

// Protected routes
router.get('/me', authenticate, authController.getCurrentUser);

module.exports = router;