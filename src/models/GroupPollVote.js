'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupPollVote = sequelize.define('GroupPollVote', {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    pollId:    { type: DataTypes.INTEGER, allowNull: false },
    optionId:  { type: DataTypes.INTEGER, allowNull: false },
    userId:    { type: DataTypes.INTEGER, allowNull: false },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupPollVotes', timestamps: false });
  return GroupPollVote;
};
