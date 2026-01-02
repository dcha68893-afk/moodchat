const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const Chat = sequelize.define(
  'Chat',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.ENUM('direct', 'group'),
      defaultValue: 'direct',
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(100),
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
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    settings: {
      type: DataTypes.JSONB,
      defaultValue: {
        allowInvites: true,
        allowJoining: false,
        allowEditing: false,
        allowDeleting: false,
        allowPinning: true,
        maxParticipants: 100,
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
      {
        fields: ['created_by'],
      },
    ],
  }
);

// Instance methods
Chat.prototype.addParticipant = async function (userId, role = 'member') {
  const ChatParticipant = sequelize.models.ChatParticipant;

  const existingParticipant = await ChatParticipant.findOne({
    where: {
      chatId: this.id,
      userId: userId,
    },
  });

  if (existingParticipant) {
    return existingParticipant;
  }

  return await ChatParticipant.create({
    chatId: this.id,
    userId: userId,
    role: role,
    joinedAt: new Date(),
  });
};

Chat.prototype.removeParticipant = async function (userId) {
  const ChatParticipant = sequelize.models.ChatParticipant;

  return await ChatParticipant.destroy({
    where: {
      chatId: this.id,
      userId: userId,
    },
  });
};

Chat.prototype.getParticipants = async function (options = {}) {
  const ChatParticipant = sequelize.models.ChatParticipant;

  return await ChatParticipant.findAll({
    where: {
      chatId: this.id,
      ...options.where,
    },
    include: [
      {
        model: sequelize.models.User,
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen'],
      },
    ],
    ...options,
  });
};

Chat.prototype.updateLastMessage = async function (messageId, timestamp) {
  this.lastMessageId = messageId;
  this.lastMessageAt = timestamp || new Date();
  return await this.save();
};

Chat.prototype.isParticipant = async function (userId) {
  const ChatParticipant = sequelize.models.ChatParticipant;

  const participant = await ChatParticipant.findOne({
    where: {
      chatId: this.id,
      userId: userId,
    },
  });

  return !!participant;
};

// Static methods
Chat.findDirectChat = async function (userId1, userId2) {
  const ChatParticipant = sequelize.models.ChatParticipant;

  const chats = await ChatParticipant.findAll({
    where: {
      userId: [userId1, userId2],
    },
    attributes: ['chatId'],
    group: ['chatId'],
    having: sequelize.literal(`COUNT(DISTINCT user_id) = 2`),
  });

  const chatIds = chats.map(c => c.chatId);

  if (chatIds.length > 0) {
    return await this.findOne({
      where: {
        id: chatIds,
        type: 'direct',
      },
    });
  }

  return null;
};

Chat.getUserChats = async function (userId, options = {}) {
  const ChatParticipant = sequelize.models.ChatParticipant;

  const participantChats = await ChatParticipant.findAll({
    where: {
      userId: userId,
    },
    attributes: ['chatId'],
  });

  const chatIds = participantChats.map(p => p.chatId);

  return await this.findAll({
    where: {
      id: chatIds,
      isActive: true,
      ...options.where,
    },
    include: [
      {
        model: ChatParticipant,
        as: 'participants',
        include: [
          {
            model: sequelize.models.User,
            attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status'],
          },
        ],
      },
      {
        model: sequelize.models.Message,
        as: 'lastMessage',
        attributes: ['id', 'content', 'type', 'createdAt', 'senderId'],
      },
    ],
    order: [['lastMessageAt', 'DESC']],
    ...options,
  });
};

module.exports = Chat;
