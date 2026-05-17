'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupFile = sequelize.define('GroupFile', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:       { type: DataTypes.INTEGER, allowNull: false },
    uploadedBy:    { type: DataTypes.INTEGER, allowNull: false },
    name:          { type: DataTypes.STRING(255), allowNull: false },
    url:           { type: DataTypes.STRING(1000), allowNull: false },
    mimeType:      { type: DataTypes.STRING(100) },
    sizeBytes:     { type: DataTypes.BIGINT, defaultValue: 0 },
    folder:        { type: DataTypes.STRING(255), defaultValue: '/' },
    tags:          { type: DataTypes.JSONB, defaultValue: [] },
    thumbnailUrl:  { type: DataTypes.STRING(1000) },
    downloadCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    isPublic:      { type: DataTypes.BOOLEAN, defaultValue: true },
    deletedAt:     { type: DataTypes.DATE },
    createdAt:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupFiles', timestamps: true });

  GroupFile.associate = models => {
    GroupFile.belongsTo(models.Groups || models.Group, { foreignKey: 'groupId', as: 'group' });
  };
  return GroupFile;
};
