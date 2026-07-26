// --- MODEL: Review.js (Marketplace Reviews) ---

module.exports = (sequelize, DataTypes) => {
  const Review = sequelize.define(
    'Review',
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
      orderId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'order_id',
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'user_id',
      },
      sellerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'seller_id',
      },
      rating: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      comment: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: { len: [0, 2000] },
      },
      images: {
        type: DataTypes.ARRAY(DataTypes.TEXT),
        defaultValue: [],
      },
      isVerifiedPurchase: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_verified_purchase',
      },
      helpfulCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'helpful_count',
      },
      sellerReply: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'seller_reply',
      },
      sellerRepliedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'seller_replied_at',
      },
      // FIX-500-ROOT-CAUSE: options-level createdAt/updatedAt override below
      // only renamed the JS attribute, it didn't stop underscored:true from
      // still mapping it to created_at/updated_at. Physical table has literal
      // camelCase columns, so pin via field: on the attribute itself.
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
      tableName: 'marketplace_reviews',
      modelName: 'Review',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        { fields: ['product_id'] },
        { fields: ['user_id'] },
        { fields: ['seller_id'] },
        {
          unique: true,
          fields: ['product_id', 'user_id'],
          name: 'unique_review_per_user_product',
        },
      ],
    }
  );

  Review.associate = function (models) {
    if (models.Tool) {
      Review.belongsTo(models.Tool, {
        foreignKey: 'productId',
        as: 'product',
        constraints: false,
      });
    }
    if (models.Users) {
      Review.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'reviewer',
        constraints: false,
      });
    }
    if (models.Order) {
      Review.belongsTo(models.Order, {
        foreignKey: 'orderId',
        as: 'order',
        constraints: false,
      });
    }
  };

  return Review;
};