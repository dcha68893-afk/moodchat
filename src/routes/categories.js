'use strict';
/**
 * categories.js — Marketplace category routes
 * GET /api/categories — list all categories
 */
const express = require('express');
const router = express.Router();

const DEFAULT_CATEGORIES = [
    { id: 1, name: 'Electronics',   slug: 'electronics' },
    { id: 2, name: 'Fashion',       slug: 'fashion' },
    { id: 3, name: 'Home & Garden', slug: 'home-garden' },
    { id: 4, name: 'Sports',        slug: 'sports' },
    { id: 5, name: 'Books',         slug: 'books' },
    { id: 6, name: 'Services',      slug: 'services' },
];

router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.models;
        if (db && db.Category) {
            const cats = await db.Category.findAll({ order: [['name', 'ASC']] });
            return res.json({ success: true, data: cats });
        }
        return res.json({ success: true, data: DEFAULT_CATEGORIES });
    } catch (err) {
        return res.json({ success: true, data: DEFAULT_CATEGORIES });
    }
});

module.exports = router;
