module.exports = (sequelize, DataTypes) => {
  const MarketplaceVariant = sequelize.define('MarketplaceVariant', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
    sku: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(255), allowNull: true },
    optionValues: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'option_values' },
    imageUrls: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [], field: 'image_urls' },
    price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    stock: { type: DataTypes.INTEGER, allowNull: true },
    weightGrams: { type: DataTypes.INTEGER, allowNull: true, field: 'weight_grams' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'marketplace_variants',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['sku'] }, { fields: ['product_id'] }, { fields: ['is_active'] }],
  });

  MarketplaceVariant.associate = function (models) {
    MarketplaceVariant.belongsTo(models.MarketplaceProduct, { as: 'product', foreignKey: 'productId', constraints: false });
    MarketplaceVariant.hasMany(models.MarketplaceListing, { as: 'listings', foreignKey: 'variantId', constraints: false });
  };

  return MarketplaceVariant;
};