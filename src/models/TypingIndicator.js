const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
      startedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      lastUpdatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
    },
    {
      tableName: 'typing_indicators',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
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
          fields: ['is_active'],
        },
      ],
    }
  );

  // Instance methods
  TypingIndicator.prototype.updateActivity = async function () {
    this.lastUpdatedAt = new Date();
    this.isActive = true;
    return await this.save();
  };

  TypingIndicator.prototype.stop = async function () {
    this.isActive = false;
    return await this.save();
  };

  // Static methods
  TypingIndicator.startTyping = async function (chatId, userId) {
    const [indicator, created] = await this.findOrCreate({
      where: {
        chatId: chatId,
        userId: userId,
      },
      defaults: {
        startedAt: new Date(),
        lastUpdatedAt: new Date(),
        isActive: true,
      },
    });

    if (!created) {
      await indicator.updateActivity();
    }

    return indicator;
  };

  TypingIndicator.stopTyping = async function (chatId, userId) {
    const indicator = await this.findOne({
      where: {
        chatId: chatId,
        userId: userId,
        isActive: true,
      },
    });

    if (indicator) {
      await indicator.stop();
    }

    return indicator;
  };

  TypingIndicator.getActiveTypers = async function (chatId) {
    // Clean up old indicators (more than 10 seconds ago)
    await this.update(
      { isActive: false },
      {
        where: {
          chatId: chatId,
          lastUpdatedAt: { [Op.lt]: new Date(Date.now() - 10000) },
          isActive: true,
        },
      }
    );

    return await this.findAll({
      where: {
        chatId: chatId,
        isActive: true,
      },
      include: [
        {
          model: this.sequelize.models.User,
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['lastUpdatedAt', 'DESC']],
    });
  };

  // Associations defined in models/index.js
  TypingIndicator.associate = function(models) {
    // All associations moved to models/index.js
  };

  return TypingIndicator;
};