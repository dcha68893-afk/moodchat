'use strict';
/**
 * NECPRA DUKA SMART — Phase 1 + 2 integration tests (real Postgres, no mocks).
 * Runs only when DUKA_TEST_DB_URL is set, e.g.
 *   DUKA_TEST_DB_URL=postgres://user:pass@localhost:5432/dukatest npx jest tests/current/duka.test.js
 * Skips cleanly otherwise so the default `npm test` never needs a database.
 */
const URL_ = process.env.DUKA_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;

d('duka phase 1', () => {
  const express = require('express');
  const { Sequelize } = require('sequelize');
  let sequelize, server, base;
  const A = 101, B = 202, S = 303; // S: dedicated to the shop-limit test

  const call = async (user, method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const uid = () => require('crypto').randomUUID();

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    await require('../../migrations/20261111000001-create-duka-smart-phase1.js').up({ sequelize });
    await require('../../migrations/20261111000001-create-duka-smart-phase1.js').up({ sequelize }); // idempotent re-run
    await require('../../migrations/20261111000002-create-duka-smart-phase2.js').up({ sequelize });
    await require('../../migrations/20261111000002-create-duka-smart-phase2.js').up({ sequelize }); // idempotent re-run
    await sequelize.query('TRUNCATE duka_audit_log, duka_sale_payments, duka_sale_items, duka_sales, duka_customers, duka_receipt_counters, duka_stock_movements, duka_products, duka_shops CASCADE');
    const { buildRouter } = require('../../src/routes/duka');
    const app = express();
    app.use(express.json());
    app.use('/api/duka', buildRouter({
      getSequelize: () => sequelize,
      authenticate: (req, res, next) => {
        const u = req.headers['x-test-user'];
        if (!u) return res.status(401).json({ success: false });
        req.user = { id: Number(u) }; next();
      }
    }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
  });
  afterAll(async () => { if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('requires authentication', async () => {
    const r = await fetch(base + '/shops');
    expect(r.status).toBe(401);
  });

  test('shop create/validate/idempotent/limit/archive', async () => {
    expect((await call(S, 'POST', '/shops', {})).status).toBe(400);
    expect((await call(S, 'POST', '/shops', { name: 'x', phone: '12345' })).status).toBe(400);
    const id = uid();
    const c1 = await call(S, 'POST', '/shops', { id, name: 'Mama Njeri Duka', phone: '0712345678', location: 'Kawangware' });
    expect(c1.status).toBe(201);
    expect(c1.body.data.shop.phone).toBe('+254712345678');
    const c2 = await call(S, 'POST', '/shops', { id, name: 'Mama Njeri Duka' });
    expect(c2.status).toBe(200); expect(c2.body.data.idempotent).toBe(true);
    expect((await call(S, 'POST', '/shops', { name: 'mama njeri duka' })).status).toBe(409); // dup name
    expect((await call(B, 'POST', '/shops', { id, name: 'Steal' })).status).toBe(409);       // id owned by A
    for (let i = 2; i <= 5; i++) expect((await call(S, 'POST', '/shops', { name: 'Shop ' + i })).status).toBe(201);
    const over = await call(S, 'POST', '/shops', { name: 'Shop 6' });
    expect(over.status).toBe(409); expect(over.body.errorCode).toBe('SHOP_LIMIT');
    const list = await call(S, 'GET', '/shops');
    expect(list.body.data.shops).toHaveLength(5);
    expect((await call(S, 'DELETE', `/shops/${list.body.data.shops[4].id}`)).status).toBe(200);
    expect((await call(S, 'GET', '/shops')).body.data.shops).toHaveLength(4);
  });

  test('ownership isolation: B can never see or touch A\'s data', async () => {
    const shop = (await call(A, 'POST', '/shops', { name: 'Iso shop A' }));
    const sid = shop.body.data.shop.id;
    const p = await call(A, 'POST', `/shops/${sid}/products`, { name: 'Sugar', buyingPrice: 150, sellingPrice: 180, stockQty: 10, minStock: 3 });
    const pid = p.body.data.product.id;
    for (const [m, path, body] of [
      ['GET', `/shops/${sid}`], ['PATCH', `/shops/${sid}`, { name: 'hack' }], ['DELETE', `/shops/${sid}`],
      ['GET', `/shops/${sid}/products`], ['POST', `/shops/${sid}/products`, { name: 'x', buyingPrice: 1, sellingPrice: 2 }],
      ['GET', `/shops/${sid}/products/${pid}`], ['PATCH', `/shops/${sid}/products/${pid}`, { name: 'hack' }],
      ['DELETE', `/shops/${sid}/products/${pid}`], ['POST', `/shops/${sid}/products/${pid}/stock`, { qtyChange: 5 }],
      ['GET', `/shops/${sid}/products/${pid}/movements`], ['GET', `/shops/${sid}/dashboard`], ['GET', `/shops/${sid}/audit`]
    ]) {
      const r = await call(B, m, path, body);
      expect([m + path, r.status]).toEqual([m + path, 404]);
    }
    expect((await call(B, 'GET', '/shops')).body.data.shops).toHaveLength(0);
    // And B's own shop cannot reach A's product through B's shop id (cross-shop product id).
    const bs = (await call(B, 'POST', '/shops', { name: 'B shop' })).body.data.shop.id;
    expect((await call(B, 'GET', `/shops/${bs}/products/${pid}`)).status).toBe(404);
    expect((await call(B, 'POST', `/shops/${bs}/products/${pid}/stock`, { qtyChange: 99 })).status).toBe(404);
    expect((await call(B, 'POST', `/shops/${bs}/products`, { id: pid, name: 'Dup', buyingPrice: 1, sellingPrice: 2 })).status).toBe(409);
    // Untouched.
    expect((await call(A, 'GET', `/shops/${sid}/products/${pid}`)).body.data.product.stockQty).toBe(10);
  });

  test('product validation, duplicates, idempotent create, no direct stock edit', async () => {
    const sid = (await call(A, 'POST', '/shops', { name: 'Prod shop' })).body.data.shop.id;
    const P = `/shops/${sid}/products`;
    expect((await call(A, 'POST', P, { name: 'A', buyingPrice: -1, sellingPrice: 5 })).status).toBe(400);
    expect((await call(A, 'POST', P, { name: 'A', buyingPrice: 1.234, sellingPrice: 5 })).status).toBe(400);
    expect((await call(A, 'POST', P, { name: 'A', buyingPrice: 'abc', sellingPrice: 5 })).status).toBe(400);
    expect((await call(A, 'POST', P, { buyingPrice: 1, sellingPrice: 2 })).status).toBe(400);
    const pid = uid();
    const ok = await call(A, 'POST', P, { id: pid, name: 'Maize flour 2kg', category: 'Flour', unit: 'packet', buyingPrice: 120, sellingPrice: 140, stockQty: 24, minStock: 6, barcode: '616001' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.product.marginPerUnit).toBe(20);
    expect((await call(A, 'POST', P, { id: pid, name: 'Maize flour 2kg', buyingPrice: 120, sellingPrice: 140 })).body.data.idempotent).toBe(true);
    expect((await call(A, 'POST', P, { name: 'MAIZE FLOUR 2KG', buyingPrice: 1, sellingPrice: 2 })).status).toBe(409);
    const bc = await call(A, 'POST', P, { name: 'Other', buyingPrice: 1, sellingPrice: 2, barcode: '616001' });
    expect(bc.status).toBe(409); expect(bc.body.message).toMatch(/barcode/);
    expect((await call(A, 'PATCH', `${P}/${pid}`, { stockQty: 1000 })).body.errorCode).toBe('USE_STOCK_ENDPOINT');
    const ed = await call(A, 'PATCH', `${P}/${pid}`, { sellingPrice: 150, minStock: 8 });
    expect(ed.body.data.product.sellingPrice).toBe(150);
    expect(ed.body.data.product.stockQty).toBe(24);
    const s = await call(A, 'GET', `${P}?search=maize`);
    expect(s.body.data.total).toBe(1);
    expect((await call(A, 'GET', `${P}?search=%25`)).body.data.total).toBe(0); // LIKE wildcard escaped
  });

  test('stock ledger: adjust, idempotent retry, no negative stock, concurrency', async () => {
    const sid = (await call(A, 'POST', '/shops', { name: 'Stock shop' })).body.data.shop.id;
    const P = `/shops/${sid}/products`;
    const pid = (await call(A, 'POST', P, { name: 'Milk', buyingPrice: 50, sellingPrice: 60, stockQty: 10, minStock: 4 })).body.data.product.id;
    const op = uid();
    const a1 = await call(A, 'POST', `${P}/${pid}/stock`, { qtyChange: -3, clientOpId: op, note: 'spillage' });
    expect(a1.status).toBe(201); expect(a1.body.data.product.stockQty).toBe(7);
    const a2 = await call(A, 'POST', `${P}/${pid}/stock`, { qtyChange: -3, clientOpId: op });
    expect(a2.status).toBe(200); expect(a2.body.data.idempotent).toBe(true);
    expect(a2.body.data.product.stockQty).toBe(7);                                   // not decremented twice
    const neg = await call(A, 'POST', `${P}/${pid}/stock`, { qtyChange: -8 });
    expect(neg.status).toBe(409); expect(neg.body.errorCode).toBe('INSUFFICIENT_STOCK');
    expect((await call(A, 'POST', `${P}/${pid}/stock`, { qtyChange: 0 })).status).toBe(400);
    expect((await call(A, 'POST', `${P}/${pid}/stock`, { qtyChange: 2, type: 'damage' })).status).toBe(400);
    // 10 parallel -1 adjustments with distinct ops on stock 7 → exactly 7 succeed, none go negative.
    const rs = await Promise.all(Array.from({ length: 10 }, () => call(A, 'POST', `${P}/${pid}/stock`, { qtyChange: -1, clientOpId: uid() })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(7);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    const fin = (await call(A, 'GET', `${P}/${pid}`)).body.data.product;
    expect(fin.stockQty).toBe(0); expect(fin.isOutOfStock).toBe(true);
    // Ledger sums to the balance.
    const mv = (await call(A, 'GET', `${P}/${pid}/movements?limit=200`)).body.data.movements;
    expect(mv.reduce((s, m) => s + m.qtyChange, 0)).toBe(0);
  });

  test('delete protection: history → archive, no history → delete', async () => {
    const sid = (await call(A, 'POST', '/shops', { name: 'Del shop' })).body.data.shop.id;
    const P = `/shops/${sid}/products`;
    const clean = (await call(A, 'POST', P, { name: 'Clean', buyingPrice: 1, sellingPrice: 2, stockQty: 5 })).body.data.product.id;
    const d1 = await call(A, 'DELETE', `${P}/${clean}`);
    expect(d1.body.data.deleted).toBe(true);
    expect((await call(A, 'GET', `${P}/${clean}`)).status).toBe(404);
    const used = (await call(A, 'POST', P, { name: 'Used', buyingPrice: 1, sellingPrice: 2, stockQty: 5 })).body.data.product.id;
    await call(A, 'POST', `${P}/${used}/stock`, { qtyChange: -1 });
    const d2 = await call(A, 'DELETE', `${P}/${used}`);
    expect(d2.body.data.archived).toBe(true);
    expect((await call(A, 'GET', `${P}`)).body.data.products.find((p) => p.id === used)).toBeUndefined();
    expect((await call(A, 'GET', `${P}?includeArchived=true`)).body.data.products.find((p) => p.id === used).isActive).toBe(false);
    // Name is free again for a new product after archive.
    expect((await call(A, 'POST', P, { name: 'Used', buyingPrice: 1, sellingPrice: 2 })).status).toBe(201);
    const audit = (await call(A, 'GET', `/shops/${sid}/audit`)).body.data.entries.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['product.create', 'product.delete', 'product.archive', 'stock.adjust']));
  });

  test('dashboard uses real data and reports untracked sections as null', async () => {
    const sid = (await call(A, 'POST', '/shops', { name: 'Dash shop' })).body.data.shop.id;
    const P = `/shops/${sid}/products`;
    await call(A, 'POST', P, { name: 'Rice', buyingPrice: 100, sellingPrice: 130, stockQty: 10, minStock: 2 });   // ok
    await call(A, 'POST', P, { name: 'Oil', buyingPrice: 300, sellingPrice: 350, stockQty: 2, minStock: 5 });     // low
    await call(A, 'POST', P, { name: 'Salt', buyingPrice: 20, sellingPrice: 30, stockQty: 0, minStock: 5 });      // out
    const dash = (await call(A, 'GET', `/shops/${sid}/dashboard`)).body.data;
    expect(dash.stock.productCount).toBe(3);
    expect(dash.stock.valueAtCost).toBe(10 * 100 + 2 * 300);
    expect(dash.stock.valueAtRetail).toBe(10 * 130 + 2 * 350);
    expect(dash.stock.lowStockCount).toBe(1);
    expect(dash.stock.outOfStockCount).toBe(1);
    expect(dash.lowStockProducts.map((p) => p.name).sort()).toEqual(['Oil', 'Salt']);
    // Phase 2 tracks sales: a shop with no sales shows a real zero; Phase 3 sections stay null (not tracked yet).
    expect(dash.todaySales.total).toBe(0); expect(dash.todaySales.count).toBe(0);
    expect(dash.customerDebts.total).toBe(0);
    expect(dash.totalExpenses).toBeNull(); expect(dash.supplierDebts).toBeNull();
  });

  /* ───────────────────────── Phase 2: POS / sales ───────────────────────── */
  const mk = async (user, name, products) => {
    const sid = (await call(user, 'POST', '/shops', { name })).body.data.shop.id;
    const ids = {};
    for (const [key, p] of Object.entries(products)) {
      ids[key] = (await call(user, 'POST', `/shops/${sid}/products`, p)).body.data.product.id;
    }
    return { sid, ids };
  };
  const stockOf = async (user, sid, pid) => (await call(user, 'GET', `/shops/${sid}/products/${pid}`)).body.data.product.stockQty;

  test('sale: server-side pricing, discount, stock deduction, ledger, receipt', async () => {
    const A = 401; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS basic', {
      sugar: { name: 'Sugar 1kg', unit: 'kg', buyingPrice: 150, sellingPrice: 180, stockQty: 10, minStock: 2 },
      oil: { name: 'Cooking oil 1L', buyingPrice: 300, sellingPrice: 350, stockQty: 5, minStock: 1 }
    });
    const id = uid();
    const r = await call(A, 'POST', `/shops/${sid}/sales`, {
      id, items: [{ productId: ids.sugar, qty: 2 }, { productId: ids.oil, qty: 1.5 }],
      discount: { type: 'amount', value: 25 }, payments: [{ method: 'cash', amount: 860 }]
    });
    expect(r.status).toBe(201);
    const s = r.body.data.sale;
    // 2*180 + 1.5*350 = 885, minus 25 = 860; COGS 2*150 + 1.5*300 = 750; profit 110
    expect([s.subtotal, s.discountAmount, s.total, s.amountPaid, s.balanceDue]).toEqual([885, 25, 860, 860, 0]);
    expect(s.cogs).toBe(750); expect(s.grossProfit).toBe(110); expect(s.paymentStatus).toBe('paid'); expect(s.receiptNo).toBe(1);
    expect(r.body.data.items).toHaveLength(2);
    expect(r.body.data.shop.name).toBe('POS basic');
    expect(await stockOf(A, sid, ids.sugar)).toBe(8);
    expect(await stockOf(A, sid, ids.oil)).toBe(3.5);
    const mv = (await call(A, 'GET', `/shops/${sid}/products/${ids.sugar}/movements`)).body.data.movements;
    expect(mv[0]).toMatchObject({ type: 'sale', qtyChange: -2, balanceAfter: 8, referenceType: 'sale', referenceId: id });
    // Receipt numbers increment per shop.
    const r2 = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.sugar, qty: 1 }], payments: [{ method: 'cash', amount: 180 }] });
    expect(r2.body.data.sale.receiptNo).toBe(2);
    // Percent discount: 10% of 350 = 35.
    const r3 = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.oil, qty: 1 }], discount: { type: 'percent', value: 10 }, payments: [{ method: 'cash', amount: 315 }] });
    expect(r3.body.data.sale.discountAmount).toBe(35); expect(r3.body.data.sale.total).toBe(315);
    // Price override is honoured and snapshotted; later product edits do not rewrite the receipt.
    const r4 = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.sugar, qty: 1, unitPrice: 170 }], payments: [{ method: 'cash', amount: 170 }] });
    expect(r4.body.data.items[0].unitPrice).toBe(170);
    await call(A, 'PATCH', `/shops/${sid}/products/${ids.sugar}`, { sellingPrice: 999, name: 'Renamed' });
    const rc = await call(A, 'GET', `/shops/${sid}/sales/${id}`);
    expect(rc.body.data.items.map((i) => i.name).sort()).toEqual(['Cooking oil 1L', 'Sugar 1kg']);
    expect(rc.body.data.items.find((i) => i.name === 'Sugar 1kg').unitPrice).toBe(180);
  });

  test('sale idempotency: replaying the same sale id never double-deducts', async () => {
    const A = 402; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS idem', { rice: { name: 'Rice', buyingPrice: 100, sellingPrice: 130, stockQty: 10 } });
    const body = { id: uid(), items: [{ productId: ids.rice, qty: 3 }], payments: [{ method: 'cash', amount: 390 }] };
    const a = await call(A, 'POST', `/shops/${sid}/sales`, body);
    const b = await call(A, 'POST', `/shops/${sid}/sales`, body);
    expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.body.data.idempotent).toBe(true);
    expect(b.body.data.sale.receiptNo).toBe(a.body.data.sale.receiptNo);
    expect(await stockOf(A, sid, ids.rice)).toBe(7);
    // 5 simultaneous retries of one new sale → exactly one is created.
    const dup = { id: uid(), items: [{ productId: ids.rice, qty: 1 }], payments: [{ method: 'cash', amount: 130 }] };
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(A, 'POST', `/shops/${sid}/sales`, dup)));
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
    expect(rs.filter((x) => x.status === 200)).toHaveLength(4);
    expect(await stockOf(A, sid, ids.rice)).toBe(6);
    // Another user cannot hijack the id.
    const bShop = (await call(B, 'POST', '/shops', { name: 'B idem' })).body.data.shop.id;
    expect((await call(B, 'POST', `/shops/${bShop}/sales`, { ...dup, items: [{ productId: ids.rice, qty: 1 }] })).status).toBe(409);
  });

  test('sale: stock is never oversold, even under concurrency; failed sales change nothing', async () => {
    const A = 403; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS stock', { egg: { name: 'Egg tray', buyingPrice: 400, sellingPrice: 450, stockQty: 5 }, tea: { name: 'Tea', buyingPrice: 50, sellingPrice: 60, stockQty: 100 } });
    const over = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.tea, qty: 1 }, { productId: ids.egg, qty: 6 }], payments: [{ method: 'cash', amount: 3000 }] });
    expect(over.status).toBe(409); expect(over.body.errorCode).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(A, sid, ids.tea)).toBe(100);   // whole sale rolled back, including the valid line
    expect(await stockOf(A, sid, ids.egg)).toBe(5);
    const rs = await Promise.all(Array.from({ length: 8 }, () =>
      call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.egg, qty: 1 }], payments: [{ method: 'cash', amount: 450 }] })));
    expect(rs.filter((x) => x.status === 201)).toHaveLength(5);
    expect(rs.filter((x) => x.status === 409)).toHaveLength(3);
    expect(await stockOf(A, sid, ids.egg)).toBe(0);
    const list = (await call(A, 'GET', `/shops/${sid}/sales`)).body.data;
    expect(list.summary.count).toBe(5);                   // no phantom sales from the failed attempts
    const receipts = list.sales.map((x) => x.receiptNo).sort((x, y) => x - y);
    expect(receipts).toEqual([1, 2, 3, 4, 5]);           // no gaps
  });

  test('sale validation', async () => {
    const A = 404; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS valid', { gum: { name: 'Gum', buyingPrice: 5, sellingPrice: 10, stockQty: 50 } });
    const P = `/shops/${sid}/sales`;
    const ok = { productId: ids.gum, qty: 1 };
    const cash = [{ method: 'cash', amount: 10 }];
    const bad = async (body) => (await call(A, 'POST', P, { id: uid(), items: [ok], payments: cash, ...body })).status;
    expect(await bad({ id: undefined })).toBe(400);                         // sale id required
    expect(await bad({ id: 'nope' })).toBe(400);
    expect(await bad({ items: [] })).toBe(400);
    expect(await bad({ items: [{ productId: ids.gum, qty: 0 }] })).toBe(400);
    expect(await bad({ items: [{ productId: ids.gum, qty: -2 }] })).toBe(400);
    expect(await bad({ items: [{ productId: ids.gum, qty: 'x' }] })).toBe(400);
    expect(await bad({ items: [ok, ok] })).toBe(400);                       // duplicate line
    expect(await bad({ items: [{ productId: ids.gum, qty: 1, unitPrice: -1 }] })).toBe(400);
    expect(await bad({ discount: { type: 'amount', value: 11 } })).toBe(400);   // > subtotal
    expect(await bad({ discount: { type: 'amount', value: 10 } })).toBe(400);   // total would be 0
    expect(await bad({ discount: { type: 'percent', value: 101 } })).toBe(400);
    expect(await bad({ discount: { type: 'bogus', value: 1 } })).toBe(400);
    expect(await bad({ payments: [{ method: 'cash', amount: 11 }] })).toBe(400);   // overpayment
    expect(await bad({ payments: [{ method: 'card', amount: 10 }] })).toBe(400);
    expect(await bad({ payments: [{ method: 'cash', amount: 0 }] })).toBe(400);
    expect(await bad({ soldAt: 'garbage' })).toBe(400);
    expect(await bad({ soldAt: new Date(Date.now() + 3600e3).toISOString() })).toBe(400);
    expect(await bad({ soldAt: new Date(Date.now() - 200 * 86400e3).toISOString() })).toBe(400);
    expect(await bad({ items: [{ productId: uid(), qty: 1 }] })).toBe(404);   // unknown product
    expect(await stockOf(A, sid, ids.gum)).toBe(50);
    // Offline sale keeps its real time.
    const when = new Date(Date.now() - 2 * 86400e3).toISOString();
    const r = await call(A, 'POST', P, { id: uid(), items: [ok], payments: cash, soldAt: when });
    expect(new Date(r.body.data.sale.soldAt).toISOString()).toBe(when);
  });

  test('credit and partial payments: debt is not cash; customer required; isolated per shop', async () => {
    const A = 405; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS credit', { flour: { name: 'Flour', buyingPrice: 100, sellingPrice: 140, stockQty: 100 } });
    const P = `/shops/${sid}/sales`;
    const noCust = await call(A, 'POST', P, { id: uid(), items: [{ productId: ids.flour, qty: 2 }], payments: [] });
    expect(noCust.status).toBe(400); expect(noCust.body.errorCode).toBe('CUSTOMER_REQUIRED');
    expect((await call(A, 'POST', P, { id: uid(), items: [{ productId: ids.flour, qty: 2 }], payments: [{ method: 'cash', amount: 100 }] })).body.errorCode).toBe('CUSTOMER_REQUIRED');
    const cid = uid();
    expect((await call(A, 'POST', `/shops/${sid}/customers`, { id: cid, name: 'Wanjiku', phone: '0722000111' })).status).toBe(201);
    expect((await call(A, 'POST', `/shops/${sid}/customers`, { id: cid, name: 'Wanjiku' })).body.data.idempotent).toBe(true);
    // Full credit.
    const c = await call(A, 'POST', P, { id: uid(), customerId: cid, items: [{ productId: ids.flour, qty: 2 }], payments: [] });
    expect(c.status).toBe(201);
    expect([c.body.data.sale.paymentStatus, c.body.data.sale.amountPaid, c.body.data.sale.balanceDue]).toEqual(['credit', 0, 280]);
    // Partial.
    const p = await call(A, 'POST', P, { id: uid(), customerId: cid, items: [{ productId: ids.flour, qty: 5 }], payments: [{ method: 'cash', amount: 200 }] });
    expect([p.body.data.sale.paymentStatus, p.body.data.sale.amountPaid, p.body.data.sale.balanceDue]).toEqual(['partial', 200, 500]);
    const cust = (await call(A, 'GET', `/shops/${sid}/customers`)).body.data.customers.find((x) => x.id === cid);
    expect(cust.outstandingBalance).toBe(780);
    expect((await call(A, 'GET', `${P}?unpaid=true&customerId=${cid}`)).body.data.sales).toHaveLength(2);
    // Dashboard: sales 280+700 = 980; credit 780 is NOT cash; only 200 cash received; profit = revenue - COGS.
    const dash = (await call(A, 'GET', `/shops/${sid}/dashboard`)).body.data;
    expect(dash.todaySales.total).toBe(980);
    expect(dash.todaySales.cashReceived).toBe(200);
    expect(dash.todaySales.creditGiven).toBe(780);
    expect(dash.estimatedProfit).toBe(980 - 7 * 100);
    expect(dash.customerDebts.total).toBe(780);
    expect(dash.recentSales).toHaveLength(2);
    // A customer from another shop (even the same owner's) or another user cannot be charged.
    const other = (await call(A, 'POST', '/shops', { name: 'POS credit 2' })).body.data.shop.id;
    expect((await call(A, 'POST', `/shops/${other}/sales`, { id: uid(), customerId: cid, items: [{ productId: ids.flour, qty: 1 }], payments: [] })).status).toBe(404);
    const bShop = (await call(B, 'POST', '/shops', { name: 'B credit' })).body.data.shop.id;
    expect((await call(B, 'POST', `/shops/${bShop}/sales`, { id: uid(), customerId: cid, items: [{ productId: ids.flour, qty: 1 }], payments: [] })).status).toBe(404);
  });

  test('M-PESA is never accepted without a receipt code; codes cannot be reused; verified only against paid STK', async () => {
    const A = 406; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS mpesa', { soda: { name: 'Soda', buyingPrice: 40, sellingPrice: 60, stockQty: 100 } });
    const P = `/shops/${sid}/sales`;
    const item = [{ productId: ids.soda, qty: 2 }];
    const noCode = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120 }] });
    expect(noCode.status).toBe(400); expect(noCode.body.errorCode).toBe('MPESA_RECEIPT_REQUIRED');
    expect((await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'SHORT' }] })).status).toBe(400);
    expect((await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'bad code!!' }] })).status).toBe(400);
    expect(await stockOf(A, sid, ids.soda)).toBe(100);
    const ok = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'sgh7k2l9qx', payerPhone: '0711222333' }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.payments[0]).toMatchObject({ method: 'mpesa', mpesaReceipt: 'SGH7K2L9QX', verification: 'receipt_recorded', payerPhone: '+254711222333' });
    const reuse = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'SGH7K2L9QX' }] });
    expect(reuse.status).toBe(409); expect(reuse.body.message).toMatch(/already recorded/);
    expect(await stockOf(A, sid, ids.soda)).toBe(98);   // the rejected reuse deducted nothing
    // Split payment cash + mpesa.
    const split = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'cash', amount: 20 }, { method: 'mpesa', amount: 100, mpesaReceipt: 'ABC1234567' }] });
    expect(split.body.data.sale.paymentStatus).toBe('paid');
    // A code that matches a PAID stk_transactions row for >= amount is marked verified (table created here only for the test).
    await sequelize.query(`CREATE TABLE IF NOT EXISTS stk_transactions (mpesa_receipt VARCHAR(40), status VARCHAR(20), paid_amount NUMERIC(15,2))`);
    await sequelize.query(`INSERT INTO stk_transactions VALUES ('PAID123456','paid',120), ('SHORT12345','paid',50), ('FAIL123456','failed',120)`);
    const v = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'PAID123456' }] });
    expect(v.body.data.payments[0].verification).toBe('verified');
    const lowPaid = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'SHORT12345' }] });
    expect(lowPaid.body.data.payments[0].verification).toBe('receipt_recorded');
    const failed = await call(A, 'POST', P, { id: uid(), items: item, payments: [{ method: 'mpesa', amount: 120, mpesaReceipt: 'FAIL123456' }] });
    expect(failed.body.data.payments[0].verification).toBe('receipt_recorded');
    await sequelize.query('DROP TABLE stk_transactions');
    const dash = (await call(A, 'GET', `/shops/${sid}/dashboard`)).body.data;
    expect(dash.todaySales.mpesaReceived).toBe(120 + 100 + 120 * 3);
    expect(dash.todaySales.mpesaVerified).toBe(120);    // only the matched one counts as verified
  });

  test('sales are isolated: another user sees nothing and changes nothing; delete protection respects sale history', async () => {
    const A = 407; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS iso', { pen: { name: 'Pen', buyingPrice: 10, sellingPrice: 20, stockQty: 10 } });
    const saleId = uid();
    await call(A, 'POST', `/shops/${sid}/sales`, { id: saleId, items: [{ productId: ids.pen, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] });
    for (const [m, path, body] of [
      ['GET', `/shops/${sid}/sales`], ['GET', `/shops/${sid}/sales/${saleId}`], ['GET', `/shops/${sid}/customers`],
      ['POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.pen, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] }],
      ['POST', `/shops/${sid}/customers`, { name: 'x' }]
    ]) expect([m + path, (await call(B, m, path, body)).status]).toEqual([m + path, 404]);
    const bs = (await call(B, 'POST', '/shops', { name: 'B pos' })).body.data.shop.id;
    expect((await call(B, 'GET', `/shops/${bs}/sales/${saleId}`)).status).toBe(404);
    expect((await call(B, 'POST', `/shops/${bs}/sales`, { id: uid(), items: [{ productId: ids.pen, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] })).status).toBe(404);
    expect(await stockOf(A, sid, ids.pen)).toBe(9);
    // A product that has been sold can only be archived.
    const del = await call(A, 'DELETE', `/shops/${sid}/products/${ids.pen}`);
    expect(del.body.data.archived).toBe(true);
    expect((await call(A, 'GET', `/shops/${sid}/sales/${saleId}`)).body.data.items[0].name).toBe('Pen');
    // Archived product cannot be sold.
    const again = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: ids.pen, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] });
    expect(again.status).toBe(409);
    const audit = (await call(A, 'GET', `/shops/${sid}/audit`)).body.data.entries.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['sale.create']));
  });

  test('sales list filters by Nairobi date', async () => {
    const A = 408; // own user: Phase 1 tests already use up A's shop limit
    const { sid, ids } = await mk(A, 'POS dates', { nut: { name: 'Nuts', buyingPrice: 10, sellingPrice: 20, stockQty: 50 } });
    const day = (offset) => new Date(Date.now() - offset * 86400e3).toISOString();
    for (const off of [0, 3, 10]) {
      await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), soldAt: day(off), items: [{ productId: ids.nut, qty: 1 }], payments: [{ method: 'cash', amount: 20 }] });
    }
    const ymd = (off) => new Date(Date.now() - off * 86400e3 + 3 * 3600e3).toISOString().slice(0, 10); // Nairobi = UTC+3
    const w = (await call(A, 'GET', `/shops/${sid}/sales?from=${ymd(5)}`)).body.data;
    expect(w.summary.count).toBe(2);
    expect((await call(A, 'GET', `/shops/${sid}/sales?from=${ymd(5)}&to=${ymd(1)}`)).body.data.summary.count).toBe(1);
    expect((await call(A, 'GET', `/shops/${sid}/sales?from=garbage`)).status).toBe(400);
  });
});
