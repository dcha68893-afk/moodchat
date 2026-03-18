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
      tableName: 'Messages',                 // Standardized: lowercase table name
      modelName: 'Messages',                  // Explicit model name
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
          fields: ['replyToId'],
        },
        {
          fields: ['createdAt'],
        },
        {
          fields: ['chatId', 'createdAt'],
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
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

  // Static methods (PRESERVED)
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
          as: 'messageSenderDetails',         // FIXED: Unique alias
          attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
        },
        {
          model: this,
          as: 'messageParentDetails',         // FIXED: Unique alias
          attributes: ['id', 'content', 'type', 'senderId'],
          include: [
            {
              model: this.sequelize.models.Users,
              as: 'messageSenderDetails',     // FIXED: Unique alias
              attributes: ['id', 'username', 'avatar'],
            },
          ],
        },
        {
          model: this.sequelize.models.Media,
          as: 'messageMediaAttachments',      // FIXED: Unique alias
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
          as: 'messageSenderDetails',         // FIXED: Unique alias
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });
  };

  // FIXED: Associations with unique aliases
  Messages.associate = function(models) {
    if (models.Chats) {
      Messages.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'messageChatDetails',             // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Users) {
      Messages.belongsTo(models.Users, {
        foreignKey: 'senderId',
        as: 'messageSenderDetails',           // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
      
      Messages.belongsTo(models.Users, {
        foreignKey: 'deletedBy',
        as: 'messageDeleterUser',             // FIXED: Unique alias
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Messages) {
      Messages.belongsTo(models.Messages, {
        foreignKey: 'replyToId',
        as: 'messageParentDetails',           // FIXED: Unique alias
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
      
      Messages.hasMany(models.Messages, {
        foreignKey: 'replyToId',
        as: 'messageRepliesList',             // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Media) {
      Messages.hasMany(models.Media, {
        foreignKey: 'messageId',
        as: 'messageMediaAttachments',        // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.ReadReceipt) {
      Messages.hasMany(models.ReadReceipt, {
        foreignKey: 'messageId',
        as: 'messageReadReceiptsList',        // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Messages;
};