'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('VibeWatchStats', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  statusId: { type: DataTypes.INTEGER, allowNull: false },
  viewerId: { type: DataTypes.INTEGER, allowNull: false },
  secondsWatched: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
  playCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  completionCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  rewatchCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
}, {
  tableName: 'VibeWatchStats',
  freezeTableName: true,
  timestamps: true,
  indexes: [
    { unique: true, fields: ['statusId', 'viewerId'] },
    { fields: ['statusId'] },
    { fields: ['viewerId'] }
  ]
});