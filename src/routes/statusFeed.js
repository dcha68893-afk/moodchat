'use strict';
/**
 * src/routes/statusFeed.js
 *
 * Implements the "mood/status posts" feature documented in
 * src/routes/index.js's API listing under /api/status/* (NOT to be confused
 * with /api/user-status/* which is online-presence, implemented in
 * userStatus.js).
 *
 * BACKGROUND: a file at src/routes/status.js previously occupied the
 * `/status` mount point, but it was actually a stray byte-identical copy of
 * src/models/Status.js (a Sequelize model factory `(sequelize, DataTypes) =>
 * {...}`). The route loader called it with no arguments, which threw
 * "Cannot read properties of undefined (reading 'define')" at mount time —
 * failing the ENTIRE /status mount and causing every /api/status/* request
 * (e.g. GET /api/status/friends, called by status-api.js) to 404.
 *
 * The duplicate model file was removed; this file provides real route
 * handlers for the most-used endpoints (my statuses, friends' statuses)
 * using the existing, working src/models/Status.js and src/models/Friend.js
 * static methods. Mounted at /status — per src/routes/index.js's
 * isPublicRoute(), this mount has NO router-level auth applied ("status
 * router handles its own auth"), so authenticateToken is applied per-route
 * below for protected endpoints.
 */
const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');

const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

const _getDb = () => require('../models');
const _getStatus = () => {
    const db = _getDb();
    return db.Status;
};
const _getFriend = () => {
    const db = _getDb();
    return db.Friend;
};

function getUserId(req) {
    return req.user?.userId || req.user?.id;
}

// GET /api/status/my — current user's own statuses
router.get('/my', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const Status = _getStatus();
    if (!Status) {
        return res.status(503).json({ success: false, message: 'Status feature unavailable' });
    }

    const { activeOnly, type, moodType, limit, offset } = req.query;
    const statuses = await Status.getUserStatuses(userId, {
        activeOnly: activeOnly !== 'false',
        ...(type && { type }),
        ...(moodType && { moodType }),
        includeUser: true,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
    });

    return res.json({ success: true, data: statuses });
}));

// GET /api/status/friends — statuses from the current user's friends
// This is the endpoint status-api.js's getFriendsStatuses() calls.
router.get('/friends', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const Status = _getStatus();
    const Friend = _getFriend();

    if (!Status || !Friend) {
        return res.status(503).json({ success: false, message: 'Status feature unavailable' });
    }

    const { limit, offset } = req.query;

    const friendRows = await Friend.getUserFriends(userId, 'accepted');
    const friendIds = friendRows.map(f => (f.requesterId === userId ? f.receiverId : f.requesterId));

    if (friendIds.length === 0) {
        return res.json({ success: true, data: [] });
    }

    const statuses = await Status.getFriendsStatuses(userId, friendIds, {
        includeStats: true,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
    });

    return res.json({ success: true, data: statuses });
}));

// GET /api/status/stats — status statistics for the current user
router.get('/stats', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const Status = _getStatus();
    if (!Status) {
        return res.status(503).json({ success: false, message: 'Status feature unavailable' });
    }

    const stats = await Status.getStatusStats(userId);
    return res.json({ success: true, data: stats });
}));

// GET /api/status/user/:userId — another user's public statuses
router.get('/user/:userId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const Status = _getStatus();
    if (!Status) {
        return res.status(503).json({ success: false, message: 'Status feature unavailable' });
    }

    const targetUserId = parseInt(req.params.userId, 10);
    if (!targetUserId) {
        return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    const statuses = await Status.getUserStatuses(targetUserId, {
        activeOnly: true,
        includeUser: true,
    });

    return res.json({ success: true, data: statuses.filter(s => s.isPublic !== false) });
}));

module.exports = router;
