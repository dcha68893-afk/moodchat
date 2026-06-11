// MODEL: StarredMessage.js
// Stores server-synced starred/bookmarked messages per user
module.exports = (sequelize, DataTypes) => {
  const StarredMessage = sequelize.define(
    'StarredMessage',
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
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      starredAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'starred_messages',
      modelName: 'StarredMessage',
      timestamps: false,
      freezeTableName: true,
      indexes: [
        { fields: ['userId'] },
        { fields: ['messageId'] },
        { fields: ['chatId'] },
        { fields: ['userId', 'messageId'], unique: true },
      ],
    }
  );

  StarredMessage.associate = function (models) {
    if (models.Users) {
      StarredMessage.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'starredByUser',
        onDelete: 'CASCADE',
      });
    }
    if (models.Messages) {
      StarredMessage.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'starredMessage',
        onDelete: 'CASCADE',
      });
    }
  };

  return StarredMessage;
};
