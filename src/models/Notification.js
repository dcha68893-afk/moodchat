const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

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
        model: 'users',
        key: 'id',
      },
    },
    type: {
      type: DataTypes.ENUM(
        'friend_request',
        'friend_request_accepted',
        'new_message',
        'message_reaction',
        'message_reply',
        'group_invite',
        'group_mention',
        'call_incoming',
        'call_missed',
        'mood_shared',
        'system',
        'other'
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
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    isDelivered: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    deliveredAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    priority: {
      type: DataTypes.ENUM('low', 'medium', 'high', 'urgent'),
      defaultValue: 'medium',
      allowNull: false,
    },
    channel: {
      type: DataTypes.ENUM('push', 'email', 'sms', 'in_app'),
      defaultValue: 'in_app',
      allowNull: false,
    },
    actionUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },
  },
  {
    tableName: 'notifications',
    timestamps: true,
    underscored: true,
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
        fields: ['is_delivered'],
      },
      {
        fields: ['priority'],
      },
      {
        fields: ['created_at'],
      },
      {
        fields: ['expires_at'],
      },
    ],
    hooks: {
      beforeCreate: async notification => {
        // Set default expiration (7 days for most notifications)
        if (!notification.expiresAt) {
          notification.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        }

        // Set default title based on type
        if (!notification.title) {
          const defaultTitles = {
            friend_request: 'New Friend Request',
            friend_request_accepted: 'Friend Request Accepted',
            new_message: 'New Message',
            message_reaction: 'Message Reaction',
            message_reply: 'Message Reply',
            group_invite: 'Group Invitation',
            group_mention: 'You were mentioned',
            call_incoming: 'Incoming Call',
            call_missed: 'Missed Call',
            mood_shared: 'Mood Shared',
            system: 'System Notification',
          };
          notification.title = defaultTitles[notification.type] || 'Notification';
        }
      },
    },
  }
);

// Instance methods
Notification.prototype.markAsRead = async function () {
  this.isRead = true;
  this.readAt = new Date();
  return await this.save();
};

Notification.prototype.markAsDelivered = async function () {
  this.isDelivered = true;
  this.deliveredAt = new Date();
  return await this.save();
};

Notification.prototype.getActionData = function () {
  const actionData = {
    type: this.type,
    data: this.data,
    url: this.actionUrl,
  };

  // Add specific action based on type
  switch (this.type) {
    case 'friend_request':
      actionData.action = 'view_friend_request';
      break;
    case 'new_message':
      actionData.action = 'open_chat';
      break;
    case 'call_incoming':
      actionData.action = 'answer_call';
      break;
    default:
      actionData.action = 'view_notification';
  }

  return actionData;
};

// Static methods
Notification.getUserNotifications = async function (userId, options = {}) {
  const where = {
    userId: userId,
    expiresAt: { [Op.or]: [{ [Op.gt]: new Date() }, { [Op.is]: null }] },
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

  return await this.findAll({
    where: where,
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Notification.getUnreadCount = async function (userId) {
  return await this.count({
    where: {
      userId: userId,
      isRead: false,
      expiresAt: { [Op.or]: [{ [Op.gt]: new Date() }, { [Op.is]: null }] },
    },
  });
};

Notification.markAllAsRead = async function (userId) {
  return await this.update(
    {
      isRead: true,
      readAt: new Date(),
    },
    {
      where: {
        userId: userId,
        isRead: false,
      },
    }
  );
};

Notification.createFromTemplate = async function (userId, template, data = {}) {
  const templates = {
    friend_request: {
      type: 'friend_request',
      title: 'New Friend Request',
      body: `${data.requesterName} sent you a friend request`,
      data: data,
      priority: 'medium',
    },
    friend_request_accepted: {
      type: 'friend_request_accepted',
      title: 'Friend Request Accepted',
      body: `${data.acceptorName} accepted your friend request`,
      data: data,
      priority: 'medium',
    },
    new_message: {
      type: 'new_message',
      title: 'New Message',
      body: `${data.senderName}: ${data.messagePreview}`,
      data: data,
      priority: 'high',
    },
    call_incoming: {
      type: 'call_incoming',
      title: 'Incoming Call',
      body: `${data.callerName} is calling you`,
      data: data,
      priority: 'urgent',
    },
    call_missed: {
      type: 'call_missed',
      title: 'Missed Call',
      body: `You missed a call from ${data.callerName}`,
      data: data,
      priority: 'medium',
    },
  };

  const templateData = templates[template];
  if (!templateData) {
    throw new Error(`Unknown notification template: ${template}`);
  }

  return await this.create({
    userId: userId,
    ...templateData,
  });
};

Notification.cleanupExpired = async function () {
  return await this.destroy({
    where: {
      expiresAt: { [Op.lt]: new Date() },
    },
  });
};

module.exports = Notification;
