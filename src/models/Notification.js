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
        references: {
          model: 'Users',
          key: 'id',
        },
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
          'info'
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
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['userId'],
        },
        {
          fields: ['type'],
        },
        {
          fields: ['isRead'],
        },
        {
          fields: ['createdAt'],
        },
        {
          fields: ['userId', 'isRead'],
        },
      ],
    }
  );

  // Instance methods
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

  // Static methods
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

    // Handle scheduled notifications
    where[Op.or] = [
      { scheduledFor: null },
      { scheduledFor: { [Op.lte]: new Date() } },
    ];

    // Handle expired notifications
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
        // Handle scheduled notifications
        [Op.or]: [
          { scheduledFor: null },
          { scheduledFor: { [Op.lte]: new Date() } },
        ],
        // Handle expired notifications
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

  // Associations defined in models/index.js
  Notification.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return Notification;
};