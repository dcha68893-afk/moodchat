// --- MODEL: Messages.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Messages = sequelize.define(
    'Messages',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      senderId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      type: {
        type: DataTypes.ENUM('text', 'image', 'video', 'audio', 'file', 'sticker', 'location', 'contact', 'system', 'status_reply', 'poll', 'view_once'),
        defaultValue: 'text',
        allowNull: false,
      },
      replyToId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      replyToStatusId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      statusPreview: {
        type: DataTypes.TEXT,
        allowNull: true,
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
      },
      // ===== ADD MISSING COLUMNS =====
      isRead: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      readAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // ===== END ADDED COLUMNS =====
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
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Disappearing message expiry timestamp. NULL = no expiry.',
      },
      disappearingTimer: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Timer in seconds: 86400=24h, 604800=7d, 2592000=30d, 7776000=90d',
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
      }
    },
    {
      tableName: 'Messages',
      modelName: 'Messages',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['chatId'],
        },
        {
          fields: ['senderId'],
        },
        {
          fields: ['receiverId'],
        },
        {
          fields: ['replyToId'],
        },
        {
          fields: ['replyToStatusId'],
        },
        {
          fields: ['createdAt'],
        },
        {
          fields: ['chatId', 'createdAt'],
        },
        {
          // FIX-AUDIT (MSG-DB-001): covers the hottest query pattern —
          // WHERE chatId = X AND isDeleted = false ORDER BY createdAt DESC.
          // Kept in sync with migrations/2026999990001_add_messages_perf_indexes.js
          fields: ['chatId', 'isDeleted', 'createdAt'],
          name: 'idx_messages_chat_deleted_created',
        },
        {
          fields: ['isRead'],  // Add index for isRead
        },
      ],
    }
  );

  // Instance methods
  Messages.prototype.edit = async function (newContent) {
    this.content = newContent;
    this.isEdited = true;
    this.editedAt = new Date();
    return await this.save();
  };

  Messages.prototype.softDelete = async function (deletedBy) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    return await this.save();
  };

  Messages.prototype.markAsRead = async function () {
    this.isRead = true;
    this.readAt = new Date();
    return await this.save();
  };

  Messages.prototype.addReaction = async function (userId, reaction) {
    if (!this.reactions[reaction]) {
      this.reactions[reaction] = [];
    }
    
    Object.keys(this.reactions).forEach(key => {
      this.reactions[key] = this.reactions[key].filter(id => id !== userId);
    });
    
    if (!this.reactions[reaction].includes(userId)) {
      this.reactions[reaction].push(userId);
    }
    
    return await this.save();
  };

  Messages.prototype.removeReaction = async function (userId, reaction) {
    if (this.reactions[reaction]) {
      this.reactions[reaction] = this.reactions[reaction].filter(id => id !== userId);
    }
    return await this.save();
  };

  Messages.prototype.markAsDelivered = async function () {
    this.deliveredAt = new Date();
    return await this.save();
  };

  // Static methods
  Messages.getChatMessages = async function (chatId, options = {}) {
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
          model: this.sequelize.models.Users,
          as: 'messageSender',
          attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
        },
        {
          model: this,
          as: 'messageParent',
          attributes: ['id', 'content', 'type', 'senderId'],
          include: [
            {
              model: this.sequelize.models.Users,
              as: 'messageSender',
              attributes: ['id', 'username', 'avatar'],
            },
          ],
        },
        {
          model: this.sequelize.models.Media,
          as: 'messageMediaAttachments',
          attributes: ['id', 'url', 'type', 'thumbnailUrl', 'metadata'],
        },
      ],
      order: [['id', 'DESC']],
      limit: options.limit || 50,
    });
  };

  Messages.searchInChat = async function (chatId, query) {
    return await this.findAll({
      where: {
        chatId: chatId,
        isDeleted: false,
        content: { [Op.iLike]: `%${query}%` },
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'messageSender',
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });
  };

  Messages.markAllAsRead = async function (chatId, userId) {
    const [affectedRows] = await this.update(
      { 
        isRead: true,
        readAt: new Date()
      },
      {
        where: {
          chatId: chatId,
          senderId: { [Op.ne]: userId },
          isRead: false
        }
      }
    );
    return affectedRows;
  };

  Messages.getUnreadCount = async function (chatId, userId) {
    return await this.count({
      where: {
        chatId: chatId,
        senderId: { [Op.ne]: userId },
        isRead: false,
        isDeleted: false
      }
    });
  };

  // Associations
  Messages.associate = function(models) {
    if (Messages._associationsDefined) return;
    Messages._associationsDefined = true;
        
    if (models.Chats) {
      Messages.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'messageChat',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Users) {
      Messages.belongsTo(models.Users, {
        foreignKey: 'senderId',
        as: 'messageSender',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
      
      Messages.belongsTo(models.Users, {
        foreignKey: 'deletedBy',
        as: 'messageDeleter',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });

      Messages.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'messageReceiver',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Messages) {
      Messages.belongsTo(models.Messages, {
        foreignKey: 'replyToId',
        as: 'messageParent',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
      
      Messages.hasMany(models.Messages, {
        foreignKey: 'replyToId',
        as: 'messageReplies',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Media) {
      Messages.hasMany(models.Media, {
        foreignKey: 'messageId',
        as: 'messageMediaAttachments',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.ReadReceipt) {
      Messages.hasMany(models.ReadReceipt, {
        foreignKey: 'messageId',
        as: 'messageReadReceipts',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Messages;
};
