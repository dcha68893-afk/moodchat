'use strict';
/**
 * analytics.js — Analytics & event tracking routes
 * GET  /api/analytics/dashboard     — user activity dashboard
 * GET  /api/analytics/users/:id     — per-user analytics
 * GET  /api/analytics/chats/:id     — per-chat analytics
 * POST /api/analytics/events        — track client-side events
 * GET  /api/analytics/performance   — client performance metrics store
 * GET  /api/analytics/health        — analytics service health
 * GET  /api/analytics/export        — export analytics data
 */
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter }    = require('../middleware/rateLimiter');

const ok  = (res, data = {}) => res.json({ success: true, data });
const uid = req => req.user?.id || req.user?.userId;

router.get('/health', (req, res) => ok(res, { status: 'ok', ts: new Date().toISOString() }));

router.get('/dashboard', authenticateToken, apiRateLimiter, async (req, res) => {
    try {
        const db   = req.app.locals.models;
        const data = { userId: uid(req), messages: 0, chats: 0, friends: 0, generatedAt: new Date().toISOString() };
        if (db) {
            const [[msgRow]] = await (db.sequelize || db.models?.sequelize)
                ?.query('SELECT COUNT(*) AS cnt FROM "Messages" WHERE "senderId" = :uid', { replacements: { uid: uid(req) } }) ?? [[{ cnt: 0 }]];
            data.messages = parseInt(msgRow?.cnt ?? 0);
        }
        ok(res, data);
    } catch (err) {
        ok(res, { userId: uid(req), error: err.message, generatedAt: new Date().toISOString() });
    }
});

router.get('/users/:userId', authenticateToken, apiRateLimiter, (req, res) =>
    ok(res, { userId: req.params.userId, period: req.query.timeframe || '7d', events: [] }));

router.get('/chats/:chatId', authenticateToken, apiRateLimiter, (req, res) =>
    ok(res, { chatId: req.params.chatId, timeframe: req.query.timeframe || '7d', messages: 0, activeUsers: 0 }));

router.get('/performance', authenticateToken, apiRateLimiter, (req, res) =>
    ok(res, { ttfb: null, fcp: null, lcp: null, cls: null, collected: [] }));

router.get('/export', authenticateToken, apiRateLimiter, (req, res) =>
    ok(res, { format: req.query.format || 'json', url: null, message: 'Export not yet implemented' }));

// POST /api/analytics/events — fire-and-forget event ingestion
router.post('/events', authenticateToken, apiRateLimiter, (req, res) => {
    // Silently accept events; add persistence layer when needed
    const events = Array.isArray(req.body) ? req.body : [req.body];
    res.json({ success: true, received: events.length });
});

module.exports = router;
