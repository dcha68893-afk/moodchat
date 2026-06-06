'use strict';
/**
 * GroupAnalytics.js — Daily analytics snapshot per group
 * Used by the analytics cron in server.js to track active members, message counts etc.
 */
module.exports = (sequelize, DataTypes) => {
  const GroupAnalytics = sequelize.define('GroupAnalytics', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'group_id',
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    messageCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'message_count',
    },
    activeMembers: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'active_members',
    },
    newMembers: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'new_members',
    },
    totalReactions: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'total_reactions',
    },
    mediaShared: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'media_shared',
    },
    callMinutes: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'call_minutes',
    },
  }, {
    tableName: 'group_analytics',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['group_id', 'date'] },
      { fields: ['group_id'] },
      { fields: ['date'] },
    ],
  });

  GroupAnalytics.associate = (models) => {
    if (models.Groups) {
      GroupAnalytics.belongsTo(models.Groups, { foreignKey: 'groupId', as: 'group' });
    }
  };

  return GroupAnalytics;
};
