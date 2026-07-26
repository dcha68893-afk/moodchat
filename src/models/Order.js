// --- MODEL: Order.js (Marketplace Orders) ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Order = sequelize.define(
    'Order',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      productId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'product_id',
      },
      buyerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'buyer_id',
      },
      sellerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'seller_id',
      },
      status: {
        type: DataTypes.ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'),
        defaultValue: 'pending',
        allowNull: false,
      },
      quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        validate: { min: 1 },
      },
      totalPrice: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        field: 'total_price',
        validate: { min: 0 },
      },
      currency: {
        type: DataTypes.STRING(10),
        defaultValue: 'KES',
      },
      paymentMethod: {
        type: DataTypes.STRING(50),
        allowNull: true,
        field: 'payment_method',
      },
      paymentRef: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'payment_ref',
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'paid_at',
      },
      shippedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'shipped_at',
      },
      deliveredAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'delivered_at',
      },
      deliveryAddress: {
        type: DataTypes.JSONB,
        defaultValue: {},
        field: 'delivery_address',
      },
      trackingNumber: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'tracking_number',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      // FIX-500-ROOT-CAUSE (getSellerAnalytics/getSellerOrders/getRecommendations):
      // same class of bug as Tool.js — the options-level createdAt/updatedAt
      // rename below only renames the JS attribute, it does not stop
      // `underscored: true` from still deriving `created_at`/`updated_at` as
      // the column name for that attribute. The physical `marketplace_orders`
      // table has literal camelCase `createdAt`/`updatedAt` columns, so the
      // column name has to be pinned via an explicit `field:` on the
      // attribute itself.
      createdAt: {
        type: DataTypes.DATE,
        field: 'createdAt',
      },
      updatedAt: {
        type: DataTypes.DATE,
        field: 'updatedAt',
      },
    },
    {
      tableName: 'marketplace_orders',
      modelName: 'Order',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        { fields: ['buyer_id'] },
        { fields: ['seller_id'] },
        { fields: ['product_id'] },
        { fields: ['status'] },
        { fields: ['created_at'] },
      ],
    }
  );

  Order.associate = function (models) {
    if (models.Tool) {
      Order.belongsTo(models.Tool, {
        foreignKey: 'productId',
        as: 'product',
        constraints: false,
      });
    }
    if (models.Users) {
      Order.belongsTo(models.Users, {
        foreignKey: 'buyerId',
        as: 'buyer',
        constraints: false,
      });
      Order.belongsTo(models.Users, {
        foreignKey: 'sellerId',
        as: 'seller',
        constraints: false,
      });
    }
  };

  return Order;
};