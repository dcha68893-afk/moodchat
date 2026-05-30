'use strict';
/**
 * Coupon.js — Enterprise Coupon & Voucher Model
 * Supports: percentage, fixed, free_shipping, user_specific, category_based
 */
module.exports = (sequelize, DataTypes) => {
  const Coupon = sequelize.define('Coupon', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: {
      type: DataTypes.STRING(32), allowNull: false, unique: true,
      set(v) { this.setDataValue('code', v?.toUpperCase().trim()); }
    },
    type: {
      type: DataTypes.ENUM('percent','fixed','free_shipping','cashback'),
      defaultValue: 'percent', allowNull: false,
    },
    value:        { type: DataTypes.DECIMAL(10,2), defaultValue: 0, allowNull: false },
    minOrderAmt:  { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    maxDiscount:  { type: DataTypes.DECIMAL(10,2), allowNull: true, comment: 'Cap for percent coupons' },
    usageLimit:   { type: DataTypes.INTEGER, defaultValue: 9999 },
    usageCount:   { type: DataTypes.INTEGER, defaultValue: 0 },
    perUserLimit: { type: DataTypes.INTEGER, defaultValue: 1 },
    startsAt:     { type: DataTypes.DATE, allowNull: true },
    expiresAt:    { type: DataTypes.DATE, allowNull: true },
    isActive:     { type: DataTypes.BOOLEAN, defaultValue: true },
    isPublic:     { type: DataTypes.BOOLEAN, defaultValue: true },
    userId:       { type: DataTypes.INTEGER, allowNull: true, comment: 'If set, single-user coupon' },
    sellerId:     { type: DataTypes.INTEGER, allowNull: true, comment: 'Seller-specific coupon' },
    categorySlug: { type: DataTypes.STRING(64), allowNull: true, comment: 'Category-restricted coupon' },
    description:  { type: DataTypes.STRING(255), allowNull: true },
    metadata:     { type: DataTypes.JSONB, defaultValue: {} },
  }, {
    tableName: 'coupons',
    timestamps: true,
    indexes: [
      { fields: ['code'], unique: true },
      { fields: ['isActive', 'expiresAt'] },
      { fields: ['userId'] },
    ],
  });

  // Instance: check if coupon is valid for a given cart
  Coupon.prototype.validate = function(subtotal, userId) {
    const now = new Date();
    if (!this.isActive) return { valid: false, reason: 'Coupon is inactive' };
    if (this.startsAt && now < new Date(this.startsAt)) return { valid: false, reason: 'Coupon not yet active' };
    if (this.expiresAt && now > new Date(this.expiresAt)) return { valid: false, reason: 'Coupon has expired' };
    if (this.usageCount >= this.usageLimit) return { valid: false, reason: 'Coupon usage limit reached' };
    if (parseFloat(subtotal) < parseFloat(this.minOrderAmt)) return { valid: false, reason: `Minimum order of KES ${this.minOrderAmt} required` };
    if (this.userId && this.userId !== userId) return { valid: false, reason: 'Coupon not valid for this user' };
    return { valid: true };
  };

  // Instance: compute discount
  Coupon.prototype.computeDiscount = function(subtotal) {
    let discount = 0;
    const sub = parseFloat(subtotal);
    if (this.type === 'percent') {
      discount = sub * (parseFloat(this.value) / 100);
      if (this.maxDiscount) discount = Math.min(discount, parseFloat(this.maxDiscount));
    } else if (this.type === 'fixed' || this.type === 'cashback') {
      discount = Math.min(parseFloat(this.value), sub);
    } else if (this.type === 'free_shipping') {
      discount = 0; // handled separately in checkout
    }
    return Math.round(discount * 100) / 100;
  };

  Coupon.associate = function(models) {
    if (models.Users) Coupon.belongsTo(models.Users, { foreignKey: 'userId', as: 'user', constraints: false });
  };

  return Coupon;
};
