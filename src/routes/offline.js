'use strict';
/**
 * offline.js: offline queue endpoint
 * POST /api/offline/process: HONEST acknowledgement of queued items.
 *
 * History: this used to count every item as "processed" without doing anything, so the client deleted queued items that were never
 * delivered. It still does not replay arbitrary requests (replaying user-supplied URLs through the server would bypass each route's own
 * validation and authentication). What changed is that it no longer lies:
 *   - every item gets its own result: { id, acknowledged:true, executed:false } for harmless generic items, so the client knows nothing ran;
 *   - anything that looks financial (wallet, money, payments, STK, withdrawals, contributions, transfers) is REFUSED with 422
 *     'financial_requires_authoritative_backend'. A queued payment must be re-submitted by the client to its own authenticated,
 *     idempotent endpoint after reconnecting; it is never assumed to have succeeded.
 */
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter }    = require('../middleware/rateLimiter');

const FINANCIAL_RE = /(wallet|money|payment|payments|stk|mpesa|withdraw|transfer|contribut|airtime|payout|refund|checkout|circle)/i;
const MAX_ITEMS = 50;

function isFinancial(item) {
    if (!item || typeof item !== 'object') return false;
    const hay = [item.url, item.endpoint, item.path, item.type, item.action, item.kind].filter((v) => typeof v === 'string').join(' ');
    return FINANCIAL_RE.test(hay);
}

router.post('/process', authenticateToken, apiRateLimiter, async (req, res) => {
    const raw = Array.isArray(req.body) ? req.body : (Array.isArray(req.body && req.body.items) ? req.body.items : (req.body && typeof req.body === 'object' ? [req.body] : []));
    const items = raw.slice(0, MAX_ITEMS);
    const results = items.map((item, i) => {
        const id = item && item.id != null ? String(item.id).slice(0, 64) : String(i);
        if (isFinancial(item)) return { id, acknowledged: false, executed: false, error: 'financial_requires_authoritative_backend' };
        return { id, acknowledged: true, executed: false };
    });
    const refused = results.filter((r) => r.error).length;
    const body = { success: refused === 0, data: { processed: 0, executed: 0, acknowledged: results.length - refused, refused, results, note: 'No queued request was replayed by this endpoint. Financial items must be re-sent to their own endpoint after reconnecting.' } };
    if (refused && refused === results.length) return res.status(422).json(Object.assign(body, { error: 'financial_requires_authoritative_backend' }));
    return res.json(body);
});

// GET /api/offline/status: check if offline queue endpoint is alive
router.get('/status', authenticateToken, (req, res) =>
    res.json({ success: true, data: { online: true, queueSupported: true, replaysRequests: false } }));

module.exports = router;
