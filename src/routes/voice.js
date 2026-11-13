'use strict';
/**
 * NECPRA Universal Voice: server side (mounted at /api/voice by routes/index.js, JWT required by the router).
 *   GET  /config  feature flags for the voice client (no secrets, ever)
 *   POST /audit   metadata-only audit trail of voice actions. NEVER audio and NEVER transcript text (data minimisation).
 * Speech-to-text itself currently runs on the device/browser; if a server STT provider is added later, its credentials
 * stay in env vars on this backend and are never sent to the frontend or the APK.
 */
const express = require('express');
const crypto = require('crypto');
const { apiRateLimiter } = require('../middleware/rateLimiter');

const ACTION_RE = /^[a-z0-9_.-]{1,48}$/i;
const ALLOWED_OUTCOMES = new Set(['captured', 'on', 'off', 'heard', 'confirmed', 'cancelled', 'executed', 'rejected', 'error']);

function createRouter(opts = {}) {
  const router = express.Router();
  const getSequelize = opts.getSequelize || (() => require('../models').sequelize);
  const enabled = () => String(process.env.NECPRA_VOICE_ENABLED || 'true').toLowerCase() !== 'false';

  router.get('/config', apiRateLimiter, (req, res) => {
    res.json({ enabled: enabled(), sttProvider: 'device', audioRetention: 'none', maxAuditPerMinute: 60 });
  });

  router.post('/audit', apiRateLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      if (!enabled()) return res.status(503).json({ ok: false, error: 'voice_disabled' });
      if (!req.user || req.user.id == null) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const b = req.body || {};
      if (typeof b.action !== 'string' || !ACTION_RE.test(b.action)) return res.status(400).json({ ok: false, error: 'bad_action' });
      const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
      const int = (v, max) => Math.min(max, Math.max(0, Number.isFinite(+v) ? Math.trunc(+v) : 0));
      const outcome = ALLOWED_OUTCOMES.has(b.outcome) ? b.outcome : null;
      await getSequelize().query(
        `INSERT INTO voice_audit_logs (id, user_id, action, module, outcome, lang, duration_ms, char_count, request_id, ip_hash, "createdAt")
         VALUES (:id, :userId, :action, :module, :outcome, :lang, :duration, :chars, :requestId, :ipHash, NOW())`,
        { replacements: {
            id: crypto.randomUUID(), userId: String(req.user.id).slice(0, 64), action: b.action.toLowerCase(), module: str(b.module, 32), outcome,
            lang: str(b.lang, 16), duration: int(b.durationMs, 3600000), chars: int(b.chars, 100000), requestId: str(b.requestId, 64),
            ipHash: req.ip ? crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 32) : null } }
      );
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error('[voice] audit failed:', e && e.message);
      return res.status(500).json({ ok: false, error: 'audit_failed' });
    }
  });
  return router;
}

const router = createRouter();
router.create = createRouter;
module.exports = router;
