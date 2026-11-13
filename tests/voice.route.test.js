const test = require('node:test'); const assert = require('node:assert'); const Module = require('module'); const http = require('http');
// stub the project rate limiter so the route can be loaded in isolation
const orig = Module._load; Module._load = function (r, ...a) { if (/middleware\/rateLimiter$/.test(r)) return { apiRateLimiter: (q, s, n) => n() }; return orig.call(this, r, ...a); };
const express = require(process.env.EXPRESS_PATH || 'express'); const voice = require('../src/routes/voice.js');
function app(user, rows) { const a = express(); a.use((q, s, n) => { q.user = user; n(); }); a.use('/voice', voice.create({ getSequelize: () => ({ query: async (sql, o) => { rows.push(o.replacements); } }) })); return a; }
function call(a, method, path, body) { return new Promise(res => { const s = a.listen(0, () => { const r = http.request({ port: s.address().port, path, method, headers: { 'content-type': 'application/json' } }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => { s.close(); res({ status: x.statusCode, body: JSON.parse(d || '{}') }); }); }); if (body) r.write(JSON.stringify(body)); r.end(); }); }); }
test('audit stores metadata only, never transcript text', async () => {
  const rows = []; const r = await call(app({ id: 7 }, rows), 'POST', '/voice/audit', { action: 'duka.voice', module: 'duka', outcome: 'captured', lang: 'sw-KE', durationMs: 4000, chars: 80, transcript: 'SECRET WORDS' });
  assert.equal(r.status, 201); assert.equal(rows.length, 1); assert.ok(!JSON.stringify(rows[0]).includes('SECRET')); assert.equal(rows[0].userId, '7');
});
test('unauthenticated is rejected', async () => { const rows = []; const r = await call(app(null, rows), 'POST', '/voice/audit', { action: 'x' }); assert.equal(r.status, 401); assert.equal(rows.length, 0); });
test('bad action rejected; unknown outcome nulled', async () => {
  const rows = []; const a = app({ id: 1 }, rows);
  assert.equal((await call(a, 'POST', '/voice/audit', { action: 'drop table;' })).status, 400);
  await call(a, 'POST', '/voice/audit', { action: 'ok.act', outcome: 'hacked' }); assert.equal(rows[0].outcome, null);
});
test('config exposes no secrets', async () => { const r = await call(app({ id: 1 }, []), 'GET', '/voice/config'); assert.equal(r.status, 200); assert.equal(r.body.audioRetention, 'none'); });
