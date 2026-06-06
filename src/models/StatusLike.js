'use strict';
/**
 * StatusLike.js — Tracks likes on status posts
 * FIX (Phase 14): Model was missing but referenced in status.js route.
 */
module.exports = (sequelize, DataTypes) => {
  const StatusLike = sequelize.define('StatusLike', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    statusId: { type: DataTypes.INTEGER, allowNull: false, field: 'status_id' },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    reactionType: { type: DataTypes.STRING(20), defaultValue: 'like', field: 'reaction_type' },
  }, {
    tableName: 'status_likes',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['status_id', 'user_id'] },
      { fields: ['status_id'] },
    ],
  });
  StatusLike.associate = (models) => {
    if (models.Status) StatusLike.belongsTo(models.Status, { foreignKey: 'statusId', as: 'status' });
    if (models.Users) StatusLike.belongsTo(models.Users, { foreignKey: 'userId', as: 'liker' });
  };
  return StatusLike;
};
