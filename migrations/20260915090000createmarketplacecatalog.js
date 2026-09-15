'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('marketplace_categories', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      parent_id: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(160), allowNull: false, unique: true },
      kind: { type: DataTypes.ENUM('physical','service','digital'), allowNull: false },
      level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      path: { type: DataTypes.STRING(500), allowNull: false },
      icon: { type: DataTypes.STRING(120), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      attributes_schema: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('marketplace_brands', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      name: { type: DataTypes.STRING(160), allowNull: false },
      slug: { type: DataTypes.STRING(180), allowNull: false, unique: true },
      logo_url: { type: DataTypes.TEXT, allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('marketplace_products', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      category_id: { type: DataTypes.UUID, allowNull: false },
      brand_id: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      slug: { type: DataTypes.STRING(300), allowNull: false, unique: true },
      product_type: { type: DataTypes.ENUM('physical','service','digital'), allowNull: false },
      model: { type: DataTypes.STRING(180), allowNull: true },
      manufacturer_part_number: { type: DataTypes.STRING(180), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      default_image_url: { type: DataTypes.TEXT, allowNull: true },
      attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('marketplace_variants', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      product_id: { type: DataTypes.UUID, allowNull: false },
      sku: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(255), allowNull: true },
      option_values: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      image_urls: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      stock: { type: DataTypes.INTEGER, allowNull: true },
      weight_grams: { type: DataTypes.INTEGER, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('marketplace_listings', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      product_id: { type: DataTypes.UUID, allowNull: false },
      variant_id: { type: DataTypes.UUID, allowNull: true },
      seller_id: { type: DataTypes.INTEGER, allowNull: false },
      title_override: { type: DataTypes.STRING(255), allowNull: true },
      price: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'KES' },
      stock: { type: DataTypes.INTEGER, allowNull: true },
      condition: { type: DataTypes.ENUM('new','like_new','good','fair','poor'), allowNull: true, defaultValue: 'new' },
      fulfillment_type: { type: DataTypes.ENUM('delivery','pickup','both','appointment','instant_download'), allowNull: false, defaultValue: 'delivery' },
      service_area: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      digital_access: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      images: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.ENUM('draft','pending_review','active','paused','sold','rejected','deleted'), allowNull: false, defaultValue: 'draft' },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    const indexes = [
      ['marketplace_categories', ['parent_id']], ['marketplace_categories', ['kind']], ['marketplace_categories', ['path']],
      ['marketplace_brands', ['name']], ['marketplace_brands', ['is_active']],
      ['marketplace_products', ['category_id']], ['marketplace_products', ['brand_id']], ['marketplace_products', ['product_type']], ['marketplace_products', ['model']],
      ['marketplace_variants', ['product_id']], ['marketplace_variants', ['is_active']],
      ['marketplace_listings', ['product_id']], ['marketplace_listings', ['variant_id']], ['marketplace_listings', ['seller_id']], ['marketplace_listings', ['status']], ['marketplace_listings', ['price']],
    ];
    for (const [table, fields] of indexes) await queryInterface.addIndex(table, fields);

    const roots = [
      ['physical','Physical Products','physical-products','physical',0,'physical-products','📦',0,{}],
      ['service','Services','services','service',0,'services','🛠️',0,{}],
      ['digital','Digital Products','digital-products','digital',0,'digital-products','💾',0,{}],
    ];
    for (const [,name,slug,kind,level,path,icon,sortOrder,attributesSchema] of roots) {
      await queryInterface.bulkInsert('marketplace_categories', [{ name, slug, kind, level, path, icon, sort_order: sortOrder, attributes_schema: attributesSchema, metadata: {}, created_at: new Date(), updated_at: new Date() }], { ignoreDuplicates: true });
    }

    const [physical] = await queryInterface.sequelize.query("SELECT id FROM marketplace_categories WHERE slug='physical-products' LIMIT 1");
    const physicalId = physical[0]?.id;
    const children = [
      ['Electronics','electronics','physical','physical-products/electronics','📱',0,{}],
      ['Home & Kitchen','home-kitchen','physical','physical-products/home-kitchen','🏠',1,{}],
      ['Fashion','fashion','physical','physical-products/fashion','👕',2,{}],
      ['Automotive','automotive','physical','physical-products/automotive','🚗',3,{}],
      ['Gas & LPG','gas-lpg','physical','physical-products/home-kitchen/gas-lpg','🔥',4,{}],
    ];
    for (const [name,slug,kind,path,icon,sortOrder,attributesSchema] of children) {
      const parentId = slug === 'gas-lpg' ? (await queryInterface.sequelize.query("SELECT id FROM marketplace_categories WHERE slug='home-kitchen' LIMIT 1"))[0][0]?.id : physicalId;
      await queryInterface.bulkInsert('marketplace_categories', [{ parent_id: parentId, name, slug, kind, level: slug === 'gas-lpg' ? 2 : 1, path, icon, sort_order: sortOrder, attributes_schema: attributesSchema, metadata: {}, created_at: new Date(), updated_at: new Date() }], { ignoreDuplicates: true });
    }
    const [gasRows] = await queryInterface.sequelize.query("SELECT id FROM marketplace_categories WHERE slug='gas-lpg' LIMIT 1");
    const gasId = gasRows[0]?.id;
    const gasChildren = [
      ['Gas Cylinders','gas-cylinders',{'brand':{'type':'string'},'capacity_kg':{'type':'number','enum':[3,6,13,22.5,50]},'condition':{'type':'string','enum':['new','used','refurbished']},'valve_type':{'type':'string'}}],
      ['LPG Refills','lpg-refills',{'capacity_kg':{'type':'number','enum':[3,6,13,22.5,50]},'refill_type':{'type':'string','enum':['refill','exchange']},'empty_cylinder_required':{'type':'boolean'},'delivery_available':{'type':'boolean'}}],
      ['Gas Cookers','gas-cookers',{}],
      ['Gas Regulators','gas-regulators',{}],
      ['Gas Hoses & Accessories','gas-accessories',{}],
    ];
    for (let i=0;i<gasChildren.length;i++) {
      const [name,slug,attributesSchema] = gasChildren[i];
      await queryInterface.bulkInsert('marketplace_categories', [{ parent_id: gasId, name, slug, kind: 'physical', level: 3, path: `physical-products/home-kitchen/gas-lpg/${slug}`, sort_order: i, attributes_schema: attributesSchema, metadata: {}, created_at: new Date(), updated_at: new Date() }], { ignoreDuplicates: true });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('marketplace_listings');
    await queryInterface.dropTable('marketplace_variants');
    await queryInterface.dropTable('marketplace_products');
    await queryInterface.dropTable('marketplace_brands');
    await queryInterface.dropTable('marketplace_categories');
  },
};
