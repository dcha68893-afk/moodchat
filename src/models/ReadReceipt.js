// --- MODEL: ReadReceipt.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      readAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      deviceId: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      ipAddress: {
        type: DataTypes.STRING(45),
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
      },
    },
    {
      tableName: 'read_receipts',            // Standardized: lowercase table name
      modelName: 'ReadReceipt',               // Explicit model name
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['messageId', 'userId'],
          unique: true,
        },
        {
          fields: ['messageId'],
        },
        {
          fields: ['userId'],
        },
        {
          fields: ['readAt'],
        },
      ],
    }
  );

  // Static methods (PRESERVED)
  ReadReceipt.markAsRead = async function (messageId, userId, deviceInfo = {}) {
    const [receipt, created] = await this.findOrCreate({
      where: {
        messageId: messageId,
        userId: userId,
      },
      defaults: {
        readAt: new Date(),
        deviceId: deviceInfo.deviceId,
        ipAddress: deviceInfo.ipAddress,
      },
    });

    if (!created) {
      receipt.readAt = new Date();
      if (deviceInfo.deviceId) receipt.deviceId = deviceInfo.deviceId;
      if (deviceInfo.ipAddress) receipt.ipAddress = deviceInfo.ipAddress;
      await receipt.save();
    }

    return receipt;
  };

  ReadReceipt.getUnreadCount = async function (chatId, userId) {
    const query = `
      SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN read_receipts rr ON m.id = rr.messageId AND rr.userId = ?
      WHERE m.chatId = ? 
      AND m.senderId != ? 
      AND m.isDeleted = false
      AND rr.id IS NULL
    `;

    const [results] = await this.sequelize.query(query, {
      replacements: [userId, chatId, userId],
      type: this.sequelize.QueryTypes.SELECT,
    });

    return results.count;
  };

  ReadReceipt.getLastReadMessage = async function (chatId, userId) {
    const query = `
      SELECT m.*
      FROM messages m
      JOIN read_receipts rr ON m.id = rr.messageId
      WHERE m.chatId = ? 
      AND rr.userId = ?
      AND m.isDeleted = false
      ORDER BY rr.readAt DESC
      LIMIT 1
    `;

    const [results] = await this.sequelize.query(query, {
      replacements: [chatId, userId],
      type: this.sequelize.QueryTypes.SELECT,
    });

    return results;
  };

  // FIXED: Associations with unique aliases
  ReadReceipt.associate = function(models) {
    if (models.Messages) {
      ReadReceipt.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'readMessageDetails',             // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Users) {
      ReadReceipt.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'readUserDetails',                // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return ReadReceipt;
};