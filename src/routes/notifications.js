const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { paginationValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Notification management
router.get('/', paginationValidation, notificationController.getNotifications);
router.get('/unread', notificationController.getUnreadCount);
router.put('/:notificationId/read', notificationController.markAsRead);
router.put('/read-all', notificationController.markAllAsRead);
router.put('/:notificationId/delivered', notificationController.markAsDelivered);
router.delete('/:notificationId', notificationController.deleteNotification);
router.delete('/', notificationController.deleteAllNotifications);

// Preferences
router.put('/preferences', notificationController.updatePreferences);

// Testing (development only)
if (process.env.NODE_ENV === 'development') {
  router.post('/test/push', notificationController.sendTestPush);
  router.post('/test/email', notificationController.sendTestEmail);
}

module.exports = router;
