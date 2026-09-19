'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('StatusReaction', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  statusId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  emoji: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '❤️' },
}, { tableName: 'StatusReactions', freezeTableName: true, timestamps: true, indexes: [{ unique: true, fields: ['statusId', 'userId'] }, { fields: ['statusId'] }] });