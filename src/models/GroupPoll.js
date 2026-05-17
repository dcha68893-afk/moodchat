'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupPoll = sequelize.define('GroupPoll', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:     { type: DataTypes.INTEGER, allowNull: false },
    createdBy:   { type: DataTypes.INTEGER, allowNull: false },
    question:    { type: DataTypes.STRING(500), allowNull: false },
    type:        { type: DataTypes.ENUM('single','multiple','quiz','rating'), defaultValue: 'single' },
    isAnonymous: { type: DataTypes.BOOLEAN, defaultValue: false },
    allowChange: { type: DataTypes.BOOLEAN, defaultValue: true },
    showResults: { type: DataTypes.ENUM('always','after_vote','after_close','admin_only'), defaultValue: 'always' },
    endsAt:      { type: DataTypes.DATE },
    status:      { type: DataTypes.ENUM('draft','active','closed'), defaultValue: 'active' },
    deletedAt:   { type: DataTypes.DATE },
    createdAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupPolls', timestamps: true });

  GroupPoll.associate = models => {
    GroupPoll.belongsTo(models.Groups || models.Group, { foreignKey: 'groupId', as: 'group' });
    GroupPoll.hasMany(models.GroupPollOption, { foreignKey: 'pollId', as: 'options' });
    GroupPoll.hasMany(models.GroupPollVote, { foreignKey: 'pollId', as: 'votes' });
  };
  return GroupPoll;
};
