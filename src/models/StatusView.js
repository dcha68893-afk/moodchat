'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('StatusView', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  statusId: { type: DataTypes.INTEGER, allowNull: false },
  viewerId: { type: DataTypes.INTEGER, allowNull: false },
  viewedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'StatusViews', freezeTableName: true, timestamps: true, indexes: [{ unique: true, fields: ['statusId', 'viewerId'] }, { fields: ['statusId'] }] });