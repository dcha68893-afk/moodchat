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
      isArchived: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      archivedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      archivedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      deletedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      lastMessageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
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
      modelName: 'Chats',
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
        {
          fields: ['createdBy'],
        },
        {
          fields: ['isArchived'],
        },
        {
          fields: ['isActive'],
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
          as: 'chatParticipants',
          where: {
            userId: [userId1, userId2],
          },
          attributes: [],
          required: true,
        },
      ],
      group: ['Chats.id'],
      having: this.sequelize.literal('COUNT(DISTINCT "chatParticipants"."userId") = 2'),
    });

    return chats[0] || null;
  };

  Chats.getUserChats = async function (userId) {
    if (!this.sequelize.models.ChatParticipant) {
      console.error('[Chats] ChatParticipant model not found');
      return [];
    }

    const includeArray = [
      {
        model: this.sequelize.models.ChatParticipant,
        as: 'chatParticipants',
        where: { userId: userId },
        required: true,
        attributes: [],
      }
    ];

    if (this.sequelize.models.Messages) {
      const messagesInclude = {
        model: this.sequelize.models.Messages,
        as: 'chatMessages',
        attributes: ['id', 'content', 'type', 'createdAt'],
        required: false,
        limit: 1,
        order: [['createdAt', 'DESC']]
      };
      
      if (this.sequelize.models.Users) {
        messagesInclude.include = [
          {
            model: this.sequelize.models.Users,
            as: 'messageSender',
            attributes: ['id', 'username', 'avatar'],
          },
        ];
      }
      
      includeArray.push(messagesInclude);
    }

    try {
      return await this.findAll({
        include: includeArray,
        order: [
          ['lastMessageAt', 'DESC NULLS LAST'],
          ['updatedAt', 'DESC'],
        ],
      });
    } catch (error) {
      console.error('[Chats] Error fetching chats:', error.message);
      return await this.findAll({
        include: [
          {
            model: this.sequelize.models.ChatParticipant,
            as: 'chatParticipants',
            where: { userId: userId },
            required: true,
            attributes: [],
          }
        ],
        order: [
          ['lastMessageAt', 'DESC NULLS LAST'],
          ['updatedAt', 'DESC'],
        ],
      });
    }
  };

  // Associations
  Chats.associate = function (models) {
    if (this.associations && Object.keys(this.associations).length > 0) {
      return;
    }
        
    if (models.Messages) {
      Chats.hasMany(models.Messages, {
        foreignKey: 'chatId',
        as: 'chatMessages',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.ChatParticipant) {
      Chats.hasMany(models.ChatParticipant, {
        foreignKey: 'chatId',
        as: 'chatParticipants',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Users) {
      Chats.belongsTo(models.Users, {
        foreignKey: 'createdBy',
        as: 'chatCreator',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Messages) {
      Chats.belongsTo(models.Messages, {
        foreignKey: 'lastMessageId',
        as: 'chatLastMessage',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Chats;
};