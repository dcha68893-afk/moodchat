'use strict';

module.exports = (sequelize, DataTypes) => {
  const ChatPollOption = sequelize.define('ChatPollOption', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    pollId: { type: DataTypes.INTEGER, allowNull: false },
    text: { type: DataTypes.STRING(255), allowNull: false },
    position: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'ChatPollOptions',
    timestamps: false,
    indexes: [{ fields: ['pollId'] }],
  });

  ChatPollOption.associate = function(models) {
    if (models.ChatPoll) {
      ChatPollOption.belongsTo(models.ChatPoll, { foreignKey: 'pollId', as: 'poll' });
    }
    if (models.ChatPollVote) {
      ChatPollOption.hasMany(models.ChatPollVote, { foreignKey: 'optionId', as: 'votes', onDelete: 'CASCADE' });
    }
  };

  return ChatPollOption;
};
