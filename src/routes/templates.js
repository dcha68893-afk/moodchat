'use strict';
/**
 * templates.js — Message/group template routes
 * GET /api/templates — list templates for current user
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, async (req, res) => {
    try {
        const db = req.app.locals.models;
        if (db && db.Template) {
            const templates = await db.Template.findAll({
                where: { userId: req.user.userId || req.user.id },
                order: [['createdAt', 'DESC']],
            });
            return res.json({ success: true, data: templates });
        }
        return res.json({ success: true, data: [] });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
