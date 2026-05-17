'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupNote = sequelize.define('GroupNote', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:     { type: DataTypes.INTEGER, allowNull: false },
    createdBy:   { type: DataTypes.INTEGER, allowNull: false },
    title:       { type: DataTypes.STRING(255), allowNull: false },
    content:     { type: DataTypes.TEXT },
    contentType: { type: DataTypes.ENUM('markdown','richtext','plain'), defaultValue: 'markdown' },
    isPinned:    { type: DataTypes.BOOLEAN, defaultValue: false },
    tags:        { type: DataTypes.JSONB, defaultValue: [] },
    category:    { type: DataTypes.STRING(100) },
    version:     { type: DataTypes.INTEGER, defaultValue: 1 },
    deletedAt:   { type: DataTypes.DATE },
    createdAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupNotes', timestamps: true });

  GroupNote.associate = models => {
    GroupNote.belongsTo(models.Groups || models.Group, { foreignKey: 'groupId', as: 'group' });
  };
  return GroupNote;
};
