'use strict';
/**
 * NECPRA DUKA SMART — stock batches (incl. packs) and spoilage losses recorded OFFLINE, then synced once (real page, real API, real DB).
 *   DUKA_TEST_DB_URL=postgres://user@localhost:5432/dukatest [DUKA_FRONTEND_DIR=../moodfronted] npx jest tests/current/duka-offline-waste.test.js --runInBand
 */
const fs = require('fs');
const path = require('path');
let JSDOM = null, VirtualConsole = null; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (_) {}
const URL_ = process.env.DUKA_TEST_DB_URL;
const FRONT = process.env.DUKA_FRONTEND_DIR || path.resolve(__dirname, '../../../moodfronted');
const ok = URL_ && JSDOM && fs.existsSync(path.join(FRONT, 'duka.html'));
const d = ok ? describe : describe.skip;

d('duka offline batches + losses', () => {
  jest.setTimeout(30000);
  const express = require('express');
  const { Sequelize } = require('sequelize');
  const USER = 9500000 + Math.floor(Math.random() * 400000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const TOKEN = `h.${b64({ id: USER })}.s`;
  const uid = () => require('crypto').randomUUID();
  const net = { offline: false, log: [], dropNext: 0 };
  let sequelize, server, base, w, shopId;
  const EGGS = uid(), TOM = uid();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(25); } return false; };
  const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const click = (sel) => { const el = w.document.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
  const setv = (id, v) => { w.document.getElementById(id).value = v; };
  const go = (on) => { net.offline = !on; w.dispatchEvent(new w.Event(on ? 'online' : 'offline')); };
  const appText = () => { const c = w.document.body.cloneNode(true); c.querySelectorAll('script,style').forEach((n) => n.remove()); return c.textContent; };
  const outbox = () => JSON.parse(w.localStorage.getItem('necpra_duka_outbox_v1') || '[]');
  const stock = async (id) => (await api('GET', `/shops/${shopId}/products/${id}`)).body.data.product.stockQty;

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance', '20261111000004-duka-sale-void-and-product-description', '20261111000005-duka-batches-waste-devices']) await require(`../../migrations/${m}.js`).up({ sequelize });
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize, authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    const dom = new JSDOM(fs.readFileSync(path.join(FRONT, 'duka.html'), 'utf8'), {
      virtualConsole: new VirtualConsole().sendTo(console, { omitJSDOMErrors: false }), url: 'https://necpra.co.ke/duka.html', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) {
        win.localStorage.setItem('authToken', TOKEN); win.API_BASE_URL = 'https://api.test';
        Object.defineProperty(win.navigator, 'onLine', { get: () => !net.offline });
        win.fetch = async (u, o) => {
          const p = u.replace('https://api.test/api/duka', ''); const m = (o && o.method) || 'GET';
          if (net.offline) throw new TypeError('Failed to fetch');
          net.log.push(m + ' ' + p.split('?')[0]);
          const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: o && o.body });
          const text = await r.text();
          if (m !== 'GET' && net.dropNext > 0) { net.dropNext--; throw new TypeError('Failed to fetch'); } // server DID process it, reply lost
          return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
        };
      }
    });
    w = dom.window;
    expect(await until(() => w.__duka && w.__duka.S.shopId)).toBe(true);
    shopId = w.__duka.S.shopId;
    expect((await api('POST', `/shops/${shopId}/products`, { id: EGGS, name: 'Eggs', unit: 'piece', buyingPrice: 12, sellingPrice: 15, packUnit: 'crate', packSize: 30 })).status).toBe(201);
    expect((await api('POST', `/shops/${shopId}/products`, { id: TOM, name: 'Tomatoes', unit: 'kg', buyingPrice: 50, sellingPrice: 80, stockQty: 10 })).status).toBe(201);
  });
  afterAll(async () => { if (w) { net.offline = true; await wait(300); w.close(); } if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('the waste tab is saved on the phone while online', async () => {
    expect(await until(() => w.document.querySelector('[data-act=tab][data-tab=waste]'))).toBe(true);
    click('[data-act=tab][data-tab=waste]');
    expect(await until(() => w.document.querySelector('[data-act=wsBatch]'))).toBe(true);
  });

  test('offline: receive 2 crates + record spoiled tomatoes — kept on the phone, stock shown correctly, nothing sent', async () => {
    go(false); const before = net.log.length;
    click('[data-act=wsBatch]'); setv('wbProd', EGGS); setv('wbMode', 'pack'); setv('wbQty', '2'); setv('wbCost', '360'); setv('wbShelf', '21');
    click('[data-act=wsBatchSave]');
    expect(await until(() => outbox().length === 2)).toBe(true);           // freshness + batch, in that order
    expect(outbox().map((o) => o.type)).toEqual(['product.perishable', 'stock.batch']);
    expect(outbox()[1].body.packs).toBe(2);
    click('[data-act=wsLoss]'); setv('wlProd', TOM); setv('wlQty', '40'); click('[data-act=wsLossSave]');   // more than the 10 kg held
    await wait(80); expect(outbox().length).toBe(2);                       // refused locally
    setv('wlQty', '3'); setv('wlReason', 'spoiled'); click('[data-act=wsLossSave]');
    expect(await until(() => outbox().length === 3)).toBe(true);
    expect(net.log.length).toBe(before);                                    // zero requests while offline
    const eff = (id) => w.__duka.S.products.filter((p) => p.id === id)[0].stockQty;
    expect(eff(EGGS)).toBe(60); expect(eff(TOM)).toBe(7);
    expect(await stock(EGGS)).toBe(0); expect(await stock(TOM)).toBe(10);   // server untouched
  });

  test('reconnect (even with a lost reply): everything lands exactly once at the right cost', async () => {
    net.dropNext = 1; go(true);
    expect(await until(() => outbox().length === 0, 12000)).toBe(true);
    expect(await stock(EGGS)).toBe(60); expect(await stock(TOM)).toBe(7);   // not doubled by the retry
    const b = (await api('GET', `/shops/${shopId}/products/${EGGS}/batches`)).body.data.batches;
    expect(b).toHaveLength(1); expect(b[0].unitCost).toBe(12); expect(b[0].shelfLifeDays).toBe(21);
    const l = (await api('GET', `/shops/${shopId}/losses`)).body.data;
    expect(l.losses).toHaveLength(1); expect(l.totalLossValue).toBe(150);
  });
});
