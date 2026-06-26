'use strict';
/**
 * Wishlist.js — Dedicated per-item wishlist table
 * Replaces the old savedBy UUID-array approach on Tool.
 * Enables: added_at timestamp, price-drop queries, per-user wishlist API.
 */
module.exports = (sequelize, DataTypes) => {
  const Wishlist = sequelize.define('Wishlist', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'user_id',
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'product_id',
    },
    priceAtAdd: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      field: 'price_at_add',
      comment: 'Price when user added to wishlist — for price-drop detection',
    },
    notifyOnDrop: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'notify_on_drop',
    },
  }, {
    tableName: 'wishlists',
    timestamps: true,
    updatedAt: false,
    underscored: true,
    indexes: [
      { unique: true, fields: ['user_id', 'product_id'] }, // no duplicates
      { fields: ['user_id'] },
      { fields: ['product_id'] },
    ],
  });

  Wishlist.associate = (models) => {
    if (models.User)  Wishlist.belongsTo(models.User,  { foreignKey: 'user_id',    as: 'user'    });
    if (models.Tool)  Wishlist.belongsTo(models.Tool,  { foreignKey: 'product_id', as: 'product' });
  };

  return Wishlist;
};
