'use strict';
/**
 * NECPRA DUKA SMART — pack (crate -> egg) conversion and spoilage-losses-in-net-profit tests (real Postgres, no mocks).
 *   DUKA_TEST_DB_URL=postgres://user:pass@localhost:5432/dukatest npx jest tests/current/duka-packs-losses.test.js --runInBand
 */
const URL_ = process.env.DUKA_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;

d('duka packs + losses in net profit', () => {
  const express = require('express');
  const { Sequelize } = require('sequelize');
  let sequelize, server, base, sid;
  const A = 810000 + Math.floor(Math.random() * 100000), B = A + 1;
  const uid = () => require('crypto').randomUUID();
  const call = async (user, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const today = async () => (await sequelize.query(`SELECT to_char((NOW() AT TIME ZONE 'Africa/Nairobi')::date,'YYYY-MM-DD') AS d`, { type: 'SELECT' }))[0].d;

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance', '20261111000004-duka-sale-void-and-product-description', '20261111000005-duka-batches-waste-devices']) {
      await require(`../../migrations/${m}.js`).up({ sequelize });
    }
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize,
      authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    sid = (await call(A, 'POST', '/shops', { name: 'Packs ' + uid().slice(0, 5) })).body.data.shop.id;
  });
  afterAll(async () => { if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('a crate of 30 eggs becomes 30 eggs per crate at the right cost per egg', async () => {
    const pid = uid();
    const c = await call(A, 'POST', `/shops/${sid}/products`, { id: pid, name: 'Eggs', unit: 'piece', buyingPrice: 12, sellingPrice: 15, packUnit: 'crate', packSize: 30 });
    expect(c.status).toBe(201);
    expect(c.body.data.product.packUnit).toBe('crate'); expect(c.body.data.product.packSize).toBe(30);

    const bid = uid();
    const r = await call(A, 'POST', `/shops/${sid}/products/${pid}/batches`, { id: bid, packs: 2, packCost: 360 });
    expect(r.status).toBe(201);
    expect(r.body.data.stockQty).toBe(60);                 // 2 crates x 30
    expect(r.body.data.batch.unitCost).toBe(12);           // 360 / 30
    expect(r.body.data.batch.qtyReceived).toBe(60);
    // replay with the same id changes nothing
    const again = await call(A, 'POST', `/shops/${sid}/products/${pid}/batches`, { id: bid, packs: 2, packCost: 360 });
    expect(again.body.data.idempotent).toBe(true); expect(again.body.data.stockQty).toBe(60);

    // selling single eggs deducts single eggs
    const sale = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: pid, qty: 3 }], payments: [{ method: 'cash', amount: 45 }] });
    expect(sale.status).toBe(201);
    const p = (await call(A, 'GET', `/shops/${sid}/products/${pid}`)).body.data.product;
    expect(p.stockQty).toBe(57);
  });

  test('pack input is validated', async () => {
    const pid = uid();
    await call(A, 'POST', `/shops/${sid}/products`, { id: pid, name: 'NoPack', unit: 'kg', buyingPrice: 5, sellingPrice: 8 });
    expect((await call(A, 'POST', `/shops/${sid}/products/${pid}/batches`, { id: uid(), packs: 1, packCost: 100 })).status).toBe(400); // no pack size set
    expect((await call(A, 'POST', `/shops/${sid}/products`, { id: uid(), name: 'Half', unit: 'piece', buyingPrice: 1, sellingPrice: 2, packUnit: 'crate' })).status).toBe(400); // name without size
    const patched = await call(A, 'PATCH', `/shops/${sid}/products/${pid}`, { packUnit: 'sack', packSize: 50 });
    expect(patched.status).toBe(200); expect(patched.body.data.product.packSize).toBe(50);
    expect((await call(A, 'POST', `/shops/${sid}/products/${pid}/batches`, { id: uid(), packs: 1, packCost: 100, qty: 5, unitCost: 2 })).status).toBe(400); // both styles at once
    expect((await call(A, 'POST', `/shops/${sid}/products/${pid}/batches`, { id: uid(), packs: 0, packCost: 100 })).status).toBe(400);
    expect((await call(B, 'POST', `/shops/${sid}/products/${pid}/batches`, { id: uid(), packs: 1, packCost: 100 })).status).toBe(404); // another trader
    // editing the name leaves the pack alone
    const keep = await call(A, 'PATCH', `/shops/${sid}/products/${pid}`, { name: 'NoPack2' });
    expect(keep.body.data.product.packUnit).toBe('sack'); expect(keep.body.data.product.packSize).toBe(50);
  });

  test('confirmed spoilage reduces net profit (not revenue) in the report and the dashboard', async () => {
    const pid = uid();
    await call(A, 'POST', `/shops/${sid}/products`, { id: pid, name: 'Tomatoes', unit: 'kg', buyingPrice: 50, sellingPrice: 80, openingStock: 20 });
    const before = (await call(A, 'GET', `/shops/${sid}/dashboard`)).body.data;
    const sale = await call(A, 'POST', `/shops/${sid}/sales`, { id: uid(), items: [{ productId: pid, qty: 2 }], payments: [{ method: 'cash', amount: 160 }] });
    expect(sale.status).toBe(201);
    const loss = await call(A, 'POST', `/shops/${sid}/losses`, { id: uid(), productId: pid, qty: 3, reason: 'spoiled', handling: 'disposed' });
    expect(loss.status).toBe(201); expect(loss.body.data.loss.lossValue).toBe(150); // 3 kg x KSh 50 cost

    const dash = (await call(A, 'GET', `/shops/${sid}/dashboard`)).body.data;
    expect(dash.stockLossesToday - before.stockLossesToday).toBe(150);
    expect(Math.round((dash.netProfit - before.netProfit) * 100) / 100).toBe(Math.round((160 - 100 - 150) * 100) / 100); // gross 60 - loss 150
    expect(dash.todaySales.total - before.todaySales.total).toBe(160);           // revenue untouched by the loss

    const t = await today();
    const rep = (await call(A, 'GET', `/shops/${sid}/reports?period=daily&from=${t}&to=${t}`)).body.data;
    const tot = rep.totals;
    expect(tot.stockLosses).toBeGreaterThanOrEqual(150);
    expect(tot.revenue).toBe(rep.rows.reduce((s, r) => s + r.revenue, 0));
    expect(Math.round(tot.netProfit * 100) / 100).toBe(Math.round((tot.grossProfit - tot.expenses - tot.stockLosses) * 100) / 100);
    expect(rep.definitions.stockLosses).toBeTruthy();
    // another trader's report never includes these losses
    const sidB = (await call(B, 'POST', '/shops', { name: 'Other ' + uid().slice(0, 5) })).body.data.shop.id;
    const repB = (await call(B, 'GET', `/shops/${sidB}/reports?period=daily&from=${t}&to=${t}`)).body.data;
    expect(repB.totals.stockLosses).toBe(0);
  });
});
