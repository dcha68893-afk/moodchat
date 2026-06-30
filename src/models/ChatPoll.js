'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChatPoll = sequelize.define('ChatPoll', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    chatId: { type: DataTypes.INTEGER, allowNull: false },
    messageId: { type: DataTypes.INTEGER, allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: false },
    question: { type: DataTypes.STRING(500), allowNull: false },
    allowMultipleAnswers: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
    isAnonymous: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
    closesAt: { type: DataTypes.DATE, allowNull: true },
    isClosed: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
    closedAt: { type: DataTypes.DATE, allowNull: true },
    closedBy: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'ChatPolls',
    timestamps: true,
    indexes: [
      { fields: ['chatId'] },
      { fields: ['messageId'] },
    ],
  });

  ChatPoll.associate = function(models) {
    if (models.Chats) {
      ChatPoll.belongsTo(models.Chats, { foreignKey: 'chatId', as: 'chat', constraints: false });
    }
    if (models.Messages) {
      ChatPoll.belongsTo(models.Messages, { foreignKey: 'messageId', as: 'message', constraints: false });
    }
    if (models.ChatPollOption) {
      ChatPoll.hasMany(models.ChatPollOption, { foreignKey: 'pollId', as: 'options', onDelete: 'CASCADE' });
    }
    if (models.ChatPollVote) {
      ChatPoll.hasMany(models.ChatPollVote, { foreignKey: 'pollId', as: 'votes', onDelete: 'CASCADE' });
    }
  };

  return ChatPoll;
};
