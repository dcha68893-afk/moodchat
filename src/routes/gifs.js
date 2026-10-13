/**
 * routes/gifs.js - GIF search proxy  (mounted by the auto-loader at /api/gifs, login required)
 * ---------------------------------------------------------------------------------------
 * WHY: Google shut the Tenor API down on 30 Jun 2026, so the chat GIF picker (which called Tenor directly with a
 * public demo key from the browser) stopped working. The provider key now lives only on the server.
 *
 * Provider: GIPHY (https://developers.giphy.com). Set GIPHY_API_KEY in the environment (Render dashboard).
 * Without it the endpoints answer 503 GIF_PROVIDER_NOT_CONFIGURED and the app shows "GIFs are temporarily
 * unavailable" instead of breaking. Content is requested with rating "pg" (suitable for a general chat app).
 *
 * GET /api/gifs/trending?pos=&limit=
 * GET /api/gifs/search?q=&pos=&limit=
 * Response (same shape the picker already used): { results:[{id,title,media_formats:{tinygif:{url},gif:{url}}}], next:'<offset or empty>' }
 */
const express = require('express');
const { searchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map();   // url -> { at, body }

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function normalize(json, offset) {
  const data = Array.isArray(json && json.data) ? json.data : [];
  const results = [];
  for (const g of data) {
    const im = g && g.images ? g.images : {};
    const tiny = (im.fixed_height_small && im.fixed_height_small.url) || (im.fixed_height && im.fixed_height.url) || '';
    const full = (im.downsized_medium && im.downsized_medium.url) || (im.original && im.original.url) || tiny;
    if (!g.id || !tiny || !/^https:\/\//i.test(tiny)) continue;
    results.push({ id: String(g.id), title: String(g.title || 'GIF').slice(0, 120), media_formats: { tinygif: { url: tiny }, gif: { url: full } } });
  }
  const p = (json && json.pagination) || {};
  const nextOffset = (Number(p.offset) || offset) + (Number(p.count) || results.length);
  const more = Number(p.total_count) ? nextOffset < Number(p.total_count) : results.length > 0;
  return { results, next: more ? String(nextOffset) : '', provider: 'giphy' };
}

async function giphy(kind, params) {
  const key = process.env.GIPHY_API_KEY;
  if (!key) { const e = new Error('GIF provider not configured'); e.code = 'GIF_PROVIDER_NOT_CONFIGURED'; throw e; }
  const qs = new URLSearchParams(Object.assign({ api_key: key, rating: 'pg', lang: 'en' }, params));
  const url = `${GIPHY_BASE}/${kind}?${qs.toString()}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) { const e = new Error('GIF provider error ' + r.status); e.code = 'GIF_PROVIDER_ERROR'; throw e; }
    const body = normalize(await r.json(), Number(params.offset) || 0);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(url, { at: Date.now(), body });
    return body;
  } finally { clearTimeout(timer); }
}

function fail(res, e) {
  if (e && e.code === 'GIF_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ error: 'GIFs are temporarily unavailable', code: e.code });
  return res.status(502).json({ error: 'Could not load GIFs', code: 'GIF_PROVIDER_ERROR' });
}

router.get('/trending', searchLimiter, async (req, res) => {
  try {
    res.json(await giphy('trending', { limit: clampInt(req.query.limit, 20, 1, 30), offset: clampInt(req.query.pos, 0, 0, 500) }));
  } catch (e) { fail(res, e); }
});

router.get('/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (!q) return res.json({ results: [], next: '', provider: 'giphy' });
  try {
    res.json(await giphy('search', { q, limit: clampInt(req.query.limit, 20, 1, 30), offset: clampInt(req.query.pos, 0, 0, 500) }));
  } catch (e) { fail(res, e); }
});

module.exports = router;
