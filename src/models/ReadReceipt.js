const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const ReadReceipt = sequelize.define(
  'ReadReceipt',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    messageId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'messages',
        key: 'id',
      },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    deviceId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Device identifier for multi-device sync',
    },
    ipAddress: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
  },
  {
    tableName: 'read_receipts',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['message_id', 'user_id'],
        unique: true,
      },
      {
        fields: ['message_id'],
      },
      {
        fields: ['user_id'],
      },
      {
        fields: ['read_at'],
      },
    ],
  }
);

// Static methods
ReadReceipt.markAsRead = async function (messageId, userId, options = {}) {
  const [receipt, created] = await this.findOrCreate({
    where: {
      messageId: messageId,
      userId: userId,
    },
    defaults: {
      readAt: new Date(),
      deviceId: options.deviceId,
      ipAddress: options.ipAddress,
    },
  });

  if (!created) {
    receipt.readAt = new Date();
    receipt.deviceId = options.deviceId;
    receipt.ipAddress = options.ipAddress;
    await receipt.save();
  }

  return receipt;
};

ReadReceipt.getUnreadCount = async function (userId, chatId = null) {
  const Message = sequelize.models.Message;
  const ChatParticipant = sequelize.models.ChatParticipant;

  const where = {
    senderId: { [Op.ne]: userId },
  };

  if (chatId) {
    where.chatId = chatId;
  }

  const messages = await Message.findAll({
    where: where,
    attributes: ['id', 'chatId'],
    include: [
      {
        model: ChatParticipant,
        as: 'chatParticipants',
        where: {
          userId: userId,
        },
        required: true,
      },
    ],
  });

  const messageIds = messages.map(m => m.id);

  if (messageIds.length === 0) {
    return 0;
  }

  const readReceipts = await this.findAll({
    where: {
      messageId: messageIds,
      userId: userId,
    },
    attributes: ['messageId'],
  });

  const readMessageIds = new Set(readReceipts.map(r => r.messageId));
  return messageIds.filter(id => !readMessageIds.has(id)).length;
};

ReadReceipt.getLastReadMessage = async function (chatId, userId) {
  const Message = sequelize.models.Message;

  const lastRead = await this.findOne({
    where: {
      userId: userId,
    },
    include: [
      {
        model: Message,
        where: {
          chatId: chatId,
        },
        required: true,
      },
    ],
    order: [['readAt', 'DESC']],
  });

  return lastRead ? lastRead.Message : null;
};

ReadReceipt.getReaders = async function (messageId) {
  return await this.findAll({
    where: {
      messageId: messageId,
    },
    include: [
      {
        model: sequelize.models.User,
        attributes: ['id', 'username', 'avatar'],
      },
    ],
    order: [['readAt', 'ASC']],
  });
};

module.exports = ReadReceipt;
