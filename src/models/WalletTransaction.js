'use strict';
module.exports = (sequelize, DataTypes) => {
  const WalletTransaction = sequelize.define('WalletTransaction', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    walletId:     { type: DataTypes.UUID, allowNull: false, field: 'wallet_id' },
    userId:       { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    type:         { type: DataTypes.ENUM('credit','debit'), allowNull: false },
    amount:       { type: DataTypes.DECIMAL(15,2), allowNull: false, validate: { min: 0.01 } },
    currency:     { type: DataTypes.STRING(10), defaultValue: 'KES' },
    balanceAfter: { type: DataTypes.DECIMAL(15,2), field: 'balance_after' },
    orderId:      { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
    reference:    { type: DataTypes.STRING(255), allowNull: true },
    description:  { type: DataTypes.TEXT, allowNull: true },
    metadata:     { type: DataTypes.JSONB, defaultValue: {} },
    // FIX-500-ROOT-CAUSE: the previous options-level createdAt/updatedAt
    // override below only renamed the JS attribute — it didn't stop
    // underscored:true from still mapping it to created_at/updated_at.
    // Physical table has literal camelCase columns, so pin via field:.
    createdAt:    { type: DataTypes.DATE, field: 'createdAt' },
    updatedAt:    { type: DataTypes.DATE, field: 'updatedAt' },
  }, { tableName: 'wallet_transactions', timestamps: true, underscored: true });

  WalletTransaction.associate = function(models) {
    if (models.Wallet) WalletTransaction.belongsTo(models.Wallet, { foreignKey: 'walletId', as: 'wallet', constraints: false });
  };
  return WalletTransaction;
};
