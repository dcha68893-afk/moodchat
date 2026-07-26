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
    // FIX-500-ROOT-CAUSE: options-level rename below didn't stop
    // underscored:true from mapping this to created_at. Physical table has
    // a literal camelCase column, so pin via field:.
    createdAt:    { type: DataTypes.DATE, field: 'createdAt' },
  }, { tableName: 'audit_logs', timestamps: true, updatedAt: false, underscored: true,
      indexes: [{ fields: ['user_id'] }, { fields: ['action'] }, { fields: ['createdAt'] }] });
  return AuditLog;
};
