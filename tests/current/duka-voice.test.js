'use strict';
/**
 * NECPRA DUKA SMART — Phase 7 voice assistant tests.
 *  1) Command understanding (English + Kiswahili, number words) — needs only jsdom.
 *  2) End-to-end: the real page typed into like a user, against the real API + PostgreSQL — needs DUKA_TEST_DB_URL.
 *   DUKA_TEST_DB_URL=postgres://user@localhost:5432/dukatest [DUKA_FRONTEND_DIR=../moodfronted] npx jest tests/current/duka-voice.test.js --runInBand
 */
const fs = require('fs');
const path = require('path');
let JSDOM = null, VirtualConsole = null; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (_) {}
const FRONT = process.env.DUKA_FRONTEND_DIR || path.resolve(__dirname, '../../../moodfronted');
const HTML = JSDOM && fs.existsSync(path.join(FRONT, 'duka.html')) ? fs.readFileSync(path.join(FRONT, 'duka.html'), 'utf8') : null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(HTML ? describe : describe.skip)('voice: understanding commands (EN + SW)', () => {
  let w;
  beforeAll(() => {
    w = new JSDOM(HTML, { url: 'https://necpra.co.ke/duka.html', runScripts: 'dangerously', beforeParse(win) { win.localStorage.setItem('authToken', `h.${b64({ id: 1 })}.s`); win.fetch = async () => { throw new TypeError('x'); }; } }).window;
  });
  afterAll(() => w && w.close());
  const P = (t) => w.__duka.parse(t, 'en');
  test.each([
    ['one hundred and fifty', '150'], ['a hundred', '100'], ['two hundred and fifty', '250'], ['one thousand five hundred', '1500'], ['twenty five', '25'],
    ['kumi na tano', '15'], ['mia mbili na hamsini', '250'], ['elfu moja mia tano', '1500'], ['elfu mbili', '2000'], ['mia tano', '500'], ['5k', '5000'], ['1,500', '1500']
  ])('numbers: %s -> %s', (words, n) => expect(w.__duka.norm(words)).toBe(n));
  test.each([
    ['sell 3 sugar', { intent: 'sale', items: [{ qty: 3, name: 'sugar' }] }],
    ['sell 2 bread and 1 milk', { intent: 'sale', items: [{ qty: 2, name: 'bread' }, { qty: 1, name: 'milk' }] }],
    ['record sale of five sugar', { intent: 'sale', items: [{ qty: 5, name: 'sugar' }] }],
    ['nimeuza sukari mbili', { intent: 'sale', lang: 'sw', items: [{ qty: 2, name: 'sukari' }] }],
    ['uza sukari 3 na mkate 2', { intent: 'sale', items: [{ qty: 3, name: 'sukari' }, { qty: 2, name: 'mkate' }] }],
    ['add expense 500 for transport', { intent: 'expense', amount: 500, category: 'transport' }],
    ['spent two hundred and fifty on rent', { intent: 'expense', amount: 250, category: 'rent' }],
    ['nimetumia mia tano kwa usafiri', { intent: 'expense', lang: 'sw', amount: 500, category: 'transport' }],
    ['nimelipa mshahara elfu mbili mia tano', { intent: 'expense', amount: 2500, category: 'wages' }],
    ['add expense', { intent: 'expense', amount: null }],
    ['add product sugar buying price 100 selling price 150 stock 20', { intent: 'addProduct', name: 'sugar', buy: 100, sell: 150, stock: 20 }],
    ['ongeza bidhaa unga bei ya kununua 100 bei ya kuuza 130 idadi 20', { intent: 'addProduct', lang: 'sw', name: 'unga', buy: 100, sell: 130, stock: 20 }],
    ['add product tea leaves 80 100 12', { intent: 'addProduct', name: 'tea leaves', buy: 80, sell: 100, stock: 12 }],
    ['how much sugar is left', { intent: 'stock', query: 'sugar' }],
    ['do I have bread', { intent: 'stock', query: 'bread' }],
    ['sukari imebaki ngapi', { intent: 'stock', lang: 'sw', query: 'sukari' }],
    ['what is low on stock', { intent: 'lowstock' }],
    ['bidhaa zinazoisha', { intent: 'lowstock' }],
    ['who owes me', { intent: 'debts', who: '' }],
    ['how much does Wanjiru owe', { intent: 'debts', who: 'wanjiru' }],
    ['nani ananidai', { intent: 'debts', lang: 'sw' }],
    ["today's report", { intent: 'report', days: 1 }],
    ['sales this week', { intent: 'report', days: 7 }],
    ['faida mwezi huu', { intent: 'report', days: 30 }],
    ['ripoti ya leo', { intent: 'report', lang: 'sw', days: 1 }],
    ['expenses report today', { intent: 'report', days: 1 }],
    ['yes', { intent: 'confirmWord' }], ['ndio', { intent: 'confirmWord' }], ['cancel', { intent: 'cancelWord' }],
    ['hello there', { intent: 'unknown' }]
  ])('%s', (text, want) => expect(P(text)).toMatchObject(want));
});

const URL_ = process.env.DUKA_TEST_DB_URL;
(HTML && URL_ ? describe : describe.skip)('voice assistant end-to-end (real page, real API, real DB)', () => {
  jest.setTimeout(30000);
  const express = require('express');
  const { Sequelize } = require('sequelize');
  const USER = 8000000 + Math.floor(Math.random() * 1000000);
  const TOKEN = `h.${b64({ id: USER })}.s`;
  let sequelize, server, base, w, shopId, bread, sugar1, sugar2, cust;
  const net = { offline: false, log: [] };
  const uid = () => require('crypto').randomUUID();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(25); } return false; };
  const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const q = (sql, repl) => sequelize.query(sql, { replacements: repl || {}, type: 'SELECT' });
  const click = (sel) => { const el = w.document.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
  const setv = (id, v) => { w.document.getElementById(id).value = v; };
  const appText = () => { const c = w.document.body.cloneNode(true); c.querySelectorAll('script,style').forEach((n) => n.remove()); return c.textContent; };
  const say = async (text) => { const n = w.__duka.S.va.log.length; setv('vaText', text); click('[data-act=vaSend]'); await until(() => w.__duka.S.va.log.length >= n + 2 && !/…$/.test(w.document.getElementById('vaLog').textContent)); await wait(30); };
  const lastBot = () => { const l = w.__duka.S.va.log.filter((m) => m.who === 'bot'); return l[l.length - 1].text; };
  const posts = () => net.log.filter((l) => l.startsWith('POST')).length;
  const count = async (tbl, extra = '') => (await q(`SELECT COUNT(*)::int AS n FROM ${tbl} WHERE shop_id = :s ${extra}`, { s: shopId }))[0].n;
  const outbox = () => JSON.parse(w.localStorage.getItem('necpra_duka_outbox_v1') || '[]');
  const stockOf = async (id) => Number((await q(`SELECT stock_qty FROM duka_products WHERE id = :p`, { p: id }))[0].stock_qty);

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance']) await require(`../../migrations/${m}.js`).up({ sequelize });
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize, authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    w = new JSDOM(HTML, {
      virtualConsole: new VirtualConsole().sendTo(console, { omitJSDOMErrors: false }), url: 'https://necpra.co.ke/duka.html', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) {
        win.localStorage.setItem('authToken', TOKEN); win.API_BASE_URL = 'https://api.test';
        Object.defineProperty(win.navigator, 'onLine', { get: () => !net.offline });
        win.fetch = async (u, o) => {
          const p = u.replace('https://api.test/api/duka', ''), m = (o && o.method) || 'GET';
          if (net.offline) throw new TypeError('Failed to fetch');
          net.log.push(m + ' ' + p.split('?')[0]);
          const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-test-user': String(USER) }, body: o && o.body });
          const text = await r.text(); return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
        };
      }
    }).window;
    await until(() => w.__duka && w.__duka.S.shopId && w.document.querySelector('[data-act=vaOpen]'));
    shopId = w.__duka.S.shopId; bread = uid(); sugar1 = uid(); sugar2 = uid(); cust = uid();
    await api('POST', `/shops/${shopId}/products`, { id: bread, name: 'Bread', buyingPrice: 40, sellingPrice: 60, stockQty: 5, minStock: 10 });
    await api('POST', `/shops/${shopId}/products`, { id: sugar1, name: 'Sugar 1kg', buyingPrice: 100, sellingPrice: 150, stockQty: 50 });
    await api('POST', `/shops/${shopId}/products`, { id: sugar2, name: 'Sugar 2kg', buyingPrice: 190, sellingPrice: 280, stockQty: 30 });
    await api('POST', `/shops/${shopId}/customers`, { id: cust, name: 'Wanjiru' });
    await api('POST', `/shops/${shopId}/sales`, { id: uid(), customerId: cust, items: [{ productId: sugar1, qty: 2, unitPrice: 150 }], payments: [] });   // Wanjiru owes 300
    click('[data-act=vaOpen]');
  });
  afterAll(async () => { if (w) { net.offline = true; await wait(600); w.close(); } if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('the assistant button is on the screen and opens the assistant', () => {
    expect(w.document.getElementById('vaPanel')).toBeTruthy();
    expect(w.document.getElementById('vaText')).toBeTruthy();
  });

  test('reads answer straight away and never write anything', async () => {
    const before = posts();
    await say('how much bread is left'); expect(lastBot()).toMatch(/Bread: 5/); expect(lastBot()).toMatch(/low/i);
    await say('sukari imebaki ngapi'); expect(lastBot()).toMatch(/Sugar 1kg: 48/); expect(lastBot()).toMatch(/Sugar 2kg: 30/);   // Kiswahili product word
    await say('what is low on stock'); expect(lastBot()).toMatch(/Bread/);
    await say('who owes me'); expect(lastBot()).toMatch(/KSh\s?300/);
    await say('Wanjiru anadaiwa kiasi gani'); expect(lastBot()).toMatch(/Wanjiru anadaiwa KSh\s?300/);
    await say("today's report");
    const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const api1 = (await api('GET', `/shops/${shopId}/reports?period=daily&from=${today}&to=${today}`)).body.data.totals;
    const m = /net profit KSh\s?([\d,.]+)/.exec(lastBot()); expect(m).toBeTruthy(); expect(Number(m[1].replace(/,/g, ''))).toBe(api1.netProfit);
    await say('ripoti ya leo'); expect(lastBot()).toMatch(/faida halisi/);
    await say('hello there'); expect(lastBot()).toMatch(/did not understand/i);
    expect(posts()).toBe(before);
    expect(w.__duka.S.va.pending).toBeNull();
  });

  test('a sale only happens after Confirm; cancel and "yes" change nothing; double tap sells once', async () => {
    const sales0 = await count('duka_sales'), before = posts();
    await say('sell 2 bread');
    expect(w.document.querySelector('[data-act=vaConfirm]')).toBeTruthy();
    expect(appText()).toMatch(/Total to receive in cash:\s*KSh\s?120/);
    expect(posts()).toBe(before); expect(await count('duka_sales')).toBe(sales0);
    await say('yes');                                                         // saying yes must NOT confirm
    expect(lastBot()).toMatch(/cannot confirm by voice/i); expect(await count('duka_sales')).toBe(sales0);
    click('[data-act=vaCancel]'); expect(w.__duka.S.va.pending).toBeNull(); expect(await count('duka_sales')).toBe(sales0);
    await say('sell 2 bread');
    click('[data-act=vaConfirm]'); click('[data-act=vaConfirm]');             // double tap
    expect(await until(async () => (await count('duka_sales')) === sales0 + 1)).toBe(true);
    await wait(300);
    expect(await count('duka_sales')).toBe(sales0 + 1); expect(await stockOf(bread)).toBe(3);
    expect(lastBot()).toMatch(/Sale recorded/);
    const s = (await q(`SELECT total, amount_paid, balance_due FROM duka_sales WHERE shop_id = :s ORDER BY created_at DESC LIMIT 1`, { s: shopId }))[0];
    expect([Number(s.total), Number(s.amount_paid), Number(s.balance_due)]).toEqual([120, 120, 0]);
  });

  test('cannot sell more than is in stock; a new command replaces an unconfirmed one', async () => {
    const sales0 = await count('duka_sales');
    await say('sell 99 bread'); click('[data-act=vaConfirm]');
    await until(() => /Only 3/.test(lastBot())); expect(lastBot()).toMatch(/Only 3/); expect(await count('duka_sales')).toBe(sales0);
    await say('who owes me');                                                  // a new command drops the unconfirmed sale
    expect(w.__duka.S.va.pending).toBeNull(); expect(w.document.querySelector('[data-act=vaConfirm]')).toBeFalsy(); expect(await count('duka_sales')).toBe(sales0);
  });

  test('ambiguous product: asks which one, then confirms the chosen one', async () => {
    const s0 = await stockOf(sugar2), sales0 = await count('duka_sales');
    await say('sell 1 sugar'); expect(lastBot()).toMatch(/Which/i);
    expect(w.document.querySelectorAll('[data-act=vaPick]').length).toBe(2); expect(w.document.querySelector('[data-act=vaConfirm]')).toBeFalsy();
    click(`[data-act=vaPick][data-id="${sugar2}"]`);
    expect(appText()).toMatch(/Total to receive in cash:\s*KSh\s?280/);
    click('[data-act=vaConfirm]');
    expect(await until(async () => (await count('duka_sales')) === sales0 + 1)).toBe(true);
    await wait(200); expect(await stockOf(sugar2)).toBe(s0 - 1);
  });

  test('Kiswahili expense: card is editable, saved only after Confirm', async () => {
    const e0 = await count('duka_expenses');
    await say('nimetumia mia tano kwa usafiri');
    expect(w.document.getElementById('vaAmt').value).toBe('500'); expect(w.document.getElementById('vaCat').value).toBe('transport');
    expect(await count('duka_expenses')).toBe(e0);
    setv('vaAmt', '450'); click('[data-act=vaConfirm]');                       // owner corrects what was heard
    expect(await until(async () => (await count('duka_expenses')) === e0 + 1)).toBe(true);
    const e = (await q(`SELECT amount, category, method FROM duka_expenses WHERE shop_id = :s ORDER BY created_at DESC LIMIT 1`, { s: shopId }))[0];
    expect([Number(e.amount), e.category, e.method]).toEqual([450, 'transport', 'cash']); expect(lastBot()).toMatch(/imerekodiwa/);
  });

  test('add product by voice (Kiswahili): checked, corrected, then saved; incomplete product is refused', async () => {
    await say('ongeza bidhaa unga bei ya kununua 100 bei ya kuuza 130 idadi 20');
    expect(w.document.getElementById('vaName').value).toBe('unga'); expect(w.document.getElementById('vaBuy').value).toBe('100'); expect(w.document.getElementById('vaSell').value).toBe('130');
    expect(await count('duka_products', `AND name = 'unga'`)).toBe(0);
    setv('vaName', 'Unga 2kg'); setv('vaSell', '140'); click('[data-act=vaConfirm]');
    expect(await until(async () => (await count('duka_products', `AND name = 'Unga 2kg'`)) === 1)).toBe(true);
    const p = (await q(`SELECT selling_price, buying_price, stock_qty FROM duka_products WHERE shop_id = :s AND name = 'Unga 2kg'`, { s: shopId }))[0];
    expect([Number(p.buying_price), Number(p.selling_price), Number(p.stock_qty)]).toEqual([100, 140, 20]);
    const n0 = await count('duka_products');
    await say('add product soap'); click('[data-act=vaConfirm]');
    await until(() => /buying price/i.test(lastBot())); expect(lastBot()).toMatch(/buying price/i); expect(await count('duka_products')).toBe(n0);
    click('[data-act=vaCancel]');
  });

  test('offline: a confirmed expense is kept on the phone and syncs later; reads use saved data', async () => {
    net.offline = true; w.dispatchEvent(new w.Event('offline'));
    await say('spent 75 on rent'); click('[data-act=vaConfirm]');
    expect(await until(() => outbox().length === 1)).toBe(true); expect(lastBot()).toMatch(/Saved on this phone/);
    expect(await count('duka_expenses', 'AND amount = 75')).toBe(0);
    await say('how much bread is left');
    expect(lastBot()).toMatch(/Bread: 3/);           // from saved data
    net.offline = false; w.dispatchEvent(new w.Event('online'));
    expect(await until(async () => (await count('duka_expenses', 'AND amount = 75')) === 1, 8000)).toBe(true);
    expect(await until(() => outbox().length === 0)).toBe(true);
  });
});
