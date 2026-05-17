'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupEvent = sequelize.define('GroupEvent', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:      { type: DataTypes.INTEGER, allowNull: false },
    createdBy:    { type: DataTypes.INTEGER, allowNull: false },
    title:        { type: DataTypes.STRING(255), allowNull: false },
    description:  { type: DataTypes.TEXT },
    location:     { type: DataTypes.STRING(255) },
    latitude:     { type: DataTypes.DECIMAL(10,7) },
    longitude:    { type: DataTypes.DECIMAL(10,7) },
    startTime:    { type: DataTypes.DATE, allowNull: false },
    endTime:      { type: DataTypes.DATE },
    timezone:     { type: DataTypes.STRING(50), defaultValue: 'UTC' },
    isRecurring:  { type: DataTypes.BOOLEAN, defaultValue: false },
    recurringRule:{ type: DataTypes.STRING(100) },
    rsvpEnabled:  { type: DataTypes.BOOLEAN, defaultValue: true },
    maxAttendees: { type: DataTypes.INTEGER },
    coverImage:   { type: DataTypes.STRING(500) },
    livestreamUrl:{ type: DataTypes.STRING(500) },
    qrCode:       { type: DataTypes.STRING(500) },
    status:       { type: DataTypes.ENUM('draft','upcoming','live','completed','cancelled'), defaultValue: 'upcoming' },
    deletedAt:    { type: DataTypes.DATE },
    createdAt:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupEvents', timestamps: true });

  GroupEvent.associate = models => {
    GroupEvent.belongsTo(models.Groups || models.Group, { foreignKey: 'groupId', as: 'group' });
    GroupEvent.hasMany(models.GroupAttendance, { foreignKey: 'eventId', as: 'attendance' });
  };
  return GroupEvent;
};
