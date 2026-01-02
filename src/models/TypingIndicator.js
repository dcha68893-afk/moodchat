const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const TypingIndicator = sequelize.define(
  'TypingIndicator',
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
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    isTyping: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    lastTypingAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deviceId: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
  },
  {
    tableName: 'typing_indicators',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['chat_id', 'user_id'],
        unique: true,
      },
      {
        fields: ['chat_id'],
      },
      {
        fields: ['user_id'],
      },
      {
        fields: ['is_typing'],
      },
    ],
  }
);

// Instance methods
TypingIndicator.prototype.startTyping = async function () {
  this.isTyping = true;
  this.lastTypingAt = new Date();
  return await this.save();
};

TypingIndicator.prototype.stopTyping = async function () {
  this.isTyping = false;
  return await this.save();
};

// Static methods
TypingIndicator.getTypingUsers = async function (chatId) {
  return await this.findAll({
    where: {
      chatId: chatId,
      isTyping: true,
      lastTypingAt: {
        [Op.gt]: new Date(Date.now() - 10000), // Last 10 seconds
      },
    },
    include: [
      {
        model: sequelize.models.User,
        attributes: ['id', 'username', 'avatar'],
      },
    ],
  });
};

TypingIndicator.updateTyping = async function (chatId, userId, isTyping, options = {}) {
  const [indicator, created] = await this.findOrCreate({
    where: {
      chatId: chatId,
      userId: userId,
    },
    defaults: {
      isTyping: isTyping,
      lastTypingAt: isTyping ? new Date() : null,
      deviceId: options.deviceId,
    },
  });

  if (!created) {
    indicator.isTyping = isTyping;
    indicator.lastTypingAt = isTyping ? new Date() : null;
    indicator.deviceId = options.deviceId;
    await indicator.save();
  }

  return indicator;
};

TypingIndicator.cleanupStale = async function () {
  const cutoff = new Date(Date.now() - 30000); // 30 seconds ago

  return await this.update(
    { isTyping: false },
    {
      where: {
        isTyping: true,
        lastTypingAt: { [Op.lt]: cutoff },
      },
    }
  );
};

module.exports = TypingIndicator;
