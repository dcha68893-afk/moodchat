'use strict';
// SellerProfile.js — P2 FIX: Seller KYC / verification model
module.exports = (sequelize, DataTypes) => {
  const SellerProfile = sequelize.define('SellerProfile', {
    id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId:          { type: DataTypes.INTEGER, allowNull: false, unique: true, field: 'user_id' },
    businessName:    { type: DataTypes.STRING(255), allowNull: false, field: 'business_name' },
    idNumber:        { type: DataTypes.STRING(50), field: 'id_number' },
    idType:          { type: DataTypes.STRING(30), defaultValue: 'national_id', field: 'id_type' },
    phone:           { type: DataTypes.STRING(30) },
    bankName:        { type: DataTypes.STRING(100), field: 'bank_name' },
    bankAccount:     { type: DataTypes.STRING(100), field: 'bank_account' },
    bankBranch:      { type: DataTypes.STRING(100), field: 'bank_branch' },
    kycStatus:       { type: DataTypes.ENUM('pending_review','approved','rejected','incomplete'), defaultValue: 'pending_review', field: 'kyc_status' },
    verified:        { type: DataTypes.BOOLEAN, defaultValue: false },
    verifiedAt:      { type: DataTypes.DATE, field: 'verified_at' },
    verifiedBy:      { type: DataTypes.INTEGER, field: 'verified_by' },
    rejectionReason: { type: DataTypes.TEXT, field: 'rejection_reason' },
    rejectedAt:      { type: DataTypes.DATE, field: 'rejected_at' },
    submittedAt:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'submitted_at' },
    metadata:        { type: DataTypes.JSONB, defaultValue: {} },
    // FIX-500-ROOT-CAUSE: options-level rename below didn't stop
    // underscored:true from mapping this to created_at/updated_at. Physical
    // table has literal camelCase columns, so pin via field:.
    createdAt:       { type: DataTypes.DATE, field: 'createdAt' },
    updatedAt:       { type: DataTypes.DATE, field: 'updatedAt' },
  }, { tableName: 'seller_profiles', timestamps: true, underscored: true,
      indexes: [{ fields: ['user_id'], unique: true }, { fields: ['kyc_status'] }] });

  SellerProfile.associate = function(models) {
    if (models.Users) SellerProfile.belongsTo(models.Users, { foreignKey: 'userId', as: 'user', constraints: false });
  };
  return SellerProfile;
};
