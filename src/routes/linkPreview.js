// src/routes/linkPreview.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX: Link preview endpoint — fetches Open Graph / Twitter Card metadata
// so the frontend can show a rich preview card inside the message bubble.
//
// Mount in src/server.js:
//   app.use('/api/link-preview', require('./routes/linkPreview'));
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express   = require('express');
const router    = express.Router();
const https     = require('https');
const http      = require('http');
const { URL }   = require('url');

const { authenticate }   = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Simple in-memory cache — 15-minute TTL per URL
const _cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function _cached(url, value) {
  _cache.set(url, { value, expires: Date.now() + CACHE_TTL_MS });
}
function _getCache(url) {
  const entry = _cache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _cache.delete(url); return null; }
  return entry.value;
}

// Fetch raw HTML with a 5-second timeout
function _fetchHtml(rawUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Unsupported protocol'));

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Nexopa/1.0 LinkPreview (+https://nexopa.app)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return _fetchHtml(loc).then(resolve).catch(reject);
        return reject(new Error('Redirect without location'));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/html')) return reject(new Error('Not HTML'));

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        // Only need the <head> — stop reading after ~50KB
        if (body.length > 50000) { res.destroy(); }
      });
      res.on('end',   () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error',   reject);
  });
}

// Extract OG / Twitter / fallback meta tags from raw HTML
function _parseHtml(html, sourceUrl) {
  const get = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : null;
  };

  const title =
    get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    get(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<title[^>]*>([^<]+)<\/title>/i);

  const description =
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

  const imageUrl =
    get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    get(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

  const siteName =
    get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);

  let parsed;
  try { parsed = new URL(sourceUrl); } catch (_) { parsed = null; }
  const domain = parsed ? parsed.hostname.replace(/^www\./, '') : null;

  return {
    url:         sourceUrl,
    title:       title       ? title.slice(0, 200)       : domain,
    description: description ? description.slice(0, 400) : null,
    imageUrl:    imageUrl    ? imageUrl.slice(0, 500)     : null,
    siteName:    siteName    ? siteName.slice(0, 100)     : domain,
    domain,
  };
}

// ── GET /api/link-preview?url=<encoded_url> ───────────────────────────────────
router.get('/', authenticate, apiRateLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: 'error', message: 'url query param required' });

  // URL validation
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch (_) {
    return res.status(400).json({ status: 'error', message: 'Invalid or non-HTTP(S) URL' });
  }

  // Block private/internal addresses
  const host = parsed.hostname;
  if (/^(localhost|127\.|0\.0\.0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0:0:0:0)/.test(host)) {
    return res.status(400).json({ status: 'error', message: 'Private URLs not allowed' });
  }

  // Cache hit
  const cached = _getCache(url);
  if (cached) return res.json({ status: 'success', data: cached, cached: true });

  try {
    const html    = await _fetchHtml(url);
    const preview = _parseHtml(html, url);
    _cached(url, preview);
    return res.json({ status: 'success', data: preview });
  } catch (err) {
    return res.status(422).json({ status: 'error', message: err.message || 'Could not fetch preview' });
  }
});

module.exports = router;
