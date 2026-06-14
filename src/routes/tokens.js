'use strict';
/**
 * tokens.js — Token management routes
 * GET /api/tokens/validate — validate the current bearer token
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

router.get('/validate', authenticateToken, (req, res) => {
    return res.json({
        success: true,
        valid: true,
        user: {
            userId: req.user.userId || req.user.id,
            email: req.user.email,
            username: req.user.username,
            role: req.user.role,
        }
    });
});

module.exports = router;
