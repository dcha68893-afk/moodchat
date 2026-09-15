module.exports = (sequelize, DataTypes) => {
  const MarketplaceListing = sequelize.define('MarketplaceListing', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
    variantId: { type: DataTypes.UUID, allowNull: true, field: 'variant_id' },
    sellerId: { type: DataTypes.INTEGER, allowNull: false, field: 'seller_id' },
    titleOverride: { type: DataTypes.STRING(255), allowNull: true, field: 'title_override' },
    price: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'KES' },
    stock: { type: DataTypes.INTEGER, allowNull: true },
    condition: { type: DataTypes.ENUM('new','like_new','good','fair','poor'), allowNull: true, defaultValue: 'new' },
    fulfillmentType: { type: DataTypes.ENUM('delivery','pickup','both','appointment','instant_download'), allowNull: false, defaultValue: 'delivery', field: 'fulfillment_type' },
    serviceArea: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'service_area' },
    digitalAccess: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'digital_access' },
    images: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.ENUM('draft','pending_review','active','paused','sold','rejected','deleted'), allowNull: false, defaultValue: 'draft' },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'marketplace_listings',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['product_id'] },
      { fields: ['variant_id'] },
      { fields: ['seller_id'] },
      { fields: ['status'] },
      { fields: ['price'] },
    ],
  });

  MarketplaceListing.associate = function (models) {
    MarketplaceListing.belongsTo(models.MarketplaceProduct, { as: 'product', foreignKey: 'productId', constraints: false });
    MarketplaceListing.belongsTo(models.MarketplaceVariant, { as: 'variant', foreignKey: 'variantId', constraints: false });
    if (models.Users) MarketplaceListing.belongsTo(models.Users, { as: 'seller', foreignKey: 'sellerId', constraints: false });
  };

  return MarketplaceListing;
};