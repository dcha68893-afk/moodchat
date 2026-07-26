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
    },
    {
      tableName: 'marketplace_orders',
      modelName: 'Order',
      timestamps: true,
      underscored: true,
      // FIX-500 (getSellerAnalytics/getSellerOrders, same class of bug as
      // Tool.js): the physical `marketplace_orders` table was created with
      // literal camelCase "createdAt"/"updatedAt" columns (see the raw
      // CREATE TABLE IF NOT EXISTS in src/models/index.js), but
      // underscored:true auto-maps those two special timestamp attributes to
      // created_at/updated_at, which don't exist — causing every query that
      // touches them to fail with "column \"created_at\" does not exist".
      // Pinning them back to their real camelCase names leaves every other
      // field's explicit snake_case `field:` mapping untouched.
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
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