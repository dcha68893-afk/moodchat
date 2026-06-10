'use strict';
/**
 * StatusComment.js — Comments on status posts
 * FIX (Phase 14): Model was missing but referenced in status.js route.
 * FIX (Audit P2): Added parentCommentId for threaded/nested comments.
 */
module.exports = (sequelize, DataTypes) => {
  const StatusComment = sequelize.define('StatusComment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    statusId: { type: DataTypes.INTEGER, allowNull: false, field: 'status_id' },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    content: { type: DataTypes.TEXT, allowNull: false },
    // P2 FIX: parentCommentId for nested/threaded comment replies
    parentCommentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'parent_comment_id',
      defaultValue: null,
    },
    isDeleted: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_deleted' },
  }, {
    tableName: 'status_comments',
    timestamps: true,
    indexes: [
      { fields: ['status_id'] },
      { fields: ['user_id'] },
      { fields: ['parent_comment_id'] },
    ],
  });
  StatusComment.associate = (models) => {
    if (models.Status) StatusComment.belongsTo(models.Status, { foreignKey: 'statusId', as: 'status' });
    if (models.Users) StatusComment.belongsTo(models.Users, { foreignKey: 'userId', as: 'author' });
    // Self-referential for nested comments
    StatusComment.belongsTo(StatusComment, { foreignKey: 'parentCommentId', as: 'parentComment' });
    StatusComment.hasMany(StatusComment, { foreignKey: 'parentCommentId', as: 'replies' });
  };
  return StatusComment;
};

    if (models.Users) StatusComment.belongsTo(models.Users, { foreignKey: 'userId', as: 'author' });
  };
  return StatusComment;
};
