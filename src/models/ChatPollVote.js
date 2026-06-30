'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChatPollVote = sequelize.define('ChatPollVote', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    pollId: { type: DataTypes.INTEGER, allowNull: false },
    optionId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'ChatPollVotes',
    timestamps: false,
    indexes: [
      { fields: ['optionId', 'userId'], unique: true, name: 'uniq_chatpollvotes_option_user' },
      { fields: ['pollId', 'userId'] },
    ],
  });

  ChatPollVote.associate = function(models) {
    if (models.ChatPoll) {
      ChatPollVote.belongsTo(models.ChatPoll, { foreignKey: 'pollId', as: 'poll' });
    }
    if (models.ChatPollOption) {
      ChatPollVote.belongsTo(models.ChatPollOption, { foreignKey: 'optionId', as: 'option' });
    }
    if (models.Users) {
      ChatPollVote.belongsTo(models.Users, { foreignKey: 'userId', as: 'voter', constraints: false });
    }
  };

  return ChatPollVote;
};
