// --- MODEL: Chats.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Chats = sequelize.define(
    'Chats',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      type: {
        type: DataTypes.ENUM('direct', 'group'),
        defaultValue: 'direct',
        allowNull: false,
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id',
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      avatar: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      lastMessageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'Messages',
          key: 'id',
        },
      },
      lastMessageAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {
          allowMedia: true,
          allowCalls: true,
          allowReactions: true,
          allowReplies: true,
          allowEditing: true,
          allowDeleting: true,
          slowMode: 0,
          requireAdminApproval: false,
        },
        allowNull: false,
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
      }
    },
    {
      tableName: 'chats',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['type'],
        },
        {
          fields: ['lastMessageAt'],
        },
      ],
    }
  );

  // Instance methods
  Chats.prototype.updateLastMessage = async function (messageId) {
    this.lastMessageId = messageId;
    this.lastMessageAt = new Date();
    return await this.save();
  };

  Chats.prototype.getParticipantIds = async function () {
    if (!this.sequelize.models.ChatParticipant) {
      return [];
    }
    
    const participants = await this.sequelize.models.ChatParticipant.findAll({
      where: { chatId: this.id },
      attributes: ['userId'],
    });
    return participants.map(p => p.userId);
  };

  // Static methods
  Chats.getDirectChat = async function (userId1, userId2) {
    if (!this.sequelize.models.ChatParticipant) {
      return null;
    }

    const chats = await this.findAll({
      where: {
        type: 'direct',
      },
      include: [
        {
          model: this.sequelize.models.ChatParticipant,
          where: {
            userId: [userId1, userId2],
          },
          attributes: [],
          required: true,
        },
      ],
      group: ['Chats.id'],
      having: this.sequelize.literal('COUNT(DISTINCT "ChatParticipant"."userId") = 2'),
    });

    return chats[0] || null;
  };

  Chats.getUserChats = async function (userId) {
    const include = [
      {
        model: this.sequelize.models.ChatParticipant,
        where: { userId: userId },
        required: true,
        attributes: [],
      }
    ];

    // Only include lastMessage if Messages model exists
    if (this.sequelize.models.Messages) {
      include.push({
        model: this.sequelize.models.Messages,
        as: 'chatMessages',
        attributes: ['id', 'content', 'type', 'createdAt'],
        required: false,
        limit: 1,
        order: [['createdAt', 'DESC']],
        include: this.sequelize.models.Users ? [
          {
            model: this.sequelize.models.Users,
            as: 'messageSender',
            attributes: ['id', 'username', 'avatar'],
          },
        ] : undefined,
      });
    }

    return await this.findAll({
      include: include,
      order: [
        ['lastMessageAt', 'DESC NULLS LAST'],
        ['updatedAt', 'DESC'],
      ],
    });
  };

  // Association method - Essential for proper relationships
  Chats.associate = function (models) {
    // Chat has many Messages
    if (models.Messages) {
      Chats.hasMany(models.Messages, {
        foreignKey: 'chatId',
        as: 'chatMessages'
      });
    }

    // Chat has many ChatParticipants
    if (models.ChatParticipant) {
      Chats.hasMany(models.ChatParticipant, {
        foreignKey: 'chatId',
        as: 'participants'
      });
    }

    // Chat belongs to a User (creator)
    if (models.Users) {
      Chats.belongsTo(models.Users, {
        foreignKey: 'createdBy',
        as: 'creator'
      });
    }

    // Chat belongs to a Message (last message)
    if (models.Messages) {
      Chats.belongsTo(models.Messages, {
        foreignKey: 'lastMessageId',
        as: 'lastMessage'
      });
    }
  };

  return Chats;
};