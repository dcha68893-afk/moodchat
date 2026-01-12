const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Chat = sequelize.define(
    'Chat',
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
          model: 'messages',
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
    },
    {
      tableName: 'chats',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ['type'],
        },
        {
          fields: ['last_message_at'],
        },
      ],
    }
  );

  // Instance methods
  Chat.prototype.updateLastMessage = async function (messageId) {
    this.lastMessageId = messageId;
    this.lastMessageAt = new Date();
    return await this.save();
  };

  Chat.prototype.getParticipantIds = async function () {
    const participants = await this.sequelize.models.ChatParticipant.findAll({
      where: { chatId: this.id },
      attributes: ['userId'],
    });
    return participants.map(p => p.userId);
  };

  // Static methods
  Chat.getDirectChat = async function (userId1, userId2) {
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
      group: ['Chat.id'],
      having: this.sequelize.literal('COUNT(DISTINCT "ChatParticipant"."user_id") = 2'),
    });

    return chats[0] || null;
  };

  Chat.getUserChats = async function (userId) {
    return await this.findAll({
      include: [
        {
          model: this.sequelize.models.ChatParticipant,
          where: { userId: userId },
          required: true,
          attributes: [],
        },
        {
          model: this.sequelize.models.Message,
          as: 'lastMessage',
          attributes: ['id', 'content', 'type', 'createdAt'],
          include: [
            {
              model: this.sequelize.models.User,
              as: 'sender',
              attributes: ['id', 'username', 'avatar'],
            },
          ],
        },
      ],
      order: [
        ['lastMessageAt', 'DESC'],
        ['updatedAt', 'DESC'],
      ],
    });
  };

  return Chat;
};