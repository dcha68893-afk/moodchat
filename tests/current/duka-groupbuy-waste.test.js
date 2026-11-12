'use strict';
/**
 * NECPRA DUKA SMART — Group Buying, Smart Waste Prevention, batches and Smart Scale device tests (real Postgres, no mocks).
 *   DUKA_TEST_DB_URL=postgres://user:pass@localhost:5432/dukatest npx jest tests/current/duka-groupbuy-waste.test.js --runInBand
 */
const URL_ = process.env.DUKA_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;

d('duka group buying + waste + devices', () => {
  const express = require('express');
  const { Sequelize } = require('sequelize');
  let sequelize, server, base;
  const U0 = 700000 + Math.floor(Math.random() * 200000) * 10; // fresh user ids every run
  const ORG = U0 + 1, T2 = U0 + 2, T3 = U0 + 3, SUP = U0 + 4, ADMIN = U0 + 5, OUTSIDER = U0 + 6;
  const uid = () => require('crypto').randomUUID();
  const call = async (user, method, path, body, headers) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const q = (sql, rep) => sequelize.query(sql, { replacements: rep, type: 'SELECT' });
  const shops = {};
  const mkShop = async (u, name) => { const r = await call(u, 'POST', '/shops', { name: name + uid().slice(0, 5) }); shops[u] = r.body.data.shop.id; return shops[u]; };
  const mkProduct = async (u, o) => { const id = uid(); const r = await call(u, 'POST', `/shops/${shops[u]}/products`, { id, buyingPrice: 50, sellingPrice: 80, openingStock: 0, unit: 'kg', ...o }); expect(r.status).toBe(201); return id; };
  const future = (h) => new Date(Date.now() + h * 3600000).toISOString();

  beforeAll(async () => {
    process.env.DUKA_ADMIN_IDS = String(ADMIN);
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance', '20261111000004-duka-sale-void-and-product-description', '20261111000005-duka-batches-waste-devices', '20261111000006-duka-group-buying']) {
      await require(`../../migrations/${m}.js`).up({ sequelize });
      await require(`../../migrations/${m}.js`).up({ sequelize }); // idempotent re-run
    }
    await sequelize.query('TRUNCATE duka_gb_audit, duka_gb_disputes, duka_gb_refunds, duka_gb_payments, duka_gb_participants, duka_gb_quotes, duka_gb_orders, duka_gb_suppliers, duka_device_readings, duka_devices CASCADE');
    await sequelize.query(`CREATE TABLE IF NOT EXISTS stk_transactions (mpesa_receipt VARCHAR(40), status VARCHAR(20), paid_amount NUMERIC(15,2))`);
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize,
      authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    for (const [u, n] of [[ORG, 'Org'], [T2, 'T2'], [T3, 'T3'], [OUTSIDER, 'Out']]) await mkShop(u, n);
  });
  afterAll(async () => { if (server) server.close(); if (sequelize) await sequelize.close(); });

  /* ───────────── batches, losses, waste prevention ───────────── */
  describe('perishable stock + waste prevention', () => {
    let pid;
    beforeAll(async () => { pid = await mkProduct(ORG, { name: 'Sukuma ' + uid().slice(0, 5), unit: 'bunch', buyingPrice: 10, sellingPrice: 20 }); });

    test('batches: separate dates/costs/shelf life, idempotent, ownership enforced', async () => {
      const b1 = { id: uid(), qty: 20, unitCost: 10, shelfLifeDays: 3, receivedAt: new Date(Date.now() - 2.4 * 86400000).toISOString() };
      const r1 = await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pid}/batches`, b1);
      expect(r1.status).toBe(201); expect(r1.body.data.stockQty).toBe(20);
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pid}/batches`, b1)).body.data.idempotent).toBe(true);
      expect((await call(ORG, 'GET', `/shops/${shops[ORG]}/products`)).body.data.products.find((p) => p.id === pid).stockQty).toBe(20); // not doubled
      const r2 = await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pid}/batches`, { id: uid(), qty: 10, unitCost: 14, shelfLifeDays: 5 });
      expect(r2.body.data.stockQty).toBe(30);
      expect(r2.body.data.buyingPrice).toBe(11.33); // weighted average of 20@10 and 10@14
      const list = await call(ORG, 'GET', `/shops/${shops[ORG]}/products/${pid}/batches`);
      expect(list.body.data.batches).toHaveLength(2);
      expect(list.body.data.batches.map((b) => b.shelfLifeDays).sort()).toEqual([3, 5]);
      expect((await call(OUTSIDER, 'POST', `/shops/${shops[ORG]}/products/${pid}/batches`, { id: uid(), qty: 1, unitCost: 1 })).status).toBe(404);
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pid}/batches`, { id: uid(), qty: 0, unitCost: 1 })).status).toBe(400);
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pid}/batches`, { id: uid(), qty: 1, unitCost: 1, receivedAt: future(48) })).status).toBe(400);
    });

    test('waste report: estimates, preliminary label, suggestion never changes price, warns when below cost', async () => {
      const w = await call(ORG, 'GET', `/shops/${shops[ORG]}/waste`);
      expect(w.status).toBe(200);
      const it = w.body.data.items.find((i) => i.productId === pid);
      expect(it.sales.confidence).toBe('preliminary');          // no sales history yet
      expect(it.reorder.suggestedQty).toBe(0);                  // no demand => no purchase advice
      expect(it.batches.every((b) => b.estimate === true)).toBe(true);
      const old = it.batches.find((b) => b.batchRef === null && b.ageDays > 1.5);
      expect(old.freshness).toBe('sell_soon');                  // 2.4 of 3 days used (80%)
      expect(it.valueAtRisk).toBeGreaterThan(0);
      expect(it.discountSuggestion.requiresSellerApproval).toBe(true);
      expect(it.discountSuggestion.priceChangedAutomatically).toBe(false);
      expect(it.discountSuggestion.suggestedPrice).toBe(17);    // 20 - 15%
      const after = (await call(ORG, 'GET', `/shops/${shops[ORG]}/products`)).body.data.products.find((p) => p.id === pid);
      expect(after.sellingPrice).toBe(20);                      // price untouched
      // below-cost case: selling 12, cost 11.33 -> 15% off (10.2) would be a loss
      await call(ORG, 'PATCH', `/shops/${shops[ORG]}/products/${pid}`, { sellingPrice: 12 });
      const w2 = (await call(ORG, 'GET', `/shops/${shops[ORG]}/waste`)).body.data.items.find((i) => i.productId === pid);
      expect(w2.discountSuggestion.suggestedPrice).toBeGreaterThanOrEqual(11.33);
      expect(w2.discountSuggestion.warning).toMatch(/below your cost/);
      await call(ORG, 'PATCH', `/shops/${shops[ORG]}/products/${pid}`, { sellingPrice: 20 });
      expect((await call(OUTSIDER, 'GET', `/shops/${shops[ORG]}/waste`)).status).toBe(404);
    });

    test('sales velocity drives days-left and reorder advice (waste-adjusted)', async () => {
      const pv = await mkProduct(ORG, { name: 'Tomato ' + uid().slice(0, 5), unit: 'kg', buyingPrice: 50, sellingPrice: 80 });
      await call(ORG, 'PATCH', `/shops/${shops[ORG]}/products/${pv}/perishable`, { isPerishable: true, shelfLifeDays: 4 });
      await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pv}/batches`, { id: uid(), qty: 120, unitCost: 50 });
      // 7 real sales through the sales API (backdated like synced offline sales), 10kg each
      for (let i = 1; i <= 7; i++) {
        const r = await call(ORG, 'POST', `/shops/${shops[ORG]}/sales`, { id: uid(), items: [{ productId: pv, qty: 10 }], payments: [{ method: 'cash', amount: 800 }], soldAt: new Date(Date.now() - i * 86400000).toISOString() });
        expect(r.status).toBe(201);
      }
      await call(ORG, 'POST', `/shops/${shops[ORG]}/products/${pv}/batches`, { id: uid(), qty: 10, unitCost: 50 }); // top up so 60kg remain after the 70kg sold
      const it = (await call(ORG, 'GET', `/shops/${shops[ORG]}/waste`)).body.data.items.find((i) => i.productId === pv);
      expect(it.sales.confidence).toBe('based_on_sales');
      expect(it.sales.avgDailyQty).toBe(5);                     // 70kg over the 14-day window
      expect(it.sales.daysOfStockLeft).toBe(12);                // 60 / 5 (120 + 10 received - 70 sold)
      expect(it.qtyAtRisk).toBeGreaterThan(0);                  // 60kg cannot clear in a 4-day shelf life at 5kg/day
    });

    test('spoilage is a LOSS at cost, not a sale; idempotent; cannot exceed stock', async () => {
      const lid = uid();
      const before = (await call(ORG, 'GET', `/shops/${shops[ORG]}/products`)).body.data.products.find((p) => p.id === pid).stockQty;
      const r = await call(ORG, 'POST', `/shops/${shops[ORG]}/losses`, { id: lid, productId: pid, qty: 4, reason: 'spoiled', handling: 'disposed', condition: 'yellowing' });
      expect(r.status).toBe(201); expect(r.body.data.loss.lossValue).toBe(45.32); // 4 x 11.33
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/losses`, { id: lid, productId: pid, qty: 4 })).body.data.idempotent).toBe(true);
      const after = (await call(ORG, 'GET', `/shops/${shops[ORG]}/products`)).body.data.products.find((p) => p.id === pid).stockQty;
      expect(after).toBe(before - 4);                            // deducted once only
      const [sales] = await q(`SELECT COUNT(*)::int AS n FROM duka_sales s JOIN duka_sale_items i ON i.sale_id=s.id WHERE i.product_id=:p`, { p: pid });
      expect(sales.n).toBe(0);                                   // no sale created
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/losses`, { id: uid(), productId: pid, qty: 9999 })).body.errorCode).toBe('INSUFFICIENT_STOCK');
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/losses`, { id: uid(), productId: pid, qty: 1, reason: 'bored' })).status).toBe(400);
      expect((await call(ORG, 'POST', `/shops/${shops[ORG]}/losses`, { id: uid(), productId: pid, qty: 1, photoUrl: 'http://x' })).status).toBe(400);
      expect((await call(OUTSIDER, 'POST', `/shops/${shops[ORG]}/losses`, { id: uid(), productId: pid, qty: 1 })).status).toBe(404);
      const rep = (await call(ORG, 'GET', `/shops/${shops[ORG]}/losses`)).body.data;
      expect(rep.totalLossValue).toBe(45.32); expect(rep.frequentlyWasted[0].name).toMatch(/Sukuma/);
      const w = (await call(ORG, 'GET', `/shops/${shops[ORG]}/waste`)).body.data;
      expect(w.summary.lossesLast30Days).toBe(45.32); expect(w.summary.lossesAvoided).toBeNull();
    });
  });

  /* ───────────── group buying ───────────── */
  describe('group buying', () => {
    let supplierId, orderId, quoteId;
    const sh = (u) => shops[u];

    test('supplier must be verified (by an admin) before quoting; no invented prices', async () => {
      supplierId = uid();
      const reg = await call(SUP, 'POST', '/group-buy/suppliers', { id: supplierId, businessName: 'Wakulima Wholesale', phone: '0712345678' });
      expect(reg.status).toBe(201); expect(reg.body.data.supplier.status).toBe('pending');
      orderId = uid();
      const o = await call(ORG, 'POST', '/group-buy/orders', { id: orderId, shopId: sh(ORG), productName: 'Tomatoes', unit: 'kg', market: 'Wakulima Market', minQty: 50, closesAt: future(24), paymentDeadline: future(48), qty: 10, referencePrice: 100, feeSplit: 'proportional' });
      expect(o.status).toBe(201);
      expect((await call(ORG, 'POST', '/group-buy/orders', { id: orderId, shopId: sh(ORG), productName: 'Tomatoes', unit: 'kg', market: 'Wakulima Market', closesAt: future(24) })).body.data.idempotent).toBe(true);
      const early = await call(SUP, 'POST', `/group-buy/orders/${orderId}/quotes`, { id: uid(), unitPrice: 75, availableQty: 200 });
      expect(early.body.errorCode).toBe('SUPPLIER_NOT_VERIFIED');
      expect((await call(ORG, 'POST', `/group-buy/suppliers/${supplierId}/verify`)).status).toBe(403); // not an admin
      expect((await call(ADMIN, 'POST', `/group-buy/suppliers/${supplierId}/verify`)).status).toBe(200);
      const detail = await call(T2, 'GET', `/group-buy/orders/${orderId}`);
      expect(detail.body.data.quotes).toHaveLength(0);          // no quote => no price shown
    });

    test('traders join; combined quantity; private data not exposed; lock blocked below minimum', async () => {
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/join`, { shopId: sh(T2), qty: 15, referencePrice: 100 })).status).toBe(201);
      expect((await call(T3, 'POST', `/group-buy/orders/${orderId}/join`, { shopId: sh(T3), qty: 20 })).status).toBe(201);
      expect((await call(T3, 'POST', `/group-buy/orders/${orderId}/join`, { shopId: sh(ORG), qty: 20 })).status).toBe(404); // someone else's shop
      quoteId = uid();
      const qt = await call(SUP, 'POST', `/group-buy/orders/${orderId}/quotes`, { id: quoteId, unitPrice: 75, availableQty: 200, minOrderQty: 40, transportFee: 450, terms: 'Pickup at Wakulima gate 3' });
      expect(qt.status).toBe(201);
      const list = await call(T2, 'GET', '/group-buy/orders?market=wakulima');
      const row = list.body.data.orders.find((x) => x.id === orderId);
      expect(row.combinedQty).toBe(45); expect(row.participants).toBe(3); expect(row.needsMoreQty).toBe(5); expect(row.joinedByMe).toBe(true);
      expect(JSON.stringify(list.body)).not.toMatch(/shopName|amountDue/);   // marketplace list is aggregate-only
      const lockEarly = await call(ORG, 'POST', `/group-buy/orders/${orderId}/lock`, { quoteId });
      expect(lockEarly.body.errorCode).toBe('MINIMUM_NOT_REACHED');
      await call(ORG, 'POST', `/group-buy/orders/${orderId}/join`, { shopId: sh(ORG), qty: 15 });          // organiser raises own qty 10 -> 15
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/lock`, { quoteId })).status).toBe(403);   // only organiser
    });

    test('cost preview shows every charge and savings only vs the trader own reference price', async () => {
      const d = await call(T2, 'GET', `/group-buy/orders/${orderId}`);
      const p = d.body.data.quotes[0].yourCostPreview;           // T2: 15kg of 50kg => goods 1125, transport share 135
      expect(p.goods).toBe(1125); expect(p.transportShare).toBe(135); expect(p.platformFee).toBe(0); expect(p.totalPayable).toBe(1260);
      expect(p.savingVsYourReferencePrice).toBe(240);            // 15 x 100 = 1500 - 1260
      const d3 = await call(T3, 'GET', `/group-buy/orders/${orderId}`);
      expect(d3.body.data.quotes[0].yourCostPreview.savingVsYourReferencePrice).toBeNull(); // T3 gave no reference => no claim
      expect(d3.body.data.participants).toBeUndefined();         // non-organiser cannot see participants
      const dOrg = await call(ORG, 'GET', `/group-buy/orders/${orderId}`);
      expect(dOrg.body.data.participants).toHaveLength(3);
      expect(JSON.stringify(dOrg.body.data.participants)).not.toMatch(/amountDue|referencePrice/);
    });

    test('lock → confirm exact amount → unverified payment rejected → verified payment accepted once', async () => {
      expect((await call(ORG, 'POST', `/group-buy/orders/${orderId}/lock`, { quoteId })).status).toBe(200);
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/participants/me/confirm`, { amountDue: 1 })).body.errorCode).toBe('AMOUNT_MISMATCH');
      const mine = (await call(T2, 'GET', `/group-buy/orders/${orderId}`)).body.data.you;
      expect(mine.amountDue).toBe(1260);
      for (const u of [ORG, T2, T3]) {
        const due = (await call(u, 'GET', `/group-buy/orders/${orderId}`)).body.data.you.amountDue;
        expect((await call(u, 'POST', `/group-buy/orders/${orderId}/participants/me/confirm`, { amountDue: due })).status).toBe(200);
      }
      const pay = { id: uid(), amount: 1260, mpesaReceipt: 'GBTEST0001' };
      await sequelize.query(`DELETE FROM stk_transactions WHERE mpesa_receipt LIKE 'GBTEST%'`);
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/pay`, pay)).body.errorCode).toBe('MPESA_NOT_VERIFIED');   // STK prompt != payment
      expect((await call(T2, 'GET', `/group-buy/orders/${orderId}`)).body.data.you.status).toBe('confirmed');                  // still not paid
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/pay`, { ...pay, mpesaReceipt: 'bad' })).status).toBe(400);
      await sequelize.query(`INSERT INTO stk_transactions VALUES ('GBTEST0001','paid',1260)`);
      const ok = await call(T2, 'POST', `/group-buy/orders/${orderId}/pay`, pay);
      expect(ok.status).toBe(201); expect(ok.body.data.fullyPaid).toBe(true);
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/pay`, pay)).status).toBe(200);                           // retry, not double-counted
      await sequelize.query(`INSERT INTO stk_transactions VALUES ('GBTEST0002','paid',500)`);
      expect((await call(T3, 'POST', `/group-buy/orders/${orderId}/pay`, { id: uid(), amount: 1260, mpesaReceipt: 'GBTEST0002' })).body.errorCode).toBe('MPESA_NOT_VERIFIED'); // paid 500 < claimed 1260
      await sequelize.query(`UPDATE stk_transactions SET paid_amount=2000 WHERE mpesa_receipt='GBTEST0001'`);
      expect((await call(T3, 'POST', `/group-buy/orders/${orderId}/pay`, { id: uid(), amount: 100, mpesaReceipt: 'GBTEST0001' })).body.errorCode).toBe('RECEIPT_USED'); // reuse of T2's receipt
      expect((await call(ORG, 'POST', `/group-buy/orders/${orderId}/confirm`)).body.errorCode).toBe('PAYMENTS_INCOMPLETE');
    });

    test('order confirms only when all paid; delivery with a shortage allocates proportionally, queues refunds, then stock is received at real cost', async () => {
      // T3 owes 20kg => 1500 + 180 = 1680; ORG owes 15kg => 1125 + 135 = 1260
      await sequelize.query(`INSERT INTO stk_transactions VALUES ('GBTEST0003','paid',1680),('GBTEST0004','paid',1260)`);
      expect((await call(T3, 'POST', `/group-buy/orders/${orderId}/pay`, { id: uid(), amount: 1680, mpesaReceipt: 'GBTEST0003' })).status).toBe(201);
      expect((await call(ORG, 'POST', `/group-buy/orders/${orderId}/delivery`, { receivedQty: 50 })).body.errorCode).toBe('ORDER_NOT_CONFIRMED');
      expect((await call(ORG, 'POST', `/group-buy/orders/${orderId}/pay`, { id: uid(), amount: 1260, mpesaReceipt: 'GBTEST0004' })).status).toBe(201);
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/confirm`)).status).toBe(403);
      expect((await call(ORG, 'POST', `/group-buy/orders/${orderId}/confirm`)).status).toBe(200);
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/withdraw`)).body.errorCode).toBe('WITHDRAW_NOT_ALLOWED');
      const pT2 = await mkProduct(T2, { name: 'Tomatoes', buyingPrice: 90, sellingPrice: 120 });
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/receive`, { id: uid() })).body.errorCode).toBe('DELIVERY_NOT_RECORDED'); // not before delivery is recorded
      const del = await call(ORG, 'POST', `/group-buy/orders/${orderId}/delivery`, { receivedQty: 40, note: '10kg short, crates damaged' });
      expect(del.body.data).toMatchObject({ ordered: 50, received: 40, shortage: 10 });
      const stockBefore = (await call(T2, 'GET', `/shops/${sh(T2)}/products`)).body.data.products.find((p) => p.id === pT2).stockQty;
      expect(stockBefore).toBe(0);                               // delivery recorded but nothing added yet
      const bid = uid();
      const rc = await call(T2, 'POST', `/group-buy/orders/${orderId}/receive`, { id: bid, shelfLifeDays: 4 });
      expect(rc.status).toBe(201);
      expect(rc.body.data.qtyAdded).toBe(12);                    // 15 x 40/50
      expect(rc.body.data.unitCost).toBe(86.25);                 // (900 goods + 135 charges) / 12
      expect((await call(T2, 'POST', `/group-buy/orders/${orderId}/receive`, { id: bid })).status).toBe(200);  // retry safe
      const prod = (await call(T2, 'GET', `/shops/${sh(T2)}/products`)).body.data.products.find((p) => p.id === pT2);
      expect(prod.stockQty).toBe(12);                            // added exactly once
      const batches = (await call(T2, 'GET', `/shops/${sh(T2)}/products/${pT2}/batches`)).body.data.batches;
      expect(batches[0].source).toBe('group_buy'); expect(batches[0].shelfLifeDays).toBe(4);
      const refunds = (await call(T2, 'GET', '/group-buy/refunds')).body.data.refunds;
      expect(refunds.some((r) => r.amount === 225 && /Shortage/.test(r.reason))).toBe(true);   // 15 x 75 x 10/50
      expect((await call(T3, 'POST', `/group-buy/orders/${orderId}/receive`, { id: uid() })).body.errorCode).toBe('PRODUCT_REQUIRED'); // T3 has no matching product: must choose
      const dash = (await call(T2, 'GET', '/group-buy/dashboard')).body.data;
      expect(dash.mine.completed).toBe(1);
      expect(dash.verifiedSavings.amount).toBe(Math.round((100 - 86.25) * 12 * 100) / 100); // vs T2's own reference price, on actual cost
      expect((await call(OUTSIDER, 'GET', `/group-buy/orders/${orderId}/audit`)).status).toBe(404);
      expect((await call(ORG, 'GET', `/group-buy/orders/${orderId}/audit`)).body.data.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['order.create', 'order.lock', 'payment.verified', 'order.confirm', 'order.delivery']));
    });

    test('minimum not reached: order cancels; withdraw and supplier-cancel queue refunds', async () => {
      const o2 = uid();
      await call(ORG, 'POST', '/group-buy/orders', { id: o2, shopId: sh(ORG), productName: 'Onions', unit: 'kg', market: 'Gikomba', minQty: 30, closesAt: future(1), paymentDeadline: future(5), qty: 10 });
      await sequelize.query(`UPDATE duka_gb_orders SET closes_at = NOW() - INTERVAL '1 minute' WHERE id=:id`, { replacements: { id: o2 } });
      await call(T2, 'GET', '/group-buy/orders');                // sweep
      const c = await call(T2, 'GET', `/group-buy/orders/${o2}`);
      expect(c.body.data.order.status).toBe('cancelled');
      expect((await call(T2, 'POST', `/group-buy/orders/${o2}/join`, { shopId: sh(T2), qty: 5 })).body.errorCode).toBe('ORDER_NOT_OPEN');

      // supplier cannot fulfil after payment => cancel + refunds for everyone who paid
      const o3 = uid(), q3 = uid();
      await call(ORG, 'POST', '/group-buy/orders', { id: o3, shopId: sh(ORG), productName: 'Potatoes', unit: 'kg', market: 'Marikiti', minQty: 10, closesAt: future(2), qty: 10 });
      await call(SUP, 'POST', `/group-buy/orders/${o3}/quotes`, { id: q3, unitPrice: 40, availableQty: 100 });
      expect((await call(ORG, 'POST', `/group-buy/orders/${o3}/lock`, { quoteId: q3 })).status).toBe(200);
      await call(ORG, 'POST', `/group-buy/orders/${o3}/participants/me/confirm`, { amountDue: 400 });
      await sequelize.query(`INSERT INTO stk_transactions VALUES ('GBTEST0005','paid',400)`);
      expect((await call(ORG, 'POST', `/group-buy/orders/${o3}/pay`, { id: uid(), amount: 400, mpesaReceipt: 'GBTEST0005' })).status).toBe(201);
      const w = await call(SUP, 'POST', `/group-buy/quotes/${q3}/withdraw`);
      expect(w.body.data.orderCancelled).toBe(true);
      expect((await call(ORG, 'GET', '/group-buy/refunds')).body.data.refunds.some((r) => r.amount === 400 && r.status === 'pending')).toBe(true);
      expect((await call(ORG, 'POST', '/group-buy/refunds/' + (await call(ORG, 'GET', '/group-buy/refunds')).body.data.refunds[0].id + '/paid-out', { payoutRef: 'X' })).status).toBe(403); // admin only
    });

    test('withdrawal after lock reprices the rest; falling under the minimum cancels', async () => {
      const o4 = uid(), q4 = uid();
      await call(ORG, 'POST', '/group-buy/orders', { id: o4, shopId: sh(ORG), productName: 'Bananas', unit: 'kg', market: 'Kongowea', minQty: 20, closesAt: future(2), qty: 10 });
      await call(T2, 'POST', `/group-buy/orders/${o4}/join`, { shopId: sh(T2), qty: 10 });
      await call(SUP, 'POST', `/group-buy/orders/${o4}/quotes`, { id: q4, unitPrice: 30, availableQty: 100, transportFee: 100 });
      await call(ORG, 'POST', `/group-buy/orders/${o4}/lock`, { quoteId: q4 });
      expect((await call(T2, 'GET', `/group-buy/orders/${o4}`)).body.data.you.amountDue).toBe(350);
      const w = await call(T2, 'POST', `/group-buy/orders/${o4}/withdraw`);
      expect(w.body.data.orderCancelled).toBe(true);             // 10kg left < 20kg minimum
      expect((await call(ORG, 'GET', `/group-buy/orders/${o4}`)).body.data.order.status).toBe('cancelled');
    });

    test('waste history shrinks the recommended group allocation; trader can still override', async () => {
      const rec = await call(ORG, 'GET', `/group-buy/orders/${orderId}/recommendation?shopId=${sh(ORG)}`);
      expect(rec.body.data.recommendedQty).toBeNull();           // organiser has no Tomatoes history: says so, invents nothing
      expect(rec.body.data.canOverride).toBe(true);
      const rec2 = await call(T2, 'GET', `/group-buy/orders/${orderId}/recommendation?shopId=${sh(T2)}`);
      expect(rec2.body.data.currentStock).toBe(12);
      expect((await call(T2, 'GET', `/group-buy/orders/${orderId}/recommendation?shopId=${sh(ORG)}`)).status).toBe(404);
    });
  });

  /* ───────────── Smart Scale device (simulated) ───────────── */
  describe('smart scale device API (simulated device)', () => {
    let key, serial, devId, tom;
    test('register once-visible key; device auth; server-side price; idempotent offline sync; ownership', async () => {
      tom = await mkProduct(T3, { name: 'Scale Tomato', unit: 'kg', sellingPrice: 80 });
      serial = 'NSS-' + uid().slice(0, 8); devId = uid();
      const reg = await call(T3, 'POST', `/shops/${shops[T3]}/devices`, { id: devId, serialNo: serial, label: 'Stall scale' });
      expect(reg.status).toBe(201); key = reg.body.data.deviceKey; expect(key).toHaveLength(64);
      expect((await call(T3, 'POST', `/shops/${shops[T3]}/devices`, { id: devId, serialNo: serial })).body.data.deviceKey).toBeNull();
      expect((await call(T2, 'POST', `/shops/${shops[T2]}/devices`, { id: uid(), serialNo: serial })).status).toBe(409);
      const [stored] = await q('SELECT key_hash FROM duka_devices WHERE id=:id', { id: devId });
      expect(stored.key_hash).not.toBe(key);                     // only a hash is stored
      const H = { 'x-device-serial': serial, 'x-device-key': key };
      expect((await call(null, 'POST', '/device/heartbeat', { batteryPct: 80 }, { ...H, 'x-device-key': 'wrong' })).status).toBe(401);
      expect((await call(null, 'POST', '/device/heartbeat', { batteryPct: 180 }, H)).status).toBe(400);
      expect((await call(null, 'POST', '/device/heartbeat', { batteryPct: 77, charging: true, firmware: '0.1.0', calibration: 'ok' }, H)).status).toBe(200);
      const cat = await call(null, 'GET', '/device/catalog', null, H);
      expect(cat.body.data.products.find((p) => p.id === tom).pricePerUnit).toBe(80);
      const op = uid();
      const sync = { readings: [
        { opId: op, productId: tom, weightGrams: 2500, stable: true, measuredAt: new Date().toISOString() },
        { opId: uid(), productId: tom, weightGrams: 31000, stable: true, measuredAt: new Date().toISOString() },
        { opId: uid(), productId: uid(), weightGrams: 100, measuredAt: new Date().toISOString() }] };
      const s1 = await call(null, 'POST', '/device/sync', sync, H);
      expect(s1.body.data.results[0]).toMatchObject({ status: 'recorded', lineTotal: 200 });   // 2.5kg x KSh 80
      expect(s1.body.data.results[1].status).toBe('recorded_overload_warning');                // 31kg > 30kg capacity
      expect(s1.body.data.results[2].status).toBe('rejected');
      const s2 = await call(null, 'POST', '/device/sync', { readings: [sync.readings[0]] }, H);
      expect(s2.body.data.results[0].status).toBe('duplicate');                                // retry never duplicates
      expect((await call(T3, 'GET', `/shops/${shops[T3]}/devices/${devId}/readings`)).body.data.readings).toHaveLength(2);
      expect((await call(T2, 'GET', `/shops/${shops[T3]}/devices`)).status).toBe(404);
      const list = (await call(T3, 'GET', `/shops/${shops[T3]}/devices`)).body.data.devices[0];
      expect(list.batteryPct).toBe(77); expect(list.lastSyncAt).toBeTruthy();
      expect((await call(T3, 'POST', `/shops/${shops[T3]}/devices/${devId}/revoke`)).status).toBe(200);
      expect((await call(null, 'POST', '/device/heartbeat', {}, H)).status).toBe(403);
    });
  });
});
