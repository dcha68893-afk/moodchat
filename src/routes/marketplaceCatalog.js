'use strict';

const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();

const db = require('../models');
const Category = db.MarketplaceCategory;
const Brand = db.MarketplaceBrand;
const Product = db.MarketplaceProduct;
const Variant = db.MarketplaceVariant;
const Listing = db.MarketplaceListing;

const slugify = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 280);
const ok = (res, data, message='OK', status=200) => res.status(status).json({ success: true, message, data });
const fail = (res, message, status=400) => res.status(status).json({ success: false, message });
const userId = req => req.user?.id || req.user?.userId || req.auth?.id;

// Public catalog discovery. Route-index authentication may wrap the router;
// these endpoints intentionally do not require seller/admin privileges.
router.get('/categories', async (req, res) => {
  try {
    if (!Category) return ok(res, { categories: [] });
    const rows = await Category.findAll({ where: { isActive: true }, order: [['level','ASC'],['sortOrder','ASC'],['name','ASC']] });
    return ok(res, { categories: rows });
  } catch (e) { return fail(res, e.message, 500); }
});

router.get('/brands', async (req, res) => {
  try {
    if (!Brand) return ok(res, { brands: [] });
    const rows = await Brand.findAll({ where: { isActive: true }, order: [['name','ASC']], limit: Math.min(Number(req.query.limit)||200, 500) });
    return ok(res, { brands: rows });
  } catch (e) { return fail(res, e.message, 500); }
});

router.get('/products', async (req, res) => {
  try {
    if (!Product || !Listing) return ok(res, { products: [], listings: [], total: 0 });
    const page = Math.max(1, Number(req.query.page)||1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit)||24));
    const where = { isActive: true };
    if (req.query.type) where.productType = req.query.type;
    if (req.query.category_id) where.categoryId = req.query.category_id;
    if (req.query.brand_id) where.brandId = req.query.brand_id;
    if (req.query.q) where.name = { [Op.iLike]: `%${String(req.query.q).trim()}%` };

    const result = await Product.findAndCountAll({
      where,
      include: [
        { model: Category, as: 'category', required: false },
        { model: Brand, as: 'brand', required: false },
        { model: Variant, as: 'variants', required: false, where: { isActive: true } },
      ],
      order: [['createdAt','DESC']],
      limit,
      offset: (page-1)*limit,
      distinct: true,
    });
    return ok(res, { products: result.rows, total: result.count, page, limit, totalPages: Math.ceil(result.count/limit) });
  } catch (e) { return fail(res, e.message, 500); }
});

router.get('/products/:id', async (req, res) => {
  try {
    if (!Product) return fail(res, 'Catalog unavailable', 503);
    const product = await Product.findByPk(req.params.id, {
      include: [
        { model: Category, as: 'category', required: false },
        { model: Brand, as: 'brand', required: false },
        { model: Variant, as: 'variants', required: false, where: { isActive: true } },
        { model: Listing, as: 'listings', required: false, where: { status: 'active' } },
      ],
    });
    if (!product) return fail(res, 'Product not found', 404);
    return ok(res, { product });
  } catch (e) { return fail(res, e.message, 500); }
});

// Canonical seller listing search. This is the Jumia-style layer where price,
// stock, fulfillment and seller-specific data belong; Product remains canonical.
router.get('/listings', async (req, res) => {
  try {
    if (!Listing) return ok(res, { listings: [], total: 0 });
    const page = Math.max(1, Number(req.query.page)||1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit)||24));
    const where = { status: 'active' };
    if (req.query.seller_id) where.sellerId = req.query.seller_id;
    if (req.query.min_price || req.query.max_price) {
      where.price = {};
      if (req.query.min_price) where.price[Op.gte] = Number(req.query.min_price);
      if (req.query.max_price) where.price[Op.lte] = Number(req.query.max_price);
    }
    if (req.query.type) where['$product.productType$'] = req.query.type;
    const rows = await Listing.findAndCountAll({
      where,
      include: [
        { model: Product, as: 'product', required: true, include: [
          { model: Category, as: 'category', required: false },
          { model: Brand, as: 'brand', required: false },
        ] },
        { model: Variant, as: 'variant', required: false },
      ],
      order: [['createdAt','DESC']], limit, offset: (page-1)*limit, distinct: true,
    });
    return ok(res, { listings: rows.rows, total: rows.count, page, limit, totalPages: Math.ceil(rows.count/limit) });
  } catch (e) { return fail(res, e.message, 500); }
});

router.post('/products', async (req, res) => {
  try {
    const owner = userId(req);
    if (!owner) return fail(res, 'Authentication required', 401);
    if (!Product) return fail(res, 'Catalog unavailable', 503);
    const { name, category_id, brand_id, product_type='physical', model, manufacturer_part_number, description, default_image_url, attributes={}, metadata={} } = req.body || {};
    if (!name || !category_id) return fail(res, 'name and category_id are required');
    if (!['physical','service','digital'].includes(product_type)) return fail(res, 'Invalid product_type');
    const category = Category ? await Category.findByPk(category_id) : null;
    if (!category || category.kind !== product_type) return fail(res, 'Category does not match product type', 400);
    const slugBase = slugify(`${name}-${model || ''}`) || `product-${Date.now()}`;
    let slug = slugBase; let suffix = 1;
    while (await Product.findOne({ where: { slug } })) slug = `${slugBase}-${suffix++}`;
    const product = await Product.create({ categoryId: category_id, brandId: brand_id || null, name, slug, productType: product_type, model: model || null, manufacturerPartNumber: manufacturer_part_number || null, description: description || null, defaultImageUrl: default_image_url || null, attributes, metadata: { ...metadata, created_by: owner } });
    return ok(res, { product }, 'Product created', 201);
  } catch (e) { return fail(res, e.message, 500); }
});

router.post('/products/:id/variants', async (req, res) => {
  try {
    if (!Variant || !Product) return fail(res, 'Catalog unavailable', 503);
    const owner = userId(req); if (!owner) return fail(res, 'Authentication required', 401);
    const product = await Product.findByPk(req.params.id); if (!product) return fail(res, 'Product not found', 404);
    const { sku, name, option_values={}, image_urls=[], price, stock, weight_grams, metadata={} } = req.body || {};
    if (!sku) return fail(res, 'sku is required');
    const variant = await Variant.create({ productId: product.id, sku, name: name || null, optionValues: option_values, imageUrls: image_urls, price: price == null ? null : Number(price), stock: stock == null ? null : Number(stock), weightGrams: weight_grams == null ? null : Number(weight_grams), metadata: { ...metadata, created_by: owner } });
    return ok(res, { variant }, 'Variant created', 201);
  } catch (e) { return fail(res, e.message, 500); }
});

router.post('/listings', async (req, res) => {
  try {
    if (!Listing || !Product) return fail(res, 'Catalog unavailable', 503);
    const seller = userId(req); if (!seller) return fail(res, 'Authentication required', 401);
    const { product_id, variant_id, title_override, price, currency='KES', stock, condition='new', fulfillment_type='delivery', service_area={}, digital_access={}, images=[], attributes={}, metadata={} } = req.body || {};
    if (!product_id || price == null) return fail(res, 'product_id and price are required');
    const product = await Product.findByPk(product_id); if (!product) return fail(res, 'Product not found', 404);
    if (variant_id) { const variant = await Variant.findOne({ where: { id: variant_id, productId: product_id, isActive: true } }); if (!variant) return fail(res, 'Variant does not belong to product', 400); }
    const allowedFulfillment = product.productType === 'service' ? ['appointment','delivery','both'] : product.productType === 'digital' ? ['instant_download'] : ['delivery','pickup','both'];
    if (!allowedFulfillment.includes(fulfillment_type)) return fail(res, `Invalid fulfillment_type for ${product.productType}`, 400);
    const listing = await Listing.create({ productId: product_id, variantId: variant_id || null, sellerId: seller, titleOverride: title_override || null, price: Number(price), currency, stock: stock == null ? null : Number(stock), condition, fulfillmentType: fulfillment_type, serviceArea: service_area, digitalAccess: digital_access, images, attributes, status: 'pending_review', metadata });
    return ok(res, { listing }, 'Listing submitted for review', 201);
  } catch (e) { return fail(res, e.message, 500); }
});

router.patch('/listings/:id', async (req, res) => {
  try {
    if (!Listing) return fail(res, 'Catalog unavailable', 503);
    const seller = userId(req); if (!seller) return fail(res, 'Authentication required', 401);
    const listing = await Listing.findOne({ where: { id: req.params.id, sellerId: seller } });
    if (!listing) return fail(res, 'Listing not found', 404);
    const allowed = ['titleOverride','price','currency','stock','condition','fulfillmentType','serviceArea','digitalAccess','images','attributes','metadata'];
    const updates = {}; for (const key of allowed) if (req.body?.[key] !== undefined) updates[key] = req.body[key];
    await listing.update({ ...updates, status: 'pending_review' });
    return ok(res, { listing }, 'Listing updated and resubmitted');
  } catch (e) { return fail(res, e.message, 500); }
});

router.delete('/listings/:id', async (req, res) => {
  try {
    if (!Listing) return fail(res, 'Catalog unavailable', 503);
    const seller = userId(req); if (!seller) return fail(res, 'Authentication required', 401);
    const listing = await Listing.findOne({ where: { id: req.params.id, sellerId: seller } });
    if (!listing) return fail(res, 'Listing not found', 404);
    await listing.update({ status: 'deleted' });
    return ok(res, null, 'Listing deleted');
  } catch (e) { return fail(res, e.message, 500); }
});

module.exports = router;
