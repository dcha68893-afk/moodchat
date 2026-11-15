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
const voiceUnderstand = require('../services/voiceUnderstand');
const voicePhrases = require('../services/voicePhrases');
const voiceActions = require('../services/voiceActions');

const ACTION_RE = /^[a-z0-9_.-]{1,48}$/i;
const ALLOWED_OUTCOMES = new Set(['captured', 'on', 'off', 'heard', 'confirmed', 'cancelled', 'executed', 'rejected', 'error']);

function createRouter(opts = {}) {
  const router = express.Router();
  const getSequelize = opts.getSequelize || (() => require('../models').sequelize);
  const enabled = () => String(process.env.NECPRA_VOICE_ENABLED || 'true').toLowerCase() !== 'false';

  router.get('/config', apiRateLimiter, (req, res) => {
    res.json({ enabled: enabled(), sttProvider: 'device', audioRetention: 'none', maxAuditPerMinute: 60, understand: enabled() && voiceUnderstand.enabled(), phrases: true });
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

  /* POST /understand  { transcript, alternatives?, page?, lang? }  ->  { ok, understood, phrase?, id?, module?, confidence? }
   * The AI only CHOOSES one action from the registry (services/voiceActions.js); the server returns a canonical phrase that the existing
   * on-screen voice handlers already parse (and which keep all their confirmations). Text is never stored or logged. Per-user limits below. */
  const usage = new Map();   // userId -> { minute:[timestamps], day:{key,count} }   (per process; fine for a single instance, soft limit when clustered)
  const PER_MIN = Number(process.env.NECPRA_VOICE_UNDERSTAND_PER_MIN || 20), PER_DAY = Number(process.env.NECPRA_VOICE_UNDERSTAND_PER_DAY || 300);
  function allowed(uid) {
    const now = Date.now(), dayKey = new Date(now).toISOString().slice(0, 10);
    let u = usage.get(uid); if (!u) { u = { minute: [], day: { key: dayKey, count: 0 } }; usage.set(uid, u); }
    u.minute = u.minute.filter((t) => now - t < 60000); if (u.day.key !== dayKey) u.day = { key: dayKey, count: 0 };
    if (u.minute.length >= PER_MIN || u.day.count >= PER_DAY) return false;
    u.minute.push(now); u.day.count++;
    if (usage.size > 5000) { for (const [k, v] of usage) { if (!v.minute.length) usage.delete(k); if (usage.size <= 4000) break; } }
    return true;
  }
  router.post('/understand', apiRateLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      if (!enabled() || !voiceUnderstand.enabled()) return res.status(503).json({ ok: false, error: 'understand_disabled' });
      if (!req.user || req.user.id == null) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const b = req.body || {};
      if (typeof b.transcript !== 'string' || !b.transcript.trim() || b.transcript.length > 300) return res.status(400).json({ ok: false, error: 'bad_transcript' });
      if (!allowed(String(req.user.id))) return res.status(429).json({ ok: false, error: 'rate_limited' });
      const out = await (opts.understand || voiceUnderstand.understand)({ transcript: b.transcript.trim(), alternatives: b.alternatives, page: b.page, lang: b.lang });
      if (!out.ok) return res.status(out.error === 'not_configured' ? 503 : 502).json({ ok: false, error: out.error });
      return res.json(out);
    } catch (e) {
      console.error('[voice] understand failed:', e && e.message);   // message only, never the transcript
      return res.status(500).json({ ok: false, error: 'understand_failed' });
    }
  });

  /* ───── Admin-taught phrases ─────
   * GET    /phrases            any signed-in user: the active list (cached on the phone). ?since=<version> -> {unchanged:true} when nothing changed.
   * GET    /phrases/admin      admin: everything (incl. switched-off) + who made it
   * GET    /phrases/actions    admin: the actions a phrase may trigger
   * POST   /phrases            admin: add            PATCH /phrases/:id  admin: edit / switch on or off        DELETE /phrases/:id  admin: remove
   * Admins pick from the known action list or write a fixed reply. Nothing else can be configured. */
  let _store = opts.phraseStore || null, _cache = null;
  const store = () => (_store = _store || voicePhrases.createStore(require('../models').sequelize));
  const callerId = (req) => Number(req.user && (req.user.userId || req.user.id)) || null;
  async function isAdminReq(req) {
    if (opts.isAdmin) return opts.isAdmin(req);
    const id = callerId(req); if (!id) return false;
    if (String(process.env.ADMIN_USER_IDS || '').split(',').map((v) => Number(v.trim())).filter(Number.isFinite).includes(id)) return true;
    const u = await require('../models').Users.findByPk(id, { attributes: ['id', 'role'] }).catch(() => null);
    return ['admin', 'superadmin', 'administrator'].includes(String(u && u.role || '').toLowerCase());
  }
  const adminOnly = async (req, res, next) => { try { if (!(await isAdminReq(req))) return res.status(403).json({ ok: false, error: 'Admin access required' }); next(); } catch (e) { res.status(500).json({ ok: false, error: 'admin_check_failed' }); } };
  const bust = () => { _cache = null; };
  const fail = (res, e, msg) => { console.error('[voice] ' + msg + ':', e && e.message); res.status(500).json({ ok: false, error: msg }); };

  router.get('/phrases', apiRateLimiter, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (!_cache || Date.now() - _cache.at > 30000) _cache = Object.assign(await store().publicList(), { at: Date.now() });
      if (req.query.since && String(req.query.since) === _cache.version) return res.json({ ok: true, unchanged: true, version: _cache.version });
      res.json({ ok: true, version: _cache.version, phrases: _cache.phrases });
    } catch (e) { fail(res, e, 'phrases_failed'); }
  });
  router.get('/phrases/actions', apiRateLimiter, adminOnly, (req, res) => res.json({ ok: true, actions: voiceActions.describe() }));
  router.get('/phrases/admin', apiRateLimiter, adminOnly, async (req, res) => { try { res.json({ ok: true, phrases: await store().listAll() }); } catch (e) { fail(res, e, 'phrases_failed'); } });
  router.post('/phrases', apiRateLimiter, adminOnly, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const v = voicePhrases.validateInput(req.body); if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
      const r = await store().create(v.value, callerId(req)); if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.error });
      bust(); res.status(201).json({ ok: true, phrase: r.row });
    } catch (e) { fail(res, e, 'phrases_failed'); }
  });
  router.patch('/phrases/:id', apiRateLimiter, adminOnly, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const id = Number(req.params.id); if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'bad_id' });
      const b = req.body || {}; let value = null;
      if (b.phrase !== undefined || b.kind !== undefined) { const v = voicePhrases.validateInput(b); if (!v.ok) return res.status(400).json({ ok: false, error: v.error }); value = v.value; }
      const r = await store().update(id, value, callerId(req), typeof b.active === 'boolean' ? b.active : undefined);
      if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.error });
      bust(); res.json({ ok: true, phrase: r.row });
    } catch (e) { fail(res, e, 'phrases_failed'); }
  });
  router.delete('/phrases/:id', apiRateLimiter, adminOnly, async (req, res) => {
    try {
      const id = Number(req.params.id); if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'bad_id' });
      const r = await store().remove(id); if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.error });
      bust(); res.json({ ok: true });
    } catch (e) { fail(res, e, 'phrases_failed'); }
  });
  return router;
}

const router = createRouter();
router.create = createRouter;
module.exports = router;
