'use strict';
// P3 FIX (Forensic Audit): "Implement password history (last 5) — reject if
// new password matches any of the last 5 used passwords."
//
// Stores the SHA-256-pre-hashed bcrypt hash (same format produced by
// passwordUtils.hashPassword) for each password a user has set. On password
// change/reset, compare the candidate new password against the last 5
// entries using passwordUtils.comparePassword before allowing the change.
module.exports = (sequelize, DataTypes) => {
  const PasswordHistory = sequelize.define('PasswordHistory', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId:       { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    passwordHash: { type: DataTypes.STRING, allowNull: false, field: 'password_hash' },
  }, {
    tableName: 'password_history',
    timestamps: true,
    updatedAt: false,
    underscored: true,
    indexes: [{ fields: ['user_id'] }, { fields: ['created_at'] }],
  });
  return PasswordHistory;
};
