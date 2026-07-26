'use strict';
// Wallet.js — P2 FIX: Wallet system with balance and transaction log
module.exports = (sequelize, DataTypes) => {
  const Wallet = sequelize.define('Wallet', {
    id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId:   { type: DataTypes.UUID, allowNull: false, unique: true, field: 'user_id' },
    balance:  { type: DataTypes.DECIMAL(15,2), defaultValue: 0, allowNull: false, validate: { min: 0 } },
    currency: { type: DataTypes.STRING(10), defaultValue: 'KES' },
    isFrozen: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_frozen' },
    metadata: { type: DataTypes.JSONB, defaultValue: {} },
    // FIX-500-ROOT-CAUSE: options-level rename below didn't stop
    // underscored:true from mapping to created_at/updated_at. Physical table
    // has literal camelCase columns, so pin via field:.
    createdAt: { type: DataTypes.DATE, field: 'createdAt' },
    updatedAt: { type: DataTypes.DATE, field: 'updatedAt' },
  }, { tableName: 'wallets', timestamps: true, underscored: true });

  Wallet.associate = function(models) {
    if (models.Users) Wallet.belongsTo(models.Users, { foreignKey: 'userId', as: 'user', constraints: false });
  };
  return Wallet;
};
