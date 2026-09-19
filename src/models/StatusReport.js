'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('StatusReport', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  statusId: { type: DataTypes.INTEGER, allowNull: false },
  reporterId: { type: DataTypes.INTEGER, allowNull: false },
  reason: { type: DataTypes.STRING(80), allowNull: false },
  details: { type: DataTypes.TEXT, allowNull: true },
}, { tableName: 'StatusReports', freezeTableName: true, timestamps: true, indexes: [{ fields: ['statusId'] }, { fields: ['reporterId'] }] });