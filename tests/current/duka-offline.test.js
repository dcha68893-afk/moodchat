'use strict';
/**
 * NECPRA DUKA SMART — Phase 6 offline-first end-to-end test.
 * Loads the REAL moodfronted/duka.html in jsdom, points it at the REAL backend router + PostgreSQL, and switches the
 * network on/off underneath it (including "request reached the server but the response was lost").
 *   DUKA_TEST_DB_URL=postgres://user@localhost:5432/dukatest [DUKA_FRONTEND_DIR=../moodfronted] npx jest tests/current/duka-offline.test.js --runInBand
 * Skips cleanly when DUKA_TEST_DB_URL or jsdom is missing.
 */
const fs = require('fs');
const path = require('path');
let JSDOM = null, VirtualConsole = null; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (_) {}
const URL_ = process.env.DUKA_TEST_DB_URL;
const FRONT = process.env.DUKA_FRONTEND_DIR || path.resolve(__dirname, '../../../moodfronted');
const ok = URL_ && JSDOM && fs.existsSync(path.join(FRONT, 'duka.html'));
const d = ok ? describe : describe.skip;

d('duka phase 6 offline-first (real page, real API, real DB)', () => {
  jest.setTimeout(30000);
  const express = require('express');
  const { Sequelize } = require('sequelize');
  const USER = 8000000 + Math.floor(Math.random() * 1000000);   // fresh owner every run: no leftovers
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const TOKEN = `h.${b64({ id: USER })}.s`;
  let sequelize, server, base, w, shopId, prodA;
  const net = { offline: false, blocked: false, dropResponses: 0, log: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(25); } return false; };
  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const q = (sql, repl) => sequelize.query(sql, { replacements: repl || {}, type: 'SELECT' });
  const click = (sel) => { const el = w.document.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
  const setv = (id, v) => { w.document.getElementById(id).value = v; };
  const go = (on) => { net.offline = !on; w.dispatchEvent(new w.Event(on ? 'online' : 'offline')); };
  const appText = () => { const c = w.document.body.cloneNode(true); c.querySelectorAll('script,style').forEach((n) => n.remove()); return c.textContent; };
  const outbox = () => JSON.parse(w.localStorage.getItem('necpra_duka_outbox_v1') || '[]');
  const posts = () => net.log.filter((l) => l.startsWith('POST')).length;

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance']) await require(`../../migrations/${m}.js`).up({ sequelize });
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize, authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
  });
  afterAll(async () => { if (w) { net.offline = true; await wait(600); w.close(); } if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('boots online and creates the default shop', async () => {
    const html = fs.readFileSync(path.join(FRONT, 'duka.html'), 'utf8');
    const dom = new JSDOM(html, {
      virtualConsole: new VirtualConsole().sendTo(console, { omitJSDOMErrors: false }), url: 'https://necpra.co.ke/duka.html', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) {
        win.localStorage.setItem('authToken', TOKEN); win.API_BASE_URL = 'https://api.test';
        Object.defineProperty(win.navigator, 'onLine', { get: () => !net.offline });
        win.fetch = async (u, o) => {
          const p = u.replace('https://api.test/api/duka', ''); const m = (o && o.method) || 'GET';
          if (net.offline || net.blocked) throw new TypeError('Failed to fetch');
          net.log.push(m + ' ' + p.split('?')[0]);
          const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: o && o.body });
          const text = await r.text();
          if (m === 'POST' && net.dropResponses > 0) { net.dropResponses--; net.blocked = true; throw new TypeError('Failed to fetch'); } // server DID process it
          return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
        };
      }
    });
    w = dom.window;
    const booted = await until(() => w.__duka && w.__duka.S.shopId);
    expect(booted).toBe(true);
    expect(await until(() => w.document.querySelector('[data-act=tab][data-tab=products]'))).toBe(true);
    shopId = w.__duka.S.shopId;
    prodA = require('crypto').randomUUID();
    expect((await api('POST', `/shops/${shopId}/products`, { id: prodA, name: 'Sugar', buyingPrice: 100, sellingPrice: 150, stockQty: 10 })).status).toBe(201);
    click('[data-act=tab][data-tab=products]');
    expect(await until(() => w.document.querySelector(`[data-act=openProduct][data-id="${prodA}"]`))).toBe(true);   // product list loaded (and saved on the phone)
  });

  test('offline: product, stock, cash sale and expense are kept on the phone and nothing hits the server', async () => {
    go(false); const before = net.log.length;
    // new product
    click('[data-act=addProduct]'); setv('pName', 'Maize flour'); setv('pBuy', '80'); setv('pSell', '120'); setv('pStock', '20'); click('[data-act=saveNewProduct]');
    expect(await until(() => outbox().length === 1)).toBe(true);
    expect(await until(() => w.document.querySelector(`[data-act=openProduct][data-id="${prodA}"]`) && /Not synced/.test(appText()))).toBe(true);
    expect(w.__duka.S.err).toBe('');
    // stock +5 on the existing product
    click(`[data-act=openProduct][data-id="${prodA}"]`); await wait(60); setv('adjQty', '5'); click('[data-act=adjust][data-sign="1"]');
    expect(await until(() => outbox().length === 2)).toBe(true);
    click('[data-act=closeModal]');
    // cash sale of 3 Sugar (stock is now 15 locally) paid in full
    click('[data-act=tab][data-tab=pos]'); await until(() => w.document.querySelector(`[data-act=addToCart][data-id="${prodA}"]`));
    click(`[data-act=addToCart][data-id="${prodA}"]`); w.__duka.S.cart[0].qty = '3'; click('[data-act=checkout]'); await wait(40);
    setv('payCash', '450'); w.__duka.updateCheckout(); click('[data-act=confirmSale]');
    expect(await until(() => outbox().length === 3)).toBe(true);
    expect(appText()).toMatch(/PENDING SYNC/);               // provisional receipt, no fake receipt number
    click('[data-act=closeModal]');
    // expense
    click('[data-act=tab][data-tab=money]'); await until(() => w.document.querySelector('[data-act=addExpense]'));
    click('[data-act=addExpense]'); setv('xAmt', '200'); setv('xCat', 'rent'); click('[data-act=saveExpense]');
    expect(await until(() => outbox().length === 4)).toBe(true);
    expect(outbox().map((o) => o.type)).toEqual(['product.create', 'stock.adjust', 'sale.create', 'expense.create']);
    expect(net.log.length).toBe(before);                                       // zero requests while offline
    expect(await until(() => /4 changes waiting to sync/.test(appText()))).toBe(true);
    expect(await until(() => /You are offline/.test(appText()))).toBe(true);
    expect((await q(`SELECT COUNT(*)::int AS n FROM duka_sales WHERE shop_id = :s`, { s: shopId }))[0].n).toBe(0);
    // local stock = 10 + 5 - 3, so overselling is blocked on the phone too
    const eff = w.__duka.S.products.filter((p) => p.id === prodA)[0].stockQty; expect(eff).toBe(12);
  });

  test('offline: M-PESA and credit sales are refused, never faked as paid', async () => {
    const n = outbox().length;
    click('[data-act=tab][data-tab=pos]'); await until(() => w.document.querySelector(`[data-act=addToCart][data-id="${prodA}"]`));
    click(`[data-act=addToCart][data-id="${prodA}"]`); click('[data-act=checkout]'); await wait(40);
    setv('payMp', '150'); setv('payCode', 'ABCD1234EF'); click('[data-act=confirmSale]'); await wait(150);
    expect(outbox().length).toBe(n);
    expect(appText()).toMatch(/cannot be recorded offline|No internet/);
    click('[data-act=closeModal]'); w.__duka.S.cart = []; w.__duka.saveCart();
  });

  test('reconnect: everything syncs once, in order, with correct stock; replay is idempotent', async () => {
    go(true);
    expect(await until(() => outbox().length === 0, 8000)).toBe(true);
    const sales = await q(`SELECT total, status FROM duka_sales WHERE shop_id = :s`, { s: shopId });
    expect(sales).toHaveLength(1); expect(Number(sales[0].total)).toBe(450);
    const prods = Object.fromEntries((await q(`SELECT name, stock_qty FROM duka_products WHERE shop_id = :s`, { s: shopId })).map((r) => [r.name, Number(r.stock_qty)]));
    expect(prods).toEqual({ Sugar: 12, 'Maize flour': 20 });                   // 10 + 5 − 3, nothing double-counted
    expect((await q(`SELECT amount FROM duka_expenses WHERE shop_id = :s`, { s: shopId })).map((r) => Number(r.amount))).toEqual([200]);
    expect(await until(() => !/waiting to sync/.test(appText()))).toBe(true);
  });

  test('lost response (server processed it, phone never heard back): retry does not double-sell or double-deduct', async () => {
    go(false);
    click('[data-act=tab][data-tab=pos]'); await until(() => w.document.querySelector(`[data-act=addToCart][data-id="${prodA}"]`));
    click(`[data-act=addToCart][data-id="${prodA}"]`); w.__duka.S.cart[0].qty = '2'; click('[data-act=checkout]'); await wait(40);
    setv('payCash', '300'); click('[data-act=confirmSale]');
    expect(await until(() => outbox().length === 1)).toBe(true); click('[data-act=closeModal]');
    net.dropResponses = 1; go(true);
    expect(await until(() => net.dropResponses === 0, 6000)).toBe(true);        // the request was sent and processed; only the reply was lost
    expect(outbox().length).toBe(1);                                           // phone believes it is NOT saved
    expect((await q(`SELECT COUNT(*)::int AS n FROM duka_sales WHERE shop_id = :s`, { s: shopId }))[0].n).toBe(2); // …but the server has it
    net.blocked = false; await w.__duka.syncNow();                             // connection is back: retry with the same id
    expect(await until(() => outbox().length === 0, 8000)).toBe(true);
    expect((await q(`SELECT COUNT(*)::int AS n FROM duka_sales WHERE shop_id = :s`, { s: shopId }))[0].n).toBe(2);
    expect(Number((await q(`SELECT stock_qty FROM duka_products WHERE id = :p`, { p: prodA }))[0].stock_qty)).toBe(10); // 12 − 2, once
  });

  test('two simultaneous syncs send each change once', async () => {
    go(false);
    click('[data-act=tab][data-tab=money]'); await until(() => w.document.querySelector('[data-act=addExpense]'));
    click('[data-act=addExpense]'); setv('xAmt', '75'); click('[data-act=saveExpense]');
    expect(await until(() => outbox().length === 1)).toBe(true);
    const before = posts(); go(true);
    await Promise.all([w.__duka.syncNow(), w.__duka.syncNow(), w.__duka.syncNow()]);
    expect(await until(() => outbox().length === 0, 8000)).toBe(true);
    expect(posts() - before).toBe(1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM duka_expenses WHERE shop_id = :s AND amount = 75`, { s: shopId }))[0].n).toBe(1);
  });

  test('conflict: a sale the server cannot accept is flagged for attention, others still sync, Retry works', async () => {
    go(false);
    click('[data-act=tab][data-tab=pos]'); await until(() => w.document.querySelector(`[data-act=addToCart][data-id="${prodA}"]`));
    click(`[data-act=addToCart][data-id="${prodA}"]`); w.__duka.S.cart[0].qty = '9'; click('[data-act=checkout]'); await wait(40);
    setv('payCash', '1350'); click('[data-act=confirmSale]');
    expect(await until(() => outbox().length === 1)).toBe(true); click('[data-act=closeModal]');
    click('[data-act=tab][data-tab=money]'); await until(() => w.document.querySelector('[data-act=addExpense]'));
    click('[data-act=addExpense]'); setv('xAmt', '40'); click('[data-act=saveExpense]');
    expect(await until(() => outbox().length === 2)).toBe(true);
    // meanwhile another device sells 6 Sugar, so only 4 are really left
    expect((await api('POST', `/shops/${shopId}/sales`, { id: require('crypto').randomUUID(), items: [{ productId: prodA, qty: 6, unitPrice: 150 }], payments: [{ method: 'cash', amount: 900 }] })).status).toBe(201);
    go(true);
    expect(await until(() => outbox().length === 1 && outbox()[0].status === 'failed', 8000)).toBe(true);
    expect(outbox()[0].type).toBe('sale.create'); expect(outbox()[0].err).toMatch(/stock/i);
    expect((await q(`SELECT COUNT(*)::int AS n FROM duka_expenses WHERE shop_id = :s AND amount = 40`, { s: shopId }))[0].n).toBe(1);
    expect(await until(() => /1 change need attention/.test(appText()))).toBe(true);
    // shop owner restocks, then retries
    await api('POST', `/shops/${shopId}/products/${prodA}/stock`, { qtyChange: 10, type: 'adjustment', clientOpId: require('crypto').randomUUID() });
    click('[data-act=syncStatus]'); await wait(30); click('[data-act=retryOp]');
    expect(await until(() => outbox().length === 0, 8000)).toBe(true);
    expect(Number((await q(`SELECT stock_qty FROM duka_products WHERE id = :p`, { p: prodA }))[0].stock_qty)).toBe(5); // 10 − 6 + 10 − 9
  });

  test('last saved data and reports open offline; another user never sees this phone\'s saved data', async () => {
    click('[data-act=tab][data-tab=money]'); await until(() => w.document.querySelector('[data-act=fin][data-f=reports]'));
    click('[data-act=fin][data-f=reports]'); await until(() => /Net profit/.test(appText()));
    go(false);
    click('[data-act=rp][data-p=weekly]'); await wait(100); click('[data-act=rp][data-p=daily]');
    expect(await until(() => /Net profit/.test(appText()) && /Showing information saved on this phone/.test(appText()))).toBe(true);
    const other = `h.${b64({ id: 99999 })}.s`; w.localStorage.setItem('authToken', other);
    expect(w.__duka.cacheGet('/shops')).toBeNull();                                  // cache is per user
    expect(w.__duka.obMine()).toEqual([]);                                           // outbox is per user
    w.localStorage.setItem('authToken', TOKEN);
  });
});
