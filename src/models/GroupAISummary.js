'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupAISummary = sequelize.define('GroupAISummary', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:      { type: DataTypes.INTEGER, allowNull: false },
    type:         { type: DataTypes.ENUM('daily','meeting','unread','action_items','weekly'), allowNull: false },
    summary:      { type: DataTypes.TEXT, allowNull: false },
    actionItems:  { type: DataTypes.JSONB, defaultValue: [] },
    keywords:     { type: DataTypes.JSONB, defaultValue: [] },
    messageRange: { type: DataTypes.JSONB },
    generatedBy:  { type: DataTypes.STRING(50), defaultValue: 'openai' },
    createdAt:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupAISummaries', timestamps: false });
  return GroupAISummary;
};
