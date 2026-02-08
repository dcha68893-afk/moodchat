const express = require('express');
const router = express.Router();
const typingIndicatorController = require('../controllers/typingIndicatorController');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Apply authentication to all routes
router.use(authenticate);

// Start typing indicator
router.post('/start', apiRateLimiter, typingIndicatorController.startTyping);

// Stop typing indicator
router.post('/stop', apiRateLimiter, typingIndicatorController.stopTyping);

// Get typing status for a chat
router.get('/chat/:chatId', apiRateLimiter, typingIndicatorController.getTypingStatus);

// Get user's typing status across all chats
router.get('/user/:userId', apiRateLimiter, typingIndicatorController.getUserTypingStatus);

// Clear expired typing indicators (admin/internal)
router.delete('/cleanup', apiRateLimiter, typingIndicatorController.cleanupTypingIndicators);

// WebSocket endpoint for real-time typing updates
router.post('/ws/typing', apiRateLimiter, typingIndicatorController.handleTypingWebSocket);

module.exports = router;