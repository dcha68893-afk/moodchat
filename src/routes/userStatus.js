const express = require('express');
const router = express.Router();
const userStatusController = require('../controllers/userStatusController');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Apply authentication to all routes
router.use(authenticate);

// Update user status
router.post('/update', apiRateLimiter, userStatusController.updateStatus);

// Get user status
router.get('/:userId', apiRateLimiter, userStatusController.getStatus);

// Get multiple users' statuses
router.post('/bulk', apiRateLimiter, userStatusController.getBulkStatus);

// Get user's status history
router.get('/:userId/history', apiRateLimiter, userStatusController.getStatusHistory);

// Set custom status
router.post('/custom', apiRateLimiter, userStatusController.setCustomStatus);

// Clear custom status
router.delete('/custom', apiRateLimiter, userStatusController.clearCustomStatus);

// Set auto-reply message
router.post('/auto-reply', apiRateLimiter, userStatusController.setAutoReply);

// Get online users count
router.get('/online/count', apiRateLimiter, userStatusController.getOnlineCount);

// Get users by status
router.get('/status/:status', apiRateLimiter, userStatusController.getUsersByStatus);

// Set do not disturb schedule
router.post('/dnd/schedule', apiRateLimiter, userStatusController.setDoNotDisturbSchedule);

// Get do not disturb status
router.get('/dnd/status', apiRateLimiter, userStatusController.getDoNotDisturbStatus);

// WebSocket endpoint for real-time status updates
router.post('/ws/status', apiRateLimiter, userStatusController.handleStatusWebSocket);

module.exports = router;