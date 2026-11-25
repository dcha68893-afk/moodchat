'use strict';
/**
 * NECPRA Intelligence API (mounted at /api/intelligence by routes/index.js; JWT required by the mount AND re-checked here).
 *   GET  /config                     feature flags (no secrets)
 *   POST /ask        { text, lang?, page?, shopId? }  -> engine result (answer | action | prepare | clarify | unknown)
 *   POST /risk/assess { kind, amount, counterparty?, purpose?, expectedAmount?, deviceId? } -> score + reasons (records an audit row; NEVER blocks or moves money)
 *   POST /risk/:id/resolve { outcome: 'ok'|'report', note? }   the user's own answer to a warning (false-positive path)
 *   GET  /risk                       the caller's own recent risk events
 *   /marketplace/*  and  /reminders/*  see the sections below
 * Every handler is scoped to req.user.id. No endpoint accepts a userId from the client.
 */
const express = require('express');
const crypto = require('crypto');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { createEngine } = require('../services/intelligence/engine');
const { createTools } = require('../services/intelligence/tools');
const risk = require('../services/intelligence/risk');
const marketplace = require('../services/intelligence/marketplace');
const remindersLib = require('../services/intelligence/reminders');

const enabled = () => String(process.env.NECPRA_AI_ENABLED || 'true').toLowerCase() !== 'false';
const KINDS = new Set(['transfer', 'withdrawal', 'money_request', 'contribution', 'stk', 'payment']);
const PER_MIN = Number(process.env.NECPRA_AI_PER_MIN || 30), PER_DAY = Number(process.env.NECPRA_AI_PER_DAY || 1000);

function createRouter(opts = {}) {
  const router = express.Router();
  const getSequelize = opts.getSequelize || (() => require('../models').sequelize);
  const baseTools = opts.tools || createTools({ getSequelize });
  const mkt = opts.marketplace || marketplace.createService({ getSequelize });
  const mktTools = marketplace.voiceTools(mkt);
  const tools = { run: (name, args) => (String(name).startsWith('market.') ? mktTools.run(name, args) : baseTools.run(name, args)) };   // marketplace tools are read-only and caller-scoped too
  const remSvc = opts.reminders || remindersLib.createService({ getSequelize });
  const engine = opts.engine || createEngine({ tools, reminders: remSvc, llm: opts.llm || require('../services/intelligence/llm').adapter() });
  const riskSvc = opts.risk || risk.createService({ getSequelize });
  const authenticate = opts.authenticate || ((req, res, next) => require('../middleware/auth').authenticateToken(req, res, next));
  const limiter = opts.rateLimiter || apiRateLimiter;
  const uidOf = (req) => (req.user && (req.user.id != null ? req.user.id : req.user.userId));

  router.use(authenticate);
  router.use((req, res, next) => { if (uidOf(req) == null) return res.status(401).json({ ok: false, error: 'unauthorized' }); next(); });

  // per-user quota (AI endpoints are rate-limited per user on top of the IP limiter)
  const usage = new Map();
  function allowed(uid) {
    const t = Date.now(), day = new Date(t).toISOString().slice(0, 10);
    let u = usage.get(uid); if (!u) { u = { m: [], d: { k: day, n: 0 } }; usage.set(uid, u); }
    u.m = u.m.filter((x) => t - x < 60000); if (u.d.k !== day) u.d = { k: day, n: 0 };
    if (u.m.length >= PER_MIN || u.d.n >= PER_DAY) return false;
    u.m.push(t); u.d.n++;
    if (usage.size > 5000) { for (const [k, v] of usage) { if (!v.m.length) usage.delete(k); if (usage.size <= 4000) break; } }
    return true;
  }

  router.get('/config', limiter, (req, res) => res.json({ ok: true, enabled: enabled(), engine: 'necpra-intelligence', externalAI: false, localModel: !!process.env.NECPRA_LOCAL_LLM_URL, riskMode: process.env.NECPRA_RISK_MODE || 'observe' }));

  router.post('/ask', limiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      if (!enabled()) return res.status(503).json({ ok: false, error: 'ai_disabled' });
      const b = req.body || {};
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 300) return res.status(400).json({ ok: false, error: 'bad_text' });
      const uid = String(uidOf(req));
      if (!allowed(uid)) return res.status(429).json({ ok: false, error: 'rate_limited' });
      const out = await engine.handle({ userId: uidOf(req), text: b.text, lang: typeof b.lang === 'string' ? b.lang.slice(0, 12) : undefined, page: typeof b.page === 'string' ? b.page.slice(0, 24) : undefined, shopId: typeof b.shopId === 'string' ? b.shopId.slice(0, 64) : undefined });
      return res.json(Object.assign({ ok: out.type !== 'error' }, out));
    } catch (e) { console.error('[intelligence] ask failed:', e && e.message); return res.status(500).json({ ok: false, error: 'ask_failed' }); }   // message only, never the text
  });

  router.post('/risk/assess', limiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
      if (!enabled()) return res.status(503).json({ ok: false, error: 'ai_disabled' });
      const b = req.body || {}, amount = Number(b.amount);
      if (!KINDS.has(b.kind) || !Number.isFinite(amount) || amount <= 0 || amount > 10000000) return res.status(400).json({ ok: false, error: 'bad_request' });
      if (!allowed(String(uidOf(req)))) return res.status(429).json({ ok: false, error: 'rate_limited' });
      const ipHash = req.ip ? crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 32) : null;
      const r = await riskSvc.assessAndRecord({ userId: uidOf(req), kind: b.kind, amount, counterparty: typeof b.counterparty === 'string' ? b.counterparty : null,
        purpose: typeof b.purpose === 'string' ? b.purpose.slice(0, 200) : null, expectedAmount: b.expectedAmount != null ? Number(b.expectedAmount) : undefined,
        deviceHash: risk.sha(b.deviceId) }, { ipHash, mode: process.env.NECPRA_RISK_MODE || 'observe' });
      return res.json({ ok: true, eventId: r.eventId, score: r.score, level: r.level, action: r.action, reasons: r.reasons.map((x) => ({ code: x.code, message: x.message })), notProof: true, note: r.note,
        enforcement: 'none', canContinue: true, howToResolve: r.eventId ? 'POST /api/intelligence/risk/' + r.eventId + '/resolve {outcome:"ok"|"report"}' : null });
    } catch (e) { console.error('[intelligence] assess failed:', e && e.message); return res.status(500).json({ ok: false, error: 'assess_failed' }); }
  });

  router.post('/risk/:id/resolve', limiter, express.json({ limit: '2kb' }), async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) return res.status(400).json({ ok: false, error: 'bad_id' });
      const r = await riskSvc.resolve(uidOf(req), req.params.id, (req.body || {}).outcome, (req.body || {}).note);
      return r.ok ? res.json({ ok: true, event: r.event }) : res.status(r.status || 400).json({ ok: false, error: r.error });
    } catch (e) { console.error('[intelligence] resolve failed:', e && e.message); return res.status(500).json({ ok: false, error: 'resolve_failed' }); }
  });

  router.get('/risk', limiter, async (req, res) => {
    try { return res.json({ ok: true, events: await riskSvc.listForUser(uidOf(req), req.query.limit) }); }
    catch (e) { console.error('[intelligence] list failed:', e && e.message); return res.status(500).json({ ok: false, error: 'list_failed' }); }
  });

  /* ───── Marketplace intelligence (all scoped to the caller; see services/intelligence/marketplace.js) ─────
   *   GET  /marketplace/recommendations   personalised from the caller's own purchases (trending fallback, labelled)
   *   GET  /marketplace/trending?category=  popular visible listings
   *   GET  /marketplace/price-check/:id    is this price in line with similar listings? (hint, not proof)
   *   POST /marketplace/categorise {title,description}   suggested category from the canonical list
   *   GET  /marketplace/seller             the caller's OWN seller insights */
  const guard = (fn) => async (req, res) => {
    try {
      if (!enabled()) return res.status(503).json({ ok: false, error: 'ai_disabled' });
      if (!allowed(String(uidOf(req)))) return res.status(429).json({ ok: false, error: 'rate_limited' });
      return await fn(req, res);
    } catch (e) { console.error('[intelligence] marketplace failed:', e && e.message); return res.status(500).json({ ok: false, error: 'marketplace_failed' }); }
  };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  router.get('/marketplace/recommendations', limiter, guard(async (req, res) => res.json(Object.assign({ ok: true }, await mkt.recommend(uidOf(req), req.query.limit)))));
  router.get('/marketplace/trending', limiter, guard(async (req, res) => {
    const c = typeof req.query.category === 'string' && /^[a-z_-]{1,40}$/i.test(req.query.category) ? req.query.category.toLowerCase() : undefined;
    res.json({ ok: true, items: await mkt.trending(req.query.limit, c) });
  }));
  router.get('/marketplace/price-check/:id', limiter, guard(async (req, res) => {
    if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ ok: false, error: 'bad_id' });
    const r = await mkt.priceCheck(uidOf(req), req.params.id);
    return r.ok ? res.json(r) : res.status(r.status || 400).json({ ok: false, error: r.error });
  }));
  router.post('/marketplace/categorise', limiter, express.json({ limit: '4kb' }), guard(async (req, res) => {
    const b = req.body || {};
    if (typeof b.title !== 'string' || b.title.trim().length < 2 || b.title.length > 255 || (b.description != null && typeof b.description !== 'string')) return res.status(400).json({ ok: false, error: 'bad_request' });
    res.json(Object.assign({ ok: true }, marketplace.categorise(b.title, b.description)));
  }));
  router.get('/marketplace/seller', limiter, guard(async (req, res) => res.json(await mkt.sellerInsights(uidOf(req)))));

  /* ───── Personal assistant: reminders (caller's own only) ─────
   *   POST   /reminders {text, dueAt(ISO)}   GET /reminders?status=pending|done|cancelled   GET /reminders/due
   *   POST   /reminders/:id/done             DELETE /reminders/:id   (cancels) */
  const send = (res, r, key) => (r.ok ? res.json({ ok: true, [key || 'reminder']: r.reminder }) : res.status(r.status || 400).json({ ok: false, error: r.error }));
  router.post('/reminders', limiter, express.json({ limit: '2kb' }), guard(async (req, res) => {
    const b = req.body || {};
    if (typeof b.text !== 'string' || typeof b.dueAt !== 'string' || Number.isNaN(Date.parse(b.dueAt))) return res.status(400).json({ ok: false, error: 'bad_request' });
    return send(res, await remSvc.create(uidOf(req), { text: b.text, dueAt: b.dueAt, source: 'api' }));
  }));
  router.get('/reminders/due', limiter, guard(async (req, res) => res.json({ ok: true, reminders: await remSvc.due(uidOf(req)) })));
  router.get('/reminders', limiter, guard(async (req, res) => res.json({ ok: true, reminders: await remSvc.list(uidOf(req), req.query.status, req.query.limit) })));
  router.post('/reminders/:id/done', limiter, guard(async (req, res) => (UUID_RE.test(String(req.params.id)) ? send(res, await remSvc.done(uidOf(req), req.params.id)) : res.status(400).json({ ok: false, error: 'bad_id' }))));
  router.delete('/reminders/:id', limiter, guard(async (req, res) => (UUID_RE.test(String(req.params.id)) ? send(res, await remSvc.cancel(uidOf(req), req.params.id)) : res.status(400).json({ ok: false, error: 'bad_id' }))));

  return router;
}

const router = createRouter();
router.create = createRouter;
module.exports = router;
