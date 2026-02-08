
const express = require('express');
const router = express.Router();
const readReceiptController = require('../controllers/readReceiptController');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Apply authentication to all routes
router.use(authenticate);

// Mark message as read
router.post('/mark-read', apiRateLimiter, readReceiptController.markAsRead);

// Mark multiple messages as read
router.post('/mark-read-bulk', apiRateLimiter, readReceiptController.markMultipleAsRead);

// Get read status of a message
router.get('/message/:messageId', apiRateLimiter, readReceiptController.getMessageReadStatus);

// Get unread messages count
router.get('/unread/count', apiRateLimiter, readReceiptController.getUnreadCount);

// Get chat read status
router.get('/chat/:chatId', apiRateLimiter, readReceiptController.getChatReadStatus);

// Get user's read receipts
router.get('/user/receipts', apiRateLimiter, readReceiptController.getUserReceipts);

// Mark all messages as read in a chat
router.post('/chat/:chatId/mark-all-read', apiRateLimiter, readReceiptController.markAllAsReadInChat);

// Delete read receipt
router.delete('/:receiptId', apiRateLimiter, readReceiptController.deleteReceipt);

// Sync read receipts
router.post('/sync', apiRateLimiter, readReceiptController.syncReadReceipts);

// Get read statistics
router.get('/stats/:chatId', apiRateLimiter, readReceiptController.getReadStatistics);

// WebSocket endpoint for real-time read updates
router.post('/ws/read', apiRateLimiter, readReceiptController.handleReadWebSocket);

module.exports = router;