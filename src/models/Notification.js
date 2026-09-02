// --- MODEL: Notification.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Notification = sequelize.define(
    'Notification',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      type: {
        type: DataTypes.ENUM(
          'friend_request',
          'friend_request_accepted',
          'message',
          'group_invite',
          'group_mention',
          'call_missed',
          'call_incoming',
          'mood_shared',
          'system',
          'warning',
          'info',
          // FIX: notificationService.js's getNotificationTemplate() has
          // always emitted these type values, but they were never added
          // here or to the live Postgres enum — every Notification.create()
          // for one of these templates threw SequelizeDatabaseError
          // ("invalid input value for enum ... type") and was silently
          // swallowed by messageDeliveryService.js's .catch(() => {}),
          // so recipients never got the in-app Notification row or
          // realtime push. See migrations/20260902000001-add-missing-notification-types.js
          // for the matching live-DB enum fix (this array alone does not
          // alter the existing table).
          'new_message',
          'message_reaction',
          'message_reply',
          'status_mention',
          'status_like',
          'status_comment',
          'status_question_answer',
          'on_this_day'
        ),
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      data: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      isRead: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      isArchived: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      priority: {
        type: DataTypes.ENUM('low', 'normal', 'high', 'urgent'),
        defaultValue: 'normal',
        allowNull: false,
      },
      scheduledFor: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      actionUrl: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      actionText: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      icon: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'notifications',
      modelName: 'Notification',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['user_id'],
        },
        {
          fields: ['type'],
        },
        {
          fields: ['is_read'],
        },
        {
          fields: ['created_at'],
        },
        {
          fields: ['user_id', 'is_read'],
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
  Notification.prototype.markAsRead = async function () {
    this.isRead = true;
    return await this.save();
  };

  Notification.prototype.markAsUnread = async function () {
    this.isRead = false;
    return await this.save();
  };

  Notification.prototype.archive = async function () {
    this.isArchived = true;
    return await this.save();
  };

  Notification.prototype.unarchive = async function () {
    this.isArchived = false;
    return await this.save();
  };

  // Static methods (PRESERVED)
  Notification.getUserNotifications = async function (userId, options = {}) {
    const where = {
      userId: userId,
      isArchived: false,
    };

    if (options.unreadOnly) {
      where.isRead = false;
    }

    if (options.type) {
      where.type = options.type;
    }

    if (options.priority) {
      where.priority = options.priority;
    }

    where[Op.or] = [
      { scheduledFor: null },
      { scheduledFor: { [Op.lte]: new Date() } },
    ];

    where[Op.or] = [
      { expiresAt: null },
      { expiresAt: { [Op.gte]: new Date() } },
    ];

    return await this.findAll({
      where: where,
      order: [
        ['priority', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Notification.getUnreadCount = async function (userId) {
    return await this.count({
      where: {
        userId: userId,
        isRead: false,
        isArchived: false,
        [Op.or]: [
          { scheduledFor: null },
          { scheduledFor: { [Op.lte]: new Date() } },
        ],
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gte]: new Date() } },
        ],
      },
    });
  };

  Notification.createNotification = async function (notificationData) {
    return await this.create(notificationData);
  };

  Notification.markAllAsRead = async function (userId) {
    return await this.update(
      { isRead: true },
      {
        where: {
          userId: userId,
          isRead: false,
        },
      }
    );
  };

  Notification.cleanupExpired = async function () {
    return await this.destroy({
      where: {
        expiresAt: { [Op.lt]: new Date() },
        isArchived: true,
      },
    });
  };

  // FIXED: Associations with unique aliases
  Notification.associate = function(models) {
    // CRITICAL: Prevent duplicate associations (alias conflict fix)
    if (this.associations && Object.keys(this.associations).length > 0) {
        // Skip if associations already defined to prevent alias conflicts
        return;
    }
        
    if (models.Users) {
      Notification.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'notificationRecipient',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Notification;
};
