'use strict';

const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const db = require('../models');
const Product = db.MarketplaceProduct;
const Listing = db.MarketplaceListing;
const Category = db.MarketplaceCategory;
const Variant = db.MarketplaceVariant;

const ok = (res, data, message = 'OK', status = 200) => res.status(status).json({ success: true, message, data });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });
const userId = req => req.user?.id || req.user?.userId || req.auth?.id;

// Resolve an existing canonical product before creating another one.
// Matching is intentionally strict: name + category + product type.
router.get('/products/resolve', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const categoryId = req.query.category_id;
    const productType = req.query.type;
    if (!name || !categoryId || !productType) return fail(res, 'name, category_id and type are required');
    const product = await Product.findOne({
      where: {
        name: { [Op.iLike]: name },
        categoryId,
        productType,
        isActive: true,
      },
      include: [
        { model: Category, as: 'category', required: false },
        { model: Variant, as: 'variants', required: false, where: { isActive: true } },
      ],
    });
    return ok(res, { product: product || null });
  } catch (e) { return fail(res, e.message, 500); }
});

// Seller workspace endpoint includes pending/review listings. Public catalog
// remains /listings and only exposes active listings.
router.get('/mine', async (req, res) => {
  try {
    const sellerId = userId(req);
    if (!sellerId) return fail(res, 'Authentication required', 401);
    const rows = await Listing.findAll({
      where: { sellerId },
      include: [
        { model: Product, as: 'product', required: true, include: [
          { model: Category, as: 'category', required: false },
        ] },
        { model: Variant, as: 'variant', required: false },
      ],
      order: [['createdAt', 'DESC']],
    });
    return ok(res, { listings: rows });
  } catch (e) { return fail(res, e.message, 500); }
});

module.exports = router;
