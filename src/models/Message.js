const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
        type: DataTypes.ENUM('text', 'image', 'video', 'audio', 'file', 'sticker', 'location', 'contact', 'system'),
        defaultValue: 'text',
        allowNull: false,
      },
      replyToId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'messages',
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
      encryptionKey: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      deliveredAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'messages',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['chat_id'],
        },
        {
          fields: ['sender_id'],
        },
        {
          fields: ['reply_to_id'],
        },
        {
          fields: ['created_at'],
        },
        {
          fields: ['chat_id', 'created_at'],
        },
      ],
    }
  );

  // Instance methods
  Message.prototype.edit = async function (newContent) {
    this.content = newContent;
    this.isEdited = true;
    this.editedAt = new Date();
    return await this.save();
  };

  Message.prototype.softDelete = async function (deletedBy) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    return await this.save();
  };

  Message.prototype.addReaction = async function (userId, reaction) {
    if (!this.reactions[reaction]) {
      this.reactions[reaction] = [];
    }
    
    // Remove existing reaction from user if any
    Object.keys(this.reactions).forEach(key => {
      this.reactions[key] = this.reactions[key].filter(id => id !== userId);
    });
    
    // Add new reaction
    if (!this.reactions[reaction].includes(userId)) {
      this.reactions[reaction].push(userId);
    }
    
    return await this.save();
  };

  Message.prototype.removeReaction = async function (userId, reaction) {
    if (this.reactions[reaction]) {
      this.reactions[reaction] = this.reactions[reaction].filter(id => id !== userId);
    }
    return await this.save();
  };

  Message.prototype.markAsDelivered = async function () {
    this.deliveredAt = new Date();
    return await this.save();
  };

  // Static methods
  Message.getChatMessages = async function (chatId, options = {}) {
    const where = {
      chatId: chatId,
      isDeleted: false,
    };

    if (options.beforeId) {
      where.id = { [Op.lt]: options.beforeId };
    }

    if (options.afterId) {
      where.id = { [Op.gt]: options.afterId };
    }

    return await this.findAll({
      where: where,
      include: [
        {
          model: this.sequelize.models.User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Message,
          as: 'replyTo',
          attributes: ['id', 'content', 'type', 'senderId'],
          include: [
            {
              model: this.sequelize.models.User,
              as: 'sender',
              attributes: ['id', 'username', 'avatar'],
            },
          ],
        },
        {
          model: this.sequelize.models.Media,
          as: 'media',
          attributes: ['id', 'url', 'type', 'thumbnailUrl', 'metadata'],
        },
      ],
      order: [['id', 'DESC']],
      limit: options.limit || 50,
    });
  };

  Message.searchInChat = async function (chatId, query) {
    return await this.findAll({
      where: {
        chatId: chatId,
        isDeleted: false,
        content: { [Op.iLike]: `%${query}%` },
      },
      include: [
        {
          model: this.sequelize.models.User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });
  };

  // Associations defined in models/index.js
  Message.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return Message;
};