'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('StatusReply', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  statusId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  text: { type: DataTypes.TEXT, allowNull: false },
}, { tableName: 'StatusReplies', freezeTableName: true, timestamps: true, indexes: [{ fields: ['statusId', 'createdAt'] }] });