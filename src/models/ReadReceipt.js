const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

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
      freezeTableName: true,
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
      LEFT JOIN read_receipts rr ON m.id = rr.message_id AND rr.user_id = ?
      WHERE m.chat_id = ? 
      AND m.sender_id != ? 
      AND m.is_deleted = false
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
      JOIN read_receipts rr ON m.id = rr.message_id
      WHERE m.chat_id = ? 
      AND rr.user_id = ?
      AND m.is_deleted = false
      ORDER BY rr.read_at DESC
      LIMIT 1
    `;

    const [results] = await this.sequelize.query(query, {
      replacements: [chatId, userId],
      type: this.sequelize.QueryTypes.SELECT,
    });

    return results;
  };

  // Associations defined in models/index.js
  ReadReceipt.associate = function(models) {
    // All associations moved to models/index.js
  };

  return ReadReceipt;
};