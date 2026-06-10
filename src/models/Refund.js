'use strict';
// Refund.js — P1 FIX: Complete refund workflow model
module.exports = (sequelize, DataTypes) => {
  const Refund = sequelize.define('Refund', {
    id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    orderId:         { type: DataTypes.UUID, allowNull: false, unique: true, field: 'order_id' },
    buyerId:         { type: DataTypes.UUID, allowNull: false, field: 'buyer_id' },
    sellerId:        { type: DataTypes.UUID, allowNull: false, field: 'seller_id' },
    amount:          { type: DataTypes.DECIMAL(10,2), allowNull: false, validate: { min: 0.01 } },
    currency:        { type: DataTypes.STRING(10), defaultValue: 'KES' },
    reason:          { type: DataTypes.TEXT },
    status:          { type: DataTypes.ENUM('pending','approved','rejected','processed'), defaultValue: 'pending' },
    rejectionReason: { type: DataTypes.TEXT, field: 'rejection_reason' },
    approvedBy:      { type: DataTypes.UUID, field: 'approved_by' },
    approvedAt:      { type: DataTypes.DATE, field: 'approved_at' },
    rejectedAt:      { type: DataTypes.DATE, field: 'rejected_at' },
    processedAt:     { type: DataTypes.DATE, field: 'processed_at' },
    metadata:        { type: DataTypes.JSONB, defaultValue: {} },
  }, { tableName: 'refunds', timestamps: true, underscored: true });

  Refund.associate = function(models) {
    if (models.Order) Refund.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order', constraints: false });
  };
  return Refund;
};
