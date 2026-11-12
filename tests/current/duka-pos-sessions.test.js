'use strict';
/**
 * NECPRA DUKA SMART — held customer bills, barcode scan handling and pack receiving in the REAL moodfronted/duka.html
 * (jsdom) against the REAL backend router + PostgreSQL.
 *   DUKA_TEST_DB_URL=postgres://user@localhost:5432/dukatest [DUKA_FRONTEND_DIR=../moodfronted] npx jest tests/current/duka-pos-sessions.test.js --runInBand
 */
const fs = require('fs');
const path = require('path');
let JSDOM = null, VirtualConsole = null; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (_) {}
const URL_ = process.env.DUKA_TEST_DB_URL;
const FRONT = process.env.DUKA_FRONTEND_DIR || path.resolve(__dirname, '../../../moodfronted');
const ok = URL_ && JSDOM && fs.existsSync(path.join(FRONT, 'duka.html'));
const d = ok ? describe : describe.skip;

d('duka held bills + barcode + packs (real page)', () => {
  jest.setTimeout(30000);
  const express = require('express');
  const { Sequelize } = require('sequelize');
  const USER = 9000000 + Math.floor(Math.random() * 900000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const TOKEN = `h.${b64({ id: USER })}.s`;
  const uid = () => require('crypto').randomUUID();
  let sequelize, server, base, w, shopId;
  const P = { soap: uid(), bread: uid(), gone: uid(), eggs: uid() };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(25); } return false; };
  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const click = (sel) => { const el = w.document.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
  const setv = (id, v) => { w.document.getElementById(id).value = v; };
  const appText = () => { const c = w.document.body.cloneNode(true); c.querySelectorAll('script,style').forEach((n) => n.remove()); return c.textContent; };
  const parked = () => JSON.parse(w.localStorage.getItem('necpra_duka_parked_' + shopId) || '[]');
  const goPos = async () => { click('[data-act=tab][data-tab=pos]'); await until(() => w.document.querySelector(`[data-act=addToCart][data-id="${P.soap}"]`)); };

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance', '20261111000004-duka-sale-void-and-product-description', '20261111000005-duka-batches-waste-devices']) await require(`../../migrations/${m}.js`).up({ sequelize });
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize, authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    const html = fs.readFileSync(path.join(FRONT, 'duka.html'), 'utf8');
    const dom = new JSDOM(html, {
      virtualConsole: new VirtualConsole().sendTo(console, { omitJSDOMErrors: false }), url: 'https://necpra.co.ke/duka.html', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) {
        win.localStorage.setItem('authToken', TOKEN); win.API_BASE_URL = 'https://api.test';
        win.confirm = () => true;
        win.fetch = async (u, o) => {
          const p = u.replace('https://api.test/api/duka', ''); const m = (o && o.method) || 'GET';
          const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: o && o.body });
          const text = await r.text();
          return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
        };
      }
    });
    w = dom.window;
    expect(await until(() => w.__duka && w.__duka.S.shopId)).toBe(true);
    shopId = w.__duka.S.shopId;
    for (const [id, name, bar, stock] of [[P.soap, 'Soap', '6001', 20], [P.bread, 'Bread', '7002', 10], [P.gone, 'Sold out', '9999', 0]]) {
      expect((await api('POST', `/shops/${shopId}/products`, { id, name, barcode: bar, buyingPrice: 40, sellingPrice: 60, stockQty: stock })).status).toBe(201);
    }
    expect((await api('POST', `/shops/${shopId}/products`, { id: P.eggs, name: 'Eggs', unit: 'piece', buyingPrice: 12, sellingPrice: 15, packUnit: 'crate', packSize: 30 })).status).toBe(201);
    click('[data-act=tab][data-tab=products]'); await until(() => w.document.querySelector(`[data-act=openProduct][data-id="${P.soap}"]`));
  });
  afterAll(async () => { if (w) w.close(); if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('hold a bill, serve another customer, resume — nothing lost, sale ids kept apart', async () => {
    await goPos();
    click(`[data-act=addToCart][data-id="${P.soap}"]`); w.__duka.S.cart[0].qty = '2'; w.__duka.saveCart();
    const soapSale = w.__duka.S.saleId; expect(soapSale).toBeTruthy();
    click('[data-act=parkBill]');
    expect(w.__duka.S.cart).toHaveLength(0); expect(w.__duka.S.saleId).toBeNull();
    expect(parked()).toHaveLength(1); expect(parked()[0].saleId).toBe(soapSale); expect(parked()[0].cart[0].qty).toBe('2');
    expect(appText()).toMatch(/Held bills \(1\)/); expect(appText()).toMatch(/Customer 1/);

    click(`[data-act=addToCart][data-id="${P.bread}"]`);
    const breadSale = w.__duka.S.saleId; expect(breadSale).not.toBe(soapSale);
    click('[data-act=resumeBill][data-i="0"]');            // swap: bread goes onto the held list, soap comes back
    expect(w.__duka.S.cart[0].name).toBe('Soap'); expect(w.__duka.S.saleId).toBe(soapSale);
    expect(parked()).toHaveLength(1); expect(parked()[0].saleId).toBe(breadSale); expect(parked()[0].cart[0].name).toBe('Bread');
    // the bill on screen survives an app restart (existing cart storage) and the held one too
    expect(JSON.parse(w.localStorage.getItem('necpra_duka_cart_' + shopId)).saleId).toBe(soapSale);
  });

  test('discarding a held bill removes only that bill; an empty cart cannot be held', async () => {
    click('[data-act=discardBill][data-i="0"]');
    expect(parked()).toHaveLength(0);
    expect(appText()).not.toMatch(/Held bills/);
    // empty cart cannot be held
    w.__duka.S.cart = []; w.__duka.saveCart(); click('[data-act=clearCart]');
    expect(w.document.querySelector('[data-act=parkBill]')).toBeNull();
  });

  test('barcode: known code adds once at the seller\'s own price; held code is not double-added; unknown/out-of-stock never added', async () => {
    const t0 = 1e9;
    expect(w.__duka.scanAccept('6001', t0)).toBe(true);
    expect(w.__duka.scanAccept('6001', t0 + 300)).toBe(false);   // still in front of the camera
    expect(w.__duka.scanAccept('6001', t0 + 900)).toBe(false);
    expect(w.__duka.scanAccept('7002', t0 + 1000)).toBe(true);   // a different item is fine after the short gap
    expect(w.__duka.scanAccept('6001', t0 + 3000)).toBe(true);   // left the lens > 1.5 s, then shown again
    expect(w.__duka.scanAccept('7002', t0 + 3100)).toBe(false);  // global breather

    w.__duka.S.cart = []; w.__duka.saveCart();
    w.__duka.scanHandle('6001');
    expect(w.__duka.S.cart).toHaveLength(1); expect(w.__duka.S.cart[0].name).toBe('Soap'); expect(w.__duka.S.cart[0].price).toBe(60);
    w.__duka.scanHandle('7002');
    expect(w.__duka.S.cart).toHaveLength(2);
    w.__duka.scanHandle('0000');                                 // not in the catalogue: nothing is guessed
    w.__duka.scanHandle('9999');                                 // out of stock
    expect(w.__duka.S.cart).toHaveLength(2);
    click('[data-act=clearCart]');
  });

  test('scanner explains itself where the phone has no BarcodeDetector', async () => {
    click('[data-act=openScan]');
    expect(await until(() => /not available on this phone/.test(appText()))).toBe(true);
  });

  test('receiving packs in the real page: 2 crates -> 60 eggs at the right cost, shown before saving', async () => {
    click('[data-act=tab][data-tab=waste]'); await until(() => w.document.querySelector('[data-act=wsBatch]'));
    click('[data-act=wsBatch]');
    setv('wbProd', P.eggs); setv('wbMode', 'pack'); setv('wbQty', '2'); setv('wbCost', '360'); w.__duka.wbUpdate();
    expect(w.document.getElementById('wbConv').textContent).toMatch(/1 crate = 30 piece/);
    expect(w.document.getElementById('wbConv').textContent).toMatch(/60 piece/);
    click('[data-act=wsBatchSave]');
    expect(await until(async () => (await api('GET', `/shops/${shopId}/products/${P.eggs}`)).body.data.product.stockQty === 60)).toBe(true);
    const b = (await api('GET', `/shops/${shopId}/products/${P.eggs}/batches`)).body.data.batches;
    expect(b).toHaveLength(1); expect(b[0].unitCost).toBe(12);
  });
});
