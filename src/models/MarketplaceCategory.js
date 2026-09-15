module.exports = (sequelize, DataTypes) => {
  const MarketplaceCategory = sequelize.define('MarketplaceCategory', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    parentId: { type: DataTypes.UUID, allowNull: true, field: 'parent_id' },
    name: { type: DataTypes.STRING(120), allowNull: false },
    slug: { type: DataTypes.STRING(160), allowNull: false, unique: true },
    kind: { type: DataTypes.ENUM('physical','service','digital'), allowNull: false },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    path: { type: DataTypes.STRING(500), allowNull: false },
    icon: { type: DataTypes.STRING(120), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
    attributesSchema: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'attributes_schema' },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'marketplace_categories',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['slug'] },
      { fields: ['parent_id'] },
      { fields: ['kind'] },
      { fields: ['path'] },
      { fields: ['is_active', 'sort_order'] },
    ],
  });

  MarketplaceCategory.associate = function (models) {
    MarketplaceCategory.belongsTo(models.MarketplaceCategory, { as: 'parent', foreignKey: 'parentId', constraints: false });
    MarketplaceCategory.hasMany(models.MarketplaceCategory, { as: 'children', foreignKey: 'parentId', constraints: false });
    MarketplaceCategory.hasMany(models.MarketplaceProduct, { as: 'products', foreignKey: 'categoryId', constraints: false });
  };

  return MarketplaceCategory;
};