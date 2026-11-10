'use strict';
// StkTransaction.js — ONE ledger row per M-Pesa STK prompt, for every NECPRA module.
// The beneficiary and the approved receiving-account snapshot are saved BEFORE the prompt is sent,
// and the beneficiary is only credited after Safaricom confirms payment (see services/mpesaStkService.js).
module.exports = (sequelize, DataTypes) => {
  const StkTransaction = sequelize.define('StkTransaction', {
    id:                 { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    module:             { type: DataTypes.STRING(30), allowNull: false },
    txType:             { type: DataTypes.STRING(40), allowNull: false, field: 'tx_type' },
    reference:          { type: DataTypes.STRING(80), allowNull: false },
    description:        { type: DataTypes.STRING(255), allowNull: false },
    stkReference:       { type: DataTypes.STRING(12), field: 'stk_reference' },
    stkDesc:            { type: DataTypes.STRING(13), field: 'stk_desc' },
    payerUserId:        { type: DataTypes.INTEGER, allowNull: false, field: 'payer_user_id' },
    payerPhone:         { type: DataTypes.STRING(20), allowNull: false, field: 'payer_phone' },
    amount:             { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    currency:           { type: DataTypes.STRING(10), defaultValue: 'KES' },
    beneficiaryType:    { type: DataTypes.STRING(20), allowNull: false, field: 'beneficiary_type' },
    beneficiaryId:      { type: DataTypes.STRING(64), field: 'beneficiary_id' },
    beneficiaryName:    { type: DataTypes.STRING(160), field: 'beneficiary_name' },
    beneficiaryAccount: { type: DataTypes.JSONB, defaultValue: {}, field: 'beneficiary_account' },
    allocations:        { type: DataTypes.JSONB, defaultValue: [] },
    payload:            { type: DataTypes.JSONB, defaultValue: {} },
    checkoutRequestId:  { type: DataTypes.STRING(100), field: 'checkout_request_id' },
    merchantRequestId:  { type: DataTypes.STRING(100), field: 'merchant_request_id' },
    status:             { type: DataTypes.ENUM('created', 'prompt_sent', 'paid', 'failed', 'cancelled', 'expired', 'amount_mismatch'), defaultValue: 'created' },
    resultCode:         { type: DataTypes.INTEGER, field: 'result_code' },
    resultDesc:         { type: DataTypes.STRING(255), field: 'result_desc' },
    mpesaReceipt:       { type: DataTypes.STRING(40), field: 'mpesa_receipt' },
    paidAmount:         { type: DataTypes.DECIMAL(15, 2), field: 'paid_amount' },
    paidAt:             { type: DataTypes.DATE, field: 'paid_at' },
    creditStatus:       { type: DataTypes.ENUM('not_applicable', 'pending', 'credited', 'failed'), defaultValue: 'pending', field: 'credit_status' },
    creditedAt:         { type: DataTypes.DATE, field: 'credited_at' },
    creditError:        { type: DataTypes.STRING(255), field: 'credit_error' },
    idempotencyKey:     { type: DataTypes.STRING(120), field: 'idempotency_key' },
    createdAt:          { type: DataTypes.DATE, field: 'createdAt' },
    updatedAt:          { type: DataTypes.DATE, field: 'updatedAt' },
  }, {
    tableName: 'stk_transactions', timestamps: true, underscored: true,
    indexes: [
      { fields: ['checkout_request_id'] }, { fields: ['payer_user_id'] }, { fields: ['module', 'reference'] },
      { fields: ['status'] }, { fields: ['credit_status'] },
    ],
  });
  return StkTransaction;
};
