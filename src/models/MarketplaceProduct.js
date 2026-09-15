module.exports = (sequelize, DataTypes) => {
  const MarketplaceProduct = sequelize.define('MarketplaceProduct', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    categoryId: { type: DataTypes.UUID, allowNull: false, field: 'category_id' },
    brandId: { type: DataTypes.UUID, allowNull: true, field: 'brand_id' },
    name: { type: DataTypes.STRING(255), allowNull: false },
    slug: { type: DataTypes.STRING(300), allowNull: false, unique: true },
    productType: { type: DataTypes.ENUM('physical','service','digital'), allowNull: false, field: 'product_type' },
    model: { type: DataTypes.STRING(180), allowNull: true },
    manufacturerPartNumber: { type: DataTypes.STRING(180), allowNull: true, field: 'manufacturer_part_number' },
    description: { type: DataTypes.TEXT, allowNull: true },
    defaultImageUrl: { type: DataTypes.TEXT, allowNull: true, field: 'default_image_url' },
    attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
  }, {
    tableName: 'marketplace_products',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['slug'] },
      { fields: ['category_id'] },
      { fields: ['brand_id'] },
      { fields: ['product_type'] },
      { fields: ['model'] },
    ],
  });

  MarketplaceProduct.associate = function (models) {
    MarketplaceProduct.belongsTo(models.MarketplaceCategory, { as: 'category', foreignKey: 'categoryId', constraints: false });
    MarketplaceProduct.belongsTo(models.MarketplaceBrand, { as: 'brand', foreignKey: 'brandId', constraints: false });
    MarketplaceProduct.hasMany(models.MarketplaceVariant, { as: 'variants', foreignKey: 'productId', constraints: false });
    MarketplaceProduct.hasMany(models.MarketplaceListing, { as: 'listings', foreignKey: 'productId', constraints: false });
  };

  return MarketplaceProduct;
};