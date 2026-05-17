'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupPollOption = sequelize.define('GroupPollOption', {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    pollId:    { type: DataTypes.INTEGER, allowNull: false },
    text:      { type: DataTypes.STRING(255), allowNull: false },
    emoji:     { type: DataTypes.STRING(10) },
    isCorrect: { type: DataTypes.BOOLEAN, defaultValue: false },
    position:  { type: DataTypes.INTEGER, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupPollOptions', timestamps: false });

  GroupPollOption.associate = models => {
    GroupPollOption.belongsTo(models.GroupPoll, { foreignKey: 'pollId', as: 'poll' });
    GroupPollOption.hasMany(models.GroupPollVote, { foreignKey: 'optionId', as: 'votes' });
  };
  return GroupPollOption;
};
