// MODEL: MessageReport.js
// Abuse/spam reports for messages — backend route was missing entirely
module.exports = (sequelize, DataTypes) => {
  const MessageReport = sequelize.define(
    'MessageReport',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      reporterId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      reason: {
        type: DataTypes.ENUM(
          'spam',
          'harassment',
          'hate_speech',
          'violence',
          'sexual_content',
          'misinformation',
          'other'
        ),
        allowNull: false,
      },
      details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('pending', 'reviewed', 'actioned', 'dismissed'),
        defaultValue: 'pending',
        allowNull: false,
      },
      reviewedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      reviewedAt: {
        type: DataTypes.DATE,
        allowNull: true,
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
      tableName: 'message_reports',
      modelName: 'MessageReport',
      timestamps: true,
      freezeTableName: true,
      indexes: [
        { fields: ['reporterId'] },
        { fields: ['messageId'] },
        { fields: ['status'] },
        { fields: ['chatId'] },
        // Prevent duplicate reports from same user on same message
        { fields: ['reporterId', 'messageId'], unique: true },
      ],
    }
  );

  MessageReport.associate = function (models) {
    if (models.Users) {
      MessageReport.belongsTo(models.Users, {
        foreignKey: 'reporterId',
        as: 'reportedByUser',
        onDelete: 'CASCADE',
      });
    }
    if (models.Messages) {
      MessageReport.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'reportedMessage',
        onDelete: 'CASCADE',
      });
    }
  };

  return MessageReport;
};
