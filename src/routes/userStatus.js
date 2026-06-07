const path = require('path');
const express = require('express');
const router = express.Router();
const userStatusController = require('../controllers/userStatusController');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Apply authentication to all routes — FIX: was imported but never applied (security bug)
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

// PHASE15 FIX: Live socket-presence check — queries the in-process WebSocketService
// socket map so the response reflects the ACTUAL live connection state, not just
// what's stored in the DB. Supports single userId param or bulk { userIds: [...] } body.
router.get('/presence/:userId', apiRateLimiter, async (req, res) => {
    try {
        let wsService = null;
        try { wsService = require('../services/webSocketService'); } catch(_) {}
        const uid = parseInt(req.params.userId, 10);
        const online = wsService ? await wsService.isUserOnline(uid).catch(() => false) : false;
        res.json({ success: true, userId: uid, online, timestamp: Date.now() });
    } catch (err) {
        res.json({ success: false, userId: req.params.userId, online: false, error: err.message });
    }
});

router.post('/presence/bulk', apiRateLimiter, async (req, res) => {
    try {
        let wsService = null;
        try { wsService = require('../services/webSocketService'); } catch(_) {}
        const { userIds } = req.body || {};
        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.json({ success: true, presence: {}, timestamp: Date.now() });
        }
        const limited = userIds.slice(0, 100);
        const results = {};
        for (const uid of limited) {
            const uidInt = parseInt(uid, 10);
            results[uid] = wsService ? await wsService.isUserOnline(uidInt).catch(() => false) : false;
        }
        res.json({ success: true, presence: results, timestamp: Date.now() });
    } catch (err) {
        res.json({ success: false, presence: {}, error: err.message });
    }
});

module.exports = router;