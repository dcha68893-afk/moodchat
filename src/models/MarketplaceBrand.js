module.exports = (sequelize, DataTypes) => {
  const MarketplaceBrand = sequelize.define('MarketplaceBrand', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    logoUrl: { type: DataTypes.TEXT, allowNull: true, field: 'logo_url' },
    description: { type: DataTypes.TEXT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'marketplace_brands',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['slug'] }, { fields: ['name'] }, { fields: ['is_active'] }],
  });

  MarketplaceBrand.associate = function (models) {
    MarketplaceBrand.hasMany(models.MarketplaceProduct, { as: 'products', foreignKey: 'brandId', constraints: false });
  };

  return MarketplaceBrand;
};