// --- MODEL: TypingIndicator.js ---
const { Op } = require('sequelize');

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
          model: 'Chats',
          key: 'id',
        },
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
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
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'typing_indicators',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['chatId', 'userId'],
          unique: true,
        },
        {
          fields: ['chatId'],
        },
        {
          fields: ['userId'],
        },
        {
          fields: ['isActive'],
        },
      ],
    }
  );

  TypingIndicator.associate = function(models) {
    if (models.Chats) {
      TypingIndicator.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'indicatorChat', // FIXED: Changed from 'typingChat'
        constraints: false,
      });
    }
    
    if (models.Users) {
      TypingIndicator.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'indicatorUser', // FIXED: Changed from 'typingUser'
        constraints: false,
      });
    }
  };

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
          model: this.sequelize.models.Users,
          as: 'indicatorUser', // FIXED: Changed from 'typingUser'
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['lastUpdatedAt', 'DESC']],
    });
  };

  return TypingIndicator;
};