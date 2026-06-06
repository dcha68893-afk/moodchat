'use strict';
/**
 * StatusComment.js — Comments on status posts
 * FIX (Phase 14): Model was missing but referenced in status.js route.
 */
module.exports = (sequelize, DataTypes) => {
  const StatusComment = sequelize.define('StatusComment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    statusId: { type: DataTypes.INTEGER, allowNull: false, field: 'status_id' },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    content: { type: DataTypes.TEXT, allowNull: false },
    isDeleted: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_deleted' },
  }, {
    tableName: 'status_comments',
    timestamps: true,
    indexes: [
      { fields: ['status_id'] },
      { fields: ['user_id'] },
    ],
  });
  StatusComment.associate = (models) => {
    if (models.Status) StatusComment.belongsTo(models.Status, { foreignKey: 'statusId', as: 'status' });
    if (models.Users) StatusComment.belongsTo(models.Users, { foreignKey: 'userId', as: 'author' });
  };
  return StatusComment;
};
