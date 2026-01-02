const notificationService = require('../services/notificationService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class NotificationController {
  async getNotifications(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20, unreadOnly, type, priority } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (unreadOnly === 'true') {
        options.unreadOnly = true;
      }

      if (type) {
        options.type = type;
      }

      if (priority) {
        options.priority = priority;
      }

      const notifications = await notificationService.getUserNotifications(userId, options);

      res.json({
        success: true,
        data: {
          notifications,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: notifications.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get notifications controller error:', error);
      next(error);
    }
  }

  async getUnreadCount(req, res, next) {
    try {
      const userId = req.user.id;

      const count = await notificationService.getUnreadCount(userId);

      res.json({
        success: true,
        data: {
          count,
        },
      });
    } catch (error) {
      logger.error('Get unread count controller error:', error);
      next(error);
    }
  }

  async markAsRead(req, res, next) {
    try {
      const userId = req.user.id;
      const { notificationId } = req.params;

      const notification = await notificationService.markAsRead(parseInt(notificationId), userId);

      res.json({
        success: true,
        message: 'Notification marked as read',
        data: {
          notification,
        },
      });
    } catch (error) {
      logger.error('Mark as read controller error:', error);
      next(error);
    }
  }

  async markAllAsRead(req, res, next) {
    try {
      const userId = req.user.id;

      await notificationService.markAllAsRead(userId);

      res.json({
        success: true,
        message: 'All notifications marked as read',
      });
    } catch (error) {
      logger.error('Mark all as read controller error:', error);
      next(error);
    }
  }

  async markAsDelivered(req, res, next) {
    try {
      const userId = req.user.id;
      const { notificationId } = req.params;

      const notification = await notificationService.markAsDelivered(
        parseInt(notificationId),
        userId
      );

      res.json({
        success: true,
        message: 'Notification marked as delivered',
        data: {
          notification,
        },
      });
    } catch (error) {
      logger.error('Mark as delivered controller error:', error);
      next(error);
    }
  }

  async deleteNotification(req, res, next) {
    try {
      const userId = req.user.id;
      const { notificationId } = req.params;

      await notificationService.deleteNotification(parseInt(notificationId), userId);

      res.json({
        success: true,
        message: 'Notification deleted successfully',
      });
    } catch (error) {
      logger.error('Delete notification controller error:', error);
      next(error);
    }
  }

  async deleteAllNotifications(req, res, next) {
    try {
      const userId = req.user.id;
      const { readOnly } = req.query;

      await notificationService.deleteAllNotifications(userId, {
        readOnly: readOnly === 'true',
      });

      res.json({
        success: true,
        message:
          readOnly === 'true' ? 'All read notifications deleted' : 'All notifications deleted',
      });
    } catch (error) {
      logger.error('Delete all notifications controller error:', error);
      next(error);
    }
  }

  async updatePreferences(req, res, next) {
    try {
      const userId = req.user.id;
      const { preferences } = req.body;

      const updatedPreferences = await notificationService.updateNotificationPreferences(
        userId,
        preferences
      );

      res.json({
        success: true,
        message: 'Notification preferences updated',
        data: {
          preferences: updatedPreferences,
        },
      });
    } catch (error) {
      logger.error('Update preferences controller error:', error);
      next(error);
    }
  }

  async sendTestPush(req, res, next) {
    try {
      const userId = req.user.id;
      const { title, body, data } = req.body;

      const result = await notificationService.sendPushNotification(userId, {
        title: title || 'Test Notification',
        body: body || 'This is a test notification',
        data: data || {},
      });

      res.json({
        success: true,
        message: 'Test push notification sent',
        data: result,
      });
    } catch (error) {
      logger.error('Send test push controller error:', error);
      next(error);
    }
  }

  async sendTestEmail(req, res, next) {
    try {
      const userId = req.user.id;
      const { subject, body } = req.body;

      const result = await notificationService.sendEmailNotification(userId, {
        subject: subject || 'Test Email',
        body: body || 'This is a test email',
      });

      res.json({
        success: true,
        message: 'Test email sent',
        data: result,
      });
    } catch (error) {
      logger.error('Send test email controller error:', error);
      next(error);
    }
  }
}

module.exports = new NotificationController();
