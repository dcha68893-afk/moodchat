'use strict';
// ReceivingAccount.js — where a beneficiary's money may be sent. Only status='approved' accounts are used.
// ownerType: user | circle | fundraiser. (Sellers use their KYC-approved SellerProfile; NECPRA itself is 'platform'.)
module.exports = (sequelize, DataTypes) => {
  const ReceivingAccount = sequelize.define('ReceivingAccount', {
    id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ownerType:       { type: DataTypes.STRING(20), allowNull: false, field: 'owner_type' },
    ownerId:         { type: DataTypes.STRING(64), allowNull: false, field: 'owner_id' },
    method:          { type: DataTypes.ENUM('wallet', 'mpesa_phone', 'paybill', 'till', 'bank'), allowNull: false },
    accountNumber:   { type: DataTypes.STRING(60), field: 'account_number' },
    accountReference:{ type: DataTypes.STRING(60), field: 'account_reference' },
    accountName:     { type: DataTypes.STRING(160), allowNull: false, field: 'account_name' },
    bankName:        { type: DataTypes.STRING(100), field: 'bank_name' },
    status:          { type: DataTypes.ENUM('pending', 'approved', 'rejected', 'suspended'), defaultValue: 'pending' },
    submittedBy:     { type: DataTypes.INTEGER, field: 'submitted_by' },
    approvedBy:      { type: DataTypes.INTEGER, field: 'approved_by' },
    approvedAt:      { type: DataTypes.DATE, field: 'approved_at' },
    rejectionReason: { type: DataTypes.STRING(255), field: 'rejection_reason' },
    metadata:        { type: DataTypes.JSONB, defaultValue: {} },
    createdAt:       { type: DataTypes.DATE, field: 'createdAt' },
    updatedAt:       { type: DataTypes.DATE, field: 'updatedAt' },
  }, {
    tableName: 'receiving_accounts', timestamps: true, underscored: true,
    indexes: [{ fields: ['owner_type', 'owner_id'] }, { fields: ['status'] }],
  });
  return ReceivingAccount;
};
