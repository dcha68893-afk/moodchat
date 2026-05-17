'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupAttendance = sequelize.define('GroupAttendance', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    eventId:    { type: DataTypes.INTEGER, allowNull: false },
    groupId:    { type: DataTypes.INTEGER, allowNull: false },
    userId:     { type: DataTypes.INTEGER, allowNull: false },
    status:     { type: DataTypes.ENUM('pending','present','absent','late','excused','rsvp_yes','rsvp_no','rsvp_maybe'), defaultValue: 'pending' },
    rsvpAt:     { type: DataTypes.DATE },
    markedAt:   { type: DataTypes.DATE },
    markedBy:   { type: DataTypes.INTEGER },
    gpsLat:     { type: DataTypes.DECIMAL(10,7) },
    gpsLon:     { type: DataTypes.DECIMAL(10,7) },
    qrVerified: { type: DataTypes.BOOLEAN, defaultValue: false },
    note:       { type: DataTypes.TEXT },
    createdAt:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupAttendance', timestamps: true });

  GroupAttendance.associate = models => {
    GroupAttendance.belongsTo(models.GroupEvent, { foreignKey: 'eventId', as: 'event' });
  };
  return GroupAttendance;
};
