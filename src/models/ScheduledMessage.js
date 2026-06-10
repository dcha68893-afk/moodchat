// MODEL: ScheduledMessage.js
// Backend-persisted scheduled messages — survive tab close / server restart
module.exports = (sequelize, DataTypes) => {
  const ScheduledMessage = sequelize.define(
    'ScheduledMessage',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING(20),
        defaultValue: 'text',
        allowNull: false,
      },
      mediaUrl: {
        type: DataTypes.STRING(2048),
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      sendAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'sent', 'failed', 'cancelled'),
        defaultValue: 'pending',
        allowNull: false,
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      failureReason: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      retryCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      tableName: 'scheduled_messages',
      modelName: 'ScheduledMessage',
      timestamps: true,
      freezeTableName: true,
      indexes: [
        { fields: ['userId'] },
        { fields: ['chatId'] },
        { fields: ['sendAt'] },
        { fields: ['status'] },
        { fields: ['status', 'sendAt'] },
      ],
    }
  );

  ScheduledMessage.associate = function (models) {
    if (models.Users) {
      ScheduledMessage.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'scheduledByUser',
        onDelete: 'CASCADE',
      });
    }
    if (models.Chats) {
      ScheduledMessage.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'scheduledForChat',
        onDelete: 'CASCADE',
      });
    }
  };

  return ScheduledMessage;
};
