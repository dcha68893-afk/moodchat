'use strict';

module.exports = {
  async up(queryInterface) {
    const insertChildren = async (parentSlug, rows) => {
      const [parents] = await queryInterface.sequelize.query(`SELECT id FROM marketplace_categories WHERE slug=:slug LIMIT 1`, { replacements: { slug: parentSlug } });
      const parent = parents[0];
      if (!parent) return;
      for (const row of rows) {
        const [existing] = await queryInterface.sequelize.query(`SELECT id FROM marketplace_categories WHERE slug=:slug LIMIT 1`, { replacements: { slug: row.slug } });
        if (existing.length) continue;
        await queryInterface.bulkInsert('marketplace_categories', [{
          parent_id: parent.id, name: row.name, slug: row.slug, kind: row.kind || 'physical', level: row.level, path: row.path, icon: row.icon || null,
          sort_order: row.sortOrder || 0, attributes_schema: row.attributesSchema || {}, metadata: {}, created_at: new Date(), updated_at: new Date(),
        }]);
      }
    };

    await insertChildren('electronics', [
      { name:'Mobile Phones', slug:'mobile-phones', level:2, path:'physical-products/electronics/mobile-phones', icon:'📱' },
      { name:'Laptops', slug:'laptops', level:2, path:'physical-products/electronics/laptops', icon:'💻' },
      { name:'TVs', slug:'tvs', level:2, path:'physical-products/electronics/tvs', icon:'📺' },
      { name:'Audio', slug:'audio', level:2, path:'physical-products/electronics/audio', icon:'🎧' },
    ]);

    await insertChildren('mobile-phones', [
      { name:'Smartphones', slug:'smartphones', level:3, path:'physical-products/electronics/mobile-phones/smartphones', icon:'📱', attributesSchema:{brand:{type:'string'},model:{type:'string'},storage_gb:{type:'number'},ram_gb:{type:'number'},color:{type:'string'},condition:{type:'string'}} },
      { name:'Feature Phones', slug:'feature-phones', level:3, path:'physical-products/electronics/mobile-phones/feature-phones', icon:'☎️' },
      { name:'Phone Accessories', slug:'phone-accessories', level:3, path:'physical-products/electronics/mobile-phones/phone-accessories', icon:'🔌' },
    ]);

    await insertChildren('services', [
      { name:'Home Services', slug:'home-services', kind:'service', level:1, path:'services/home-services', icon:'🏠' },
      { name:'Professional Services', slug:'professional-services', kind:'service', level:1, path:'services/professional-services', icon:'💼' },
      { name:'Beauty & Personal Care', slug:'beauty-personal-care-services', kind:'service', level:1, path:'services/beauty-personal-care-services', icon:'💇' },
      { name:'Transport & Delivery', slug:'transport-delivery-services', kind:'service', level:1, path:'services/transport-delivery-services', icon:'🚚' },
      { name:'Education & Training', slug:'education-training-services', kind:'service', level:1, path:'services/education-training-services', icon:'🎓' },
    ]);

    await insertChildren('digital-products', [
      { name:'Software & Apps', slug:'software-apps', kind:'digital', level:1, path:'digital-products/software-apps', icon:'🖥️' },
      { name:'E-books', slug:'ebooks', kind:'digital', level:1, path:'digital-products/ebooks', icon:'📚' },
      { name:'Online Courses', slug:'online-courses', kind:'digital', level:1, path:'digital-products/online-courses', icon:'🎓' },
      { name:'Designs & Templates', slug:'designs-templates', kind:'digital', level:1, path:'digital-products/designs-templates', icon:'🎨' },
      { name:'Music & Audio', slug:'digital-music-audio', kind:'digital', level:1, path:'digital-products/digital-music-audio', icon:'🎵' },
    ]);

    await insertChildren('gas-cylinders', [
      { name:'3kg Gas Cylinders', slug:'gas-cylinders-3kg', level:4, path:'physical-products/home-kitchen/gas-lpg/gas-cylinders/3kg', icon:'🔥', attributesSchema:{capacity_kg:{type:'number',const:3},brand:{type:'string'},condition:{type:'string'}} },
      { name:'6kg Gas Cylinders', slug:'gas-cylinders-6kg', level:4, path:'physical-products/home-kitchen/gas-lpg/gas-cylinders/6kg', icon:'🔥', attributesSchema:{capacity_kg:{type:'number',const:6},brand:{type:'string'},condition:{type:'string'}} },
      { name:'13kg Gas Cylinders', slug:'gas-cylinders-13kg', level:4, path:'physical-products/home-kitchen/gas-lpg/gas-cylinders/13kg', icon:'🔥', attributesSchema:{capacity_kg:{type:'number',const:13},brand:{type:'string'},condition:{type:'string'}} },
      { name:'22.5kg Gas Cylinders', slug:'gas-cylinders-22-5kg', level:4, path:'physical-products/home-kitchen/gas-lpg/gas-cylinders/22-5kg', icon:'🔥', attributesSchema:{capacity_kg:{type:'number',const:22.5},brand:{type:'string'},condition:{type:'string'}} },
      { name:'50kg Gas Cylinders', slug:'gas-cylinders-50kg', level:4, path:'physical-products/home-kitchen/gas-lpg/gas-cylinders/50kg', icon:'🔥', attributesSchema:{capacity_kg:{type:'number',const:50},brand:{type:'string'},condition:{type:'string'}} },
    ]);
  },

  async down(queryInterface) {
    const slugs = ['gas-cylinders-3kg','gas-cylinders-6kg','gas-cylinders-13kg','gas-cylinders-22-5kg','gas-cylinders-50kg','mobile-phones','laptops','tvs','audio','smartphones','feature-phones','phone-accessories','home-services','professional-services','beauty-personal-care-services','transport-delivery-services','education-training-services','software-apps','ebooks','online-courses','designs-templates','digital-music-audio'];
    await queryInterface.sequelize.query(`DELETE FROM marketplace_categories WHERE slug IN (:slugs)`, { replacements:{ slugs } });
  },
};
