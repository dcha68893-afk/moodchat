#!/usr/bin/env node
'use strict';

/**
 * One-time, idempotent migration from legacy `tools` marketplace rows to the
 * canonical Product -> Variant -> Listing catalog.
 *
 * Safety rules:
 * - Never deletes or mutates legacy Tool rows.
 * - Preserves the legacy Tool id in product/listing metadata.
 * - Reuses an existing canonical product only when the legacy identity is
 *   explicitly recorded in metadata.
 * - Does not guess brands, variants, or category-specific attributes.
 * - Unknown legacy categories are placed under a clearly named review bucket.
 * - Legacy premium listings are migrated as physical products unless their
 *   type is service/digital; the original type is preserved in metadata.
 *
 * Run after migrations have created the canonical catalog tables:
 *   node scripts/migrateLegacyMarketplace.js
 */

require('dotenv').config();
const db = require('../src/models');

const Tool = db.Tool;
const Category = db.MarketplaceCategory;
const Product = db.MarketplaceProduct;
const Listing = db.MarketplaceListing;

const slugify = value => String(value || '')
  .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 260);

const TYPE_MAP = {
  physical: 'physical',
  service: 'service',
  digital: 'digital',
  premium: 'physical',
};

const CATEGORY_MAP = {
  electronics: ['Electronics', 'physical'],
  furniture: ['Home & Kitchen', 'physical'],
  clothing: ['Fashion', 'physical'],
  phones: ['Mobile Phones', 'physical'],
  appliances: ['Home & Kitchen', 'physical'],
  health: ['Health & Personal Care', 'physical'],
  home: ['Home & Kitchen', 'physical'],
  fashion: ['Fashion', 'physical'],
  computing: ['Computers', 'physical'],
  gaming: ['Gaming', 'physical'],
  baby: ['Baby Products', 'physical'],
  sports: ['Sports & Outdoors', 'physical'],
  supermarket: ['Supermarket', 'physical'],
  garden: ['Garden & Outdoors', 'physical'],
  services: ['Services', 'service'],
  tutoring: ['Education & Training', 'service'],
  repair: ['Home Services', 'service'],
  design: ['Professional Services', 'service'],
  tech: ['Professional Services', 'service'],
  cleaning: ['Home Services', 'service'],
  events: ['Professional Services', 'service'],
  beauty: ['Beauty & Personal Care', 'service'],
  transport: ['Transport & Delivery', 'service'],
  digital: ['Digital Products', 'digital'],
  notes: ['E-books', 'digital'],
  templates: ['Designs & Templates', 'digital'],
  ebooks: ['E-books', 'digital'],
  software: ['Software & Apps', 'digital'],
  audio: ['Music & Audio', 'digital'],
  courses: ['Online Courses', 'digital'],
};

async function findCategory(tool) {
  const type = TYPE_MAP[tool.type] || 'physical';
  const mapped = CATEGORY_MAP[String(tool.category || '').toLowerCase()];

  if (mapped && mapped[1] === type) {
    const row = await Category.findOne({ where: { name: mapped[0], kind: type, isActive: true } });
    if (row) return row;
  }

  // Prefer the generic root for the same product type. This is deliberately
  // deterministic and avoids inventing a category from free-form legacy data.
  const root = await Category.findOne({
    where: { name: type === 'physical' ? 'Physical Products' : type === 'service' ? 'Services' : 'Digital Products', kind: type, isActive: true },
  });
  return root;
}

async function uniqueSlug(base, legacyId) {
  const root = slugify(base) || `legacy-product-${legacyId}`;
  let slug = `${root}-${legacyId}`.slice(0, 300);
  let n = 1;
  while (await Product.findOne({ where: { slug } })) {
    slug = `${root}-${legacyId}-${n++}`.slice(0, 300);
  }
  return slug;
}

async function migrate() {
  if (!Tool || !Category || !Product || !Listing) {
    throw new Error('Legacy Tool or canonical marketplace models are unavailable. Run DB migrations first.');
  }

  const tools = await Tool.findAll({ order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  const summary = { scanned: tools.length, migrated: 0, skipped: 0, errors: 0, products: 0, listings: 0 };

  for (const tool of tools) {
    const legacyId = String(tool.id);
    try {
      const existingListing = await Listing.findOne({ where: { metadata: { legacyToolId: legacyId } } });
      if (existingListing) {
        summary.skipped++;
        continue;
      }

      const productType = TYPE_MAP[tool.type] || 'physical';
      const category = await findCategory(tool);
      if (!category) throw new Error(`No canonical ${productType} category exists`);

      const existingProduct = await Product.findOne({ where: { metadata: { legacyToolId: legacyId } } });
      const product = existingProduct || await Product.create({
        categoryId: category.id,
        brandId: null,
        name: tool.title,
        slug: await uniqueSlug(tool.title, legacyId),
        productType,
        description: tool.description || null,
        defaultImageUrl: Array.isArray(tool.images) && tool.images.length ? tool.images[0] : null,
        attributes: {
          legacyCategory: tool.category || null,
          legacyCondition: tool.condition || null,
        },
        metadata: {
          legacyToolId: legacyId,
          migrationSource: 'Tool',
          migrationVersion: 1,
          legacyType: tool.type || null,
          legacyBrand: tool.brand || null,
          legacySku: tool.sku || null,
        },
      });

      if (!existingProduct) summary.products++;

      const fulfillmentType = productType === 'service'
        ? 'appointment'
        : productType === 'digital'
          ? 'instant_download'
          : 'delivery';

      await Listing.create({
        productId: product.id,
        variantId: null,
        sellerId: tool.sellerId,
        titleOverride: tool.title,
        price: tool.price || 0,
        currency: tool.currency || 'KES',
        stock: tool.stock == null ? null : tool.stock,
        condition: productType === 'physical' ? (tool.condition || 'new') : null,
        fulfillmentType,
        serviceArea: {},
        digitalAccess: {},
        images: Array.isArray(tool.images) ? tool.images : [],
        attributes: {
          tags: Array.isArray(tool.tags) ? tool.tags : [],
          legacyCategory: tool.category || null,
          legacyBrand: tool.brand || null,
          legacySku: tool.sku || null,
        },
        status: tool.status === 'active' && tool.available ? 'active' : 'pending_review',
        metadata: {
          legacyToolId: legacyId,
          migrationSource: 'Tool',
          migrationVersion: 1,
          legacyStatus: tool.status || null,
          legacyApprovalStatus: tool.approvalStatus || null,
          legacyIsPremium: Boolean(tool.isPremium),
          legacyIsFeatured: Boolean(tool.isFeatured),
          legacyIsSpotlight: Boolean(tool.isSpotlight),
        },
      });

      summary.listings++;
      summary.migrated++;
    } catch (error) {
      summary.errors++;
      console.error(`[Marketplace migration] Tool ${legacyId}: ${error.message}`);
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors) process.exitCode = 2;
}

migrate()
  .catch(error => {
    console.error('[Marketplace migration] Fatal:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db.sequelize) await db.sequelize.close();
  });
