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

  MarketplaceCategory.seedDefaults = async function () {
    const defs = [
      ['Physical Products','physical-products','physical',null,0,'Physical Products',{}],
      ['Electronics','electronics','physical','physical-products',1,'Physical Products > Electronics',{}],
      ['Phones & Tablets','phones-tablets','physical','electronics',2,'Physical Products > Electronics > Phones & Tablets',{'brand':{type:'brand'},'model':{type:'text'},'storage':{type:'select',options:['32GB','64GB','128GB','256GB','512GB','1TB']},'ram':{type:'select',options:['2GB','3GB','4GB','6GB','8GB','12GB','16GB']},'color':{type:'text'}}],
      ['Home & Kitchen','home-kitchen','physical', 'physical-products',1,'Physical Products > Home & Kitchen',{}],
      ['Cooking & Kitchen','cooking-kitchen','physical','home-kitchen',2,'Physical Products > Home & Kitchen > Cooking & Kitchen',{}],
      ['Gas & LPG','gas-lpg','physical','cooking-kitchen',3,'Physical Products > Home & Kitchen > Cooking & Kitchen > Gas & LPG',{}],
      ['Gas Cylinders','gas-cylinders','physical','gas-lpg',4,'Physical Products > Home & Kitchen > Cooking & Kitchen > Gas & LPG > Gas Cylinders',{'brand':{type:'brand'},'capacity':{type:'select',options:['3kg','6kg','13kg','22.5kg','50kg']},'cylinderType':{type:'select',options:['standard','composite','industrial']},'valveType':{type:'text'},'condition':{type:'select',options:['new','like_new','good','fair','poor']}}],
      ['LPG Refills','lpg-refills','physical','gas-lpg',4,'Physical Products > Home & Kitchen > Cooking & Kitchen > Gas & LPG > LPG Refills',{'capacity':{type:'select',options:['3kg','6kg','13kg','22.5kg','50kg']},'exchange':{type:'boolean'},'delivery':{type:'boolean'},'emptyCylinderAccepted':{type:'boolean'}}],
      ['Gas Cookers','gas-cookers','physical','gas-lpg',4,'Physical Products > Home & Kitchen > Cooking & Kitchen > Gas & LPG > Gas Cookers',{}],
      ['Gas Regulators','gas-regulators','physical','gas-lpg',4,'Physical Products > Home & Kitchen > Cooking & Kitchen > Gas & LPG > Gas Regulators',{}],
      ['Gas Hoses & Accessories','gas-accessories','physical','gas-lpg',4,'Physical Products > Home & Kitchen > Cooking & Kitchen > Gas & LPG > Gas Hoses & Accessories',{}],
      ['Services','services','service',null,0,'Services',{}],
      ['Home Services','home-services','service','services',1,'Services > Home Services',{}],
      ['Repairs & Maintenance','repairs-maintenance','service','services',1,'Services > Repairs & Maintenance',{}],
      ['Transport & Delivery','transport-delivery','service','services',1,'Services > Transport & Delivery',{}],
      ['Beauty & Personal Care','beauty-personal-care','service','services',1,'Services > Beauty & Personal Care',{}],
      ['Tutoring & Education','tutoring-education','service','services',1,'Services > Tutoring & Education',{}],
      ['Professional & Digital Services','professional-services','service','services',1,'Services > Professional & Digital Services',{}],
      ['Digital Products','digital-products','digital',null,0,'Digital Products',{}],
      ['Ebooks','ebooks','digital','digital-products',1,'Digital Products > Ebooks',{}],
      ['Software','software','digital','digital-products',1,'Digital Products > Software',{}],
      ['Templates','templates','digital','digital-products',1,'Digital Products > Templates',{}],
      ['Courses','courses','digital','digital-products',1,'Digital Products > Courses',{}],
      ['Audio & Media','audio-media','digital','digital-products',1,'Digital Products > Audio & Media',{}],
    ];

    const bySlug = new Map();
    const existing = await MarketplaceCategory.findAll({ attributes: ['id','slug'] });
    existing.forEach(row => bySlug.set(row.slug, row.id));

    for (const [name, slug, kind, parentSlug, level, path, attributesSchema] of defs) {
      const parentId = parentSlug ? bySlug.get(parentSlug) : null;
      if (parentSlug && !parentId) continue;
      const [row] = await MarketplaceCategory.findOrCreate({
        where: { slug },
        defaults: { name, kind, parentId, level, path, attributesSchema, isActive: true },
      });
      bySlug.set(slug, row.id);
    }
  };

  // The application's startup path always performs a final sequelize.sync().
  // Seed only after that sync so this remains idempotent and never races table creation.
  if (!sequelize.__marketplaceTaxonomyHookInstalled) {
    sequelize.__marketplaceTaxonomyHookInstalled = true;
    sequelize.addHook('afterSync', 'marketplaceTaxonomySeed', async () => {
      try {
        await MarketplaceCategory.seedDefaults();
        console.log('[Marketplace] Universal taxonomy seeded/verified');
      } catch (error) {
        console.error('[Marketplace] Taxonomy seed failed:', error.message);
      }
    });
  }

  return MarketplaceCategory;
};