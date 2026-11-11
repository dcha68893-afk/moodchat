'use strict';
/**
 * NECPRA DUKA SMART — Phase 1 integration tests (real Postgres, no mocks).
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
    await sequelize.query('TRUNCATE duka_audit_log, duka_stock_movements, duka_products, duka_shops CASCADE');
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
    expect(dash.todaySales).toBeNull(); expect(dash.customerDebts).toBeNull();
  });
});
