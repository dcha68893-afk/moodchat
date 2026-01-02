const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const Message = sequelize.define(
  'Message',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    chatId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'chats',
        key: 'id',
      },
    },
    senderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    type: {
      type: DataTypes.ENUM(
        'text',
        'image',
        'video',
        'audio',
        'file',
        'location',
        'contact',
        'system'
      ),
      defaultValue: 'text',
      allowNull: false,
    },
    mediaUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    mediaType: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    mediaSize: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 0,
      },
    },
    thumbnailUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Duration in seconds for audio/video',
    },
    location: {
      type: DataTypes.JSONB,
      allowNull: true,
      validate: {
        isValidLocation(value) {
          if (value && (!value.latitude || !value.longitude)) {
            throw new Error('Location must have latitude and longitude');
          }
        },
      },
    },
    contact: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    replyToId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'messages',
        key: 'id',
      },
    },
    forwardedFrom: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    isEdited: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    editedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    isDeleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deletedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    isPinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    pinnedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    pinnedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    reactions: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },
    clientMessageId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Client-generated ID for offline sync',
    },
    syncStatus: {
      type: DataTypes.ENUM('pending', 'sent', 'delivered', 'read', 'failed'),
      defaultValue: 'sent',
      allowNull: false,
    },
  },
  {
    tableName: 'messages',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['chat_id'],
      },
      {
        fields: ['sender_id'],
      },
      {
        fields: ['created_at'],
      },
      {
        fields: ['reply_to_id'],
      },
      {
        fields: ['is_pinned'],
      },
      {
        fields: ['client_message_id'],
      },
      {
        fields: ['sync_status'],
      },
    ],
    hooks: {
      afterCreate: async (message, options) => {
        // Update chat's last message
        const chat = await sequelize.models.Chat.findByPk(message.chatId);
        if (chat) {
          await chat.updateLastMessage(message.id, message.createdAt);
        }

        // Create read receipt for sender
        const ReadReceipt = sequelize.models.ReadReceipt;
        await ReadReceipt.create({
          messageId: message.id,
          userId: message.senderId,
          readAt: new Date(),
        });

        // Create notification for other participants
        const notificationService = require('../services/notificationService');
        await notificationService.notifyNewMessage(message);
      },

      afterUpdate: async (message, options) => {
        if (message.changed('isDeleted') && message.isDeleted) {
          // Notify participants about message deletion
          const webSocketService = require('../services/webSocketService');
          webSocketService.notifyMessageDeleted(message.chatId, message.id);
        }
      },
    },
  }
);

// Instance methods
Message.prototype.edit = async function (newContent, userId) {
  if (this.type !== 'text') {
    throw new Error('Only text messages can be edited');
  }

  this.content = newContent;
  this.isEdited = true;
  this.editedAt = new Date();
  return await this.save();
};

Message.prototype.delete = async function (userId) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.deletedBy = userId;
  return await this.save();
};

Message.prototype.pin = async function (userId) {
  this.isPinned = true;
  this.pinnedAt = new Date();
  this.pinnedBy = userId;
  return await this.save();
};

Message.prototype.unpin = async function () {
  this.isPinned = false;
  this.pinnedAt = null;
  this.pinnedBy = null;
  return await this.save();
};

Message.prototype.addReaction = async function (userId, reaction) {
  const reactions = this.reactions || {};
  if (!reactions[reaction]) {
    reactions[reaction] = [];
  }

  // Remove existing reaction from user
  Object.keys(reactions).forEach(key => {
    reactions[key] = reactions[key].filter(id => id !== userId);
    if (reactions[key].length === 0) {
      delete reactions[key];
    }
  });

  // Add new reaction
  reactions[reaction] = [...(reactions[reaction] || []), userId];
  this.reactions = reactions;
  return await this.save();
};

Message.prototype.removeReaction = async function (userId, reaction) {
  const reactions = this.reactions || {};
  if (reactions[reaction]) {
    reactions[reaction] = reactions[reaction].filter(id => id !== userId);
    if (reactions[reaction].length === 0) {
      delete reactions[reaction];
    }
    this.reactions = reactions;
    return await this.save();
  }
  return this;
};

Message.prototype.getReplyChain = async function () {
  if (!this.replyToId) {
    return [];
  }

  const chain = [];
  let current = await Message.findByPk(this.replyToId, {
    include: [
      {
        model: sequelize.models.User,
        as: 'sender',
        attributes: ['id', 'username', 'avatar'],
      },
    ],
  });

  while (current) {
    chain.unshift(current);
    if (current.replyToId) {
      current = await Message.findByPk(current.replyToId, {
        include: [
          {
            model: sequelize.models.User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
      });
    } else {
      current = null;
    }
  }

  return chain;
};

// Static methods
Message.getChatMessages = async function (chatId, options = {}) {
  const where = {
    chatId: chatId,
    isDeleted: false,
  };

  if (options.before) {
    where.createdAt = { [Op.lt]: options.before };
  }

  if (options.after) {
    where.createdAt = { [Op.gt]: options.after };
  }

  return await this.findAll({
    where: where,
    include: [
      {
        model: sequelize.models.User,
        as: 'sender',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
      },
      {
        model: sequelize.models.Message,
        as: 'replyTo',
        include: [
          {
            model: sequelize.models.User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
      },
      {
        model: sequelize.models.User,
        as: 'forwardedFromUser',
        attributes: ['id', 'username', 'avatar'],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Message.searchInChat = async function (chatId, query, options = {}) {
  return await this.findAll({
    where: {
      chatId: chatId,
      isDeleted: false,
      content: { [Op.iLike]: `%${query}%` },
    },
    include: [
      {
        model: sequelize.models.User,
        as: 'sender',
        attributes: ['id', 'username', 'avatar'],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Message.getPinnedMessages = async function (chatId) {
  return await this.findAll({
    where: {
      chatId: chatId,
      isDeleted: false,
      isPinned: true,
    },
    include: [
      {
        model: sequelize.models.User,
        as: 'sender',
        attributes: ['id', 'username', 'avatar'],
      },
      {
        model: sequelize.models.User,
        as: 'pinnedByUser',
        attributes: ['id', 'username'],
      },
    ],
    order: [['pinnedAt', 'DESC']],
  });
};

module.exports = Message;
