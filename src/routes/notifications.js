const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const {
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { Notification, User } = require('../models');

router.use(authenticate);

console.log('✅ Notifications routes initialized');

// Get notifications
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20, unreadOnly = false, type } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { userId: req.user.id };

      if (unreadOnly === 'true') {
        where.isRead = false;
      }

      if (type) {
        where.type = type;
      }

      const { count, rows: notifications } = await Notification.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        include: [{
          model: User,
          as: 'notificationUser',
          attributes: ['id', 'username', 'avatar']
        }]
      });

      res.status(200).json({
        status: 'success',
        data: {
          notifications,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching notifications:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch notifications'
      });
    }
  })
);

// Get unread count
router.get(
  '/unread',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const unreadCount = await Notification.count({
        where: {
          userId: req.user.id,
          isRead: false
        }
      });

      res.status(200).json({
        status: 'success',
        data: { unreadCount },
      });
    } catch (error) {
      console.error('Error fetching unread count:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch unread count'
      });
    }
  })
);

// Mark as read
router.put(
  '/:notificationId/read',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { notificationId } = req.params;

      const notification = await Notification.findOne({
        where: {
          id: notificationId,
          userId: req.user.id
        }
      });

      if (!notification) {
        throw new NotFoundError('Notification not found');
      }

      await notification.update({
        isRead: true,
        readAt: new Date()
      });

      res.status(200).json({
        status: 'success',
        message: 'Notification marked as read',
        data: { notification },
      });
    } catch (error) {
      console.error('Error marking notification as read:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to mark notification as read'
      });
    }
  })
);

// Mark all as read
router.put(
  '/read-all',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await Notification.update(
        {
          isRead: true,
          readAt: new Date()
        },
        {
          where: {
            userId: req.user.id,
            isRead: false
          }
        }
      );

      res.status(200).json({
        status: 'success',
        message: `${result[0]} notifications marked as read`,
        data: { updatedCount: result[0] },
      });
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to mark all notifications as read'
      });
    }
  })
);

// Mark as delivered
router.put(
  '/:notificationId/delivered',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { notificationId } = req.params;

      const notification = await Notification.findOne({
        where: {
          id: notificationId,
          userId: req.user.id
        }
      });

      if (!notification) {
        throw new NotFoundError('Notification not found');
      }

      await notification.update({
        isDelivered: true,
        deliveredAt: new Date()
      });

      res.status(200).json({
        status: 'success',
        message: 'Notification marked as delivered',
        data: { notification },
      });
    } catch (error) {
      console.error('Error marking notification as delivered:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to mark notification as delivered'
      });
    }
  })
);

// Delete notification
router.delete(
  '/:notificationId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { notificationId } = req.params;

      const notification = await Notification.findOne({
        where: {
          id: notificationId,
          userId: req.user.id
        }
      });

      if (!notification) {
        throw new NotFoundError('Notification not found');
      }

      await notification.destroy();

      res.status(200).json({
        status: 'success',
        message: 'Notification deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting notification:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to delete notification'
      });
    }
  })
);

// Delete all notifications
router.delete(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { readOnly = false } = req.query;

      const where = { userId: req.user.id };
      if (readOnly === 'true') {
        where.isRead = true;
      }

      const deletedCount = await Notification.destroy({ where });

      res.status(200).json({
        status: 'success',
        message: `${deletedCount} notifications deleted`,
        data: { deletedCount },
      });
    } catch (error) {
      console.error('Error deleting notifications:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to delete notifications'
      });
    }
  })
);

// Update preferences
router.put(
  '/preferences',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { emailNotifications, pushNotifications, muteAll, muteTypes } = req.body;

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const updates = {};
      if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
      if (pushNotifications !== undefined) updates.pushNotifications = pushNotifications;
      if (muteAll !== undefined) updates.notificationsMuted = muteAll;

      if (muteTypes && Array.isArray(muteTypes)) {
        updates.mutedNotificationTypes = muteTypes;
      }

      await user.update(updates);

      res.status(200).json({
        status: 'success',
        message: 'Notification preferences updated',
        data: { preferences: updates },
      });
    } catch (error) {
      console.error('Error updating notification preferences:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to update notification preferences'
      });
    }
  })
);

// Testing endpoints (development only)
if (process.env.NODE_ENV === 'development') {
  // Send test push notification
  router.post(
    '/test/push',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
      try {
        const { title, body, data } = req.body;

        if (!title || !body) {
          throw new ValidationError('Title and body are required');
        }

        // In production, you'd integrate with Firebase Cloud Messaging or similar
        // For now, just create a notification record
        const notification = await Notification.create({
          userId: req.user.id,
          type: 'test',
          title,
          body,
          data: data || {},
          isRead: false,
          isDelivered: false,
        });

        if (req.io) {
          req.io.to(`user:${req.user.id}`).emit('notification:new', {
            notification: notification.toJSON(),
          });
        }

        res.status(201).json({
          status: 'success',
          message: 'Test push notification sent',
          data: { notification },
        });
      } catch (error) {
        console.error('Error sending test push:', error);
        res.status(error.statusCode || 500).json({
          status: 'error',
          message: error.message || 'Failed to send test push'
        });
      }
    })
  );

  // Send test email notification
  router.post(
    '/test/email',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
      try {
        const { subject, body } = req.body;

        if (!subject || !body) {
          throw new ValidationError('Subject and body are required');
        }

        // In production, you'd integrate with an email service like SendGrid, AWS SES, etc.
        // For now, just log the email
        console.log('Test email would be sent:', {
          to: req.user.email,
          subject,
          body
        });

        res.status(200).json({
          status: 'success',
          message: 'Test email would be sent (logged to console)',
          data: {
            to: req.user.email,
            subject,
            body
          },
        });
      } catch (error) {
        console.error('Error sending test email:', error);
        res.status(error.statusCode || 500).json({
          status: 'error',
          message: error.message || 'Failed to send test email'
        });
      }
    })
  );
}

module.exports = router;