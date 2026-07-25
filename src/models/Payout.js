'use strict';
// Payout.js — P1 FIX: Seller payout / settlement model
module.exports = (sequelize, DataTypes) => {
  const Payout = sequelize.define('Payout', {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    sellerId:    { type: DataTypes.INTEGER, allowNull: false, field: 'seller_id' },
    amount:      { type: DataTypes.DECIMAL(10,2), allowNull: false, validate: { min: 0.01 } },
    currency:    { type: DataTypes.STRING(10), defaultValue: 'KES' },
    method:      { type: DataTypes.STRING(30), defaultValue: 'mpesa' },
    phone:       { type: DataTypes.STRING(30) },
    bankAccount: { type: DataTypes.STRING(100), field: 'bank_account' },
    status:      { type: DataTypes.ENUM('pending','processing','paid','failed','cancelled'), defaultValue: 'pending' },
    reference:   { type: DataTypes.STRING(255) },
    requestedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'requested_at' },
    paidAt:      { type: DataTypes.DATE, field: 'paid_at' },
    disbursedBy: { type: DataTypes.INTEGER, field: 'disbursed_by' },
    notes:       { type: DataTypes.TEXT },
    metadata:    { type: DataTypes.JSONB, defaultValue: {} },
  }, { tableName: 'payouts', timestamps: true, underscored: true,
      indexes: [{ fields: ['seller_id'] }, { fields: ['status'] }] });

  Payout.associate = function(models) {
    if (models.Users) Payout.belongsTo(models.Users, { foreignKey: 'sellerId', as: 'seller', constraints: false });
  };
  return Payout;
};
