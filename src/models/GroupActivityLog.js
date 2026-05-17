'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupActivityLog = sequelize.define('GroupActivityLog', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:    { type: DataTypes.INTEGER, allowNull: false },
    userId:     { type: DataTypes.INTEGER, allowNull: false },
    action:     { type: DataTypes.STRING(100), allowNull: false },
    module:     { type: DataTypes.STRING(50) },
    targetId:   { type: DataTypes.INTEGER },
    targetType: { type: DataTypes.STRING(50) },
    meta:       { type: DataTypes.JSONB, defaultValue: {} },
    createdAt:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupActivityLogs', timestamps: false });
  return GroupActivityLog;
};
