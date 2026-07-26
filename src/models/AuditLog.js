'use strict';
// AuditLog.js — P2 FIX: Admin audit trail
module.exports = (sequelize, DataTypes) => {
  const AuditLog = sequelize.define('AuditLog', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId:       { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
    action:       { type: DataTypes.STRING(100), allowNull: false },
    resourceType: { type: DataTypes.STRING(50), field: 'resource_type' },
    resourceId:   { type: DataTypes.STRING(255), field: 'resource_id' },
    details:      { type: DataTypes.JSONB, defaultValue: {} },
    ipAddress:    { type: DataTypes.STRING(50), field: 'ip_address' },
    userAgent:    { type: DataTypes.TEXT, field: 'user_agent' },
  }, { tableName: 'audit_logs', timestamps: true, updatedAt: false, underscored: true,
      // FIX-500: physical table has literal camelCase "createdAt" (see raw
      // CREATE TABLE in src/models/index.js); underscored:true would
      // otherwise map it to created_at, which doesn't exist. Index updated
      // to match the real column name.
      createdAt: 'createdAt',
      indexes: [{ fields: ['user_id'] }, { fields: ['action'] }, { fields: ['createdAt'] }] });
  return AuditLog;
};
