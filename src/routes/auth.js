const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Public routes
router.post('/register', authLimiter, authValidation.register, authController.register);

router.post('/login', authLimiter, authValidation.login, authController.login);

router.post('/refresh-token', authLimiter, authValidation.refreshToken, authController.refreshToken);

router.post('/logout', authenticate, authController.logout);

router.get('/verify-email', authController.verifyEmail);

router.post('/request-password-reset', authLimiter, authController.requestPasswordReset);

router.post('/reset-password', authController.resetPassword);

router.get('/validate-token', authController.validateToken);

// Protected routes
router.get('/me', authenticate, authController.getCurrentUser);

module.exports = router;