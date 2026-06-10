// MODEL: PinnedMessage.js
// Server-synced pinned messages per chat (up to 3 per chat, WhatsApp parity)
module.exports = (sequelize, DataTypes) => {
  const PinnedMessage = sequelize.define(
    'PinnedMessage',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      pinnedBy: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      pinnedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'pinned_messages',
      modelName: 'PinnedMessage',
      timestamps: false,
      freezeTableName: true,
      indexes: [
        { fields: ['chatId'] },
        { fields: ['messageId'] },
        { fields: ['chatId', 'messageId'], unique: true },
      ],
    }
  );

  PinnedMessage.associate = function (models) {
    if (models.Messages) {
      PinnedMessage.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'pinnedMessageContent',
        onDelete: 'CASCADE',
      });
    }
    if (models.Chats) {
      PinnedMessage.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'pinnedInChat',
        onDelete: 'CASCADE',
      });
    }
    if (models.Users) {
      PinnedMessage.belongsTo(models.Users, {
        foreignKey: 'pinnedBy',
        as: 'pinnedByUser',
        onDelete: 'CASCADE',
      });
    }
  };

  return PinnedMessage;
};
