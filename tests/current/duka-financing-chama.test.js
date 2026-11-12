'use strict';
/**
 * NECPRA DUKA SMART — device financing + Chama-linked group buying (real Postgres, no mocks).
 *   DUKA_TEST_DB_URL=postgres://user:pass@localhost:5432/dukatest npx jest tests/current/duka-financing-chama.test.js --runInBand
 */
const URL_ = process.env.DUKA_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;

d('duka financing + chama', () => {
  const express = require('express');
  const { Sequelize } = require('sequelize');
  let sequelize, server, base;
  const U0 = 900000 + Math.floor(Math.random() * 90000) * 10;
  const ORG = U0 + 1, T2 = U0 + 2, T3 = U0 + 3, SUP = U0 + 4, ADMIN = U0 + 5, OUT = U0 + 6, FIN = U0 + 7;
  const uid = () => require('crypto').randomUUID();
  const call = async (user, method, path, body, headers) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const q = (sql, rep) => sequelize.query(sql, { replacements: rep, type: 'SELECT' });
  const sh = {};
  const mkShop = async (u, n) => { const r = await call(u, 'POST', '/shops', { name: n + uid().slice(0, 5) }); sh[u] = r.body.data.shop.id; };
  const future = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const stk = (receipt, amt) => sequelize.query(`INSERT INTO stk_transactions (mpesa_receipt,status,paid_amount) VALUES (:r,'paid',:a)`, { replacements: { r: receipt, a: amt } });
  const rcpt = () => ('R' + Math.random().toString(36).slice(2, 11)).toUpperCase().padEnd(10, 'X').slice(0, 10);

  beforeAll(async () => {
    process.env.DUKA_ADMIN_IDS = String(ADMIN);
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance', '20261111000004-duka-sale-void-and-product-description', '20261111000005-duka-batches-waste-devices', '20261111000006-duka-group-buying', '20261112000001-duka-financing-and-chama']) {
      await require(`../../migrations/${m}.js`).up({ sequelize });
      await require(`../../migrations/${m}.js`).up({ sequelize }); // idempotent
    }
    await sequelize.query(`CREATE TABLE IF NOT EXISTS stk_transactions (mpesa_receipt VARCHAR(40), status VARCHAR(20), paid_amount NUMERIC(15,2))`);
    await sequelize.query(`CREATE TABLE IF NOT EXISTS money_circles (id UUID PRIMARY KEY, owner_id INTEGER, name VARCHAR(120), type VARCHAR(20) DEFAULT 'chama', status VARCHAR(12) DEFAULT 'active', collected_amount NUMERIC(15,2) DEFAULT 0)`);
    await sequelize.query(`CREATE TABLE IF NOT EXISTS money_circle_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), circle_id UUID, user_id INTEGER, role VARCHAR(10) DEFAULT 'member', status VARCHAR(10) DEFAULT 'active')`);
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize,
      authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    for (const [u, n] of [[ORG, 'Org'], [T2, 'T2'], [T3, 'T3'], [OUT, 'Out'], [FIN, 'Fin']]) await mkShop(u, n);
  });
  afterAll(async () => { if (server) server.close(); if (sequelize) await sequelize.close(); });

  describe('device financing', () => {
    const plan = uid(); let device;
    test('eligibility is indicative and honest for a brand-new shop', async () => {
      const r = await call(FIN, 'GET', `/shops/${sh[FIN]}/financing/eligibility?weeklyAmount=1000`);
      expect(r.status).toBe(200); expect(r.body.data.indicative).toBe(true); expect(r.body.data.meetsGuidelines).toBe(false);
      expect((await call(OUT, 'GET', `/shops/${sh[FIN]}/financing/eligibility`)).status).toBe(404); // another trader's shop
    });
    test('application needs consent, is idempotent, and only one can be open', async () => {
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/applications`, { id: plan })).status).toBe(400);
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/applications`, { id: plan, consentShareData: true })).status).toBe(201);
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/applications`, { id: plan, consentShareData: true })).status).toBe(200);
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/applications`, { id: uid(), consentShareData: true })).status).toBe(409);
    });
    test('no payment before approval; admin sets terms; non-admin refused', async () => {
      const r = rcpt(); await stk(r, 2000);
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: uid(), amount: 2000, mpesaReceipt: r })).status).toBe(409);
      expect((await call(FIN, 'POST', `/financing/admin/${plan}/approve`, { devicePrice: 10000, deposit: 2000, weeklyAmount: 1000 })).status).toBe(403);
      const a = await call(ADMIN, 'POST', `/financing/admin/${plan}/approve`, { devicePrice: 10000, deposit: 2000, weeklyAmount: 1000, warrantyMonths: 12 });
      expect(a.status).toBe(200); expect(a.body.data.plan.terms.weeks).toBe(8); expect(a.body.data.plan.status).toBe('approved');
      expect((await call(ADMIN, 'POST', `/financing/admin/${plan}/approve`, { devicePrice: 10000, deposit: 2000, weeklyAmount: 1000 })).status).toBe(409);
    });
    test('an unverified receipt is never counted; a verified one activates the plan once', async () => {
      const bogus = await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: uid(), amount: 2000, mpesaReceipt: 'ZZZZZZZZZZ' });
      expect(bogus.status).toBe(409); expect(bogus.body.errorCode).toBe('MPESA_NOT_VERIFIED');
      const r = rcpt(); await stk(r, 2000); const pid = uid();
      const p1 = await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: pid, amount: 2000, mpesaReceipt: r });
      expect(p1.status).toBe(201); expect(p1.body.data.plan.status).toBe('active'); expect(p1.body.data.plan.ownership).toBe('financed');
      expect(p1.body.data.plan.progress.balance).toBe(8000);
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: pid, amount: 2000, mpesaReceipt: r })).body.data.replay).toBe(true); // retry
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: uid(), amount: 2000, mpesaReceipt: r })).body.errorCode).toBe('RECEIPT_USED');
      const rows = await q('SELECT COUNT(*)::int AS n FROM duka_fin_payments WHERE plan_id=:p', { p: plan }); expect(rows[0].n).toBe(1);
      const r2 = rcpt(); await stk(r2, 99999);
      expect((await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: uid(), amount: 9000, mpesaReceipt: r2 })).body.errorCode).toBe('OVERPAYMENT');
    });
    test('another trader cannot see or pay this plan; dashboard + summary show the obligation, not revenue', async () => {
      expect((await call(OUT, 'GET', `/shops/${sh[FIN]}/financing`)).status).toBe(404);
      const r = rcpt(); await stk(r, 500);
      expect((await call(OUT, 'POST', `/shops/${sh[OUT]}/financing/${plan}/payments`, { id: uid(), amount: 500, mpesaReceipt: r })).status).toBe(404);
      expect((await call(FIN, 'GET', `/shops/${sh[FIN]}/financing/summary`)).body.data.outstandingDeviceFinancing).toBe(8000);
      const dash = await call(FIN, 'GET', `/shops/${sh[FIN]}/dashboard`);
      expect(dash.body.data.outstandingDeviceFinancing).toBe(8000); expect(dash.body.data.totalSales || 0).toBe(0);
    });
    test('arrears produce reminders only — the registered scale keeps working', async () => {
      const dv = await call(FIN, 'POST', `/shops/${sh[FIN]}/devices`, { id: uid(), serialNo: 'SCALE-' + uid().slice(0, 8) });
      device = dv.body.data; expect(dv.status).toBe(201);
      expect((await call(ADMIN, 'POST', `/financing/admin/${plan}/link-device`, { deviceId: device.device.id })).status).toBe(200);
      await sequelize.query(`UPDATE duka_fin_plans SET start_date = (NOW() - INTERVAL '22 days')::date WHERE id=:p`, { replacements: { p: plan } });
      const rem = await call(FIN, 'GET', `/shops/${sh[FIN]}/financing/reminders`);
      const over = rem.body.data.reminders.find((x) => x.kind === 'overdue'); expect(over.amount).toBe(3000);
      const hb = await call(null, 'POST', '/device/heartbeat', { batteryPct: 80 }, { 'x-device-serial': device.device.serialNo, 'x-device-key': device.deviceKey });
      expect(hb.status).toBe(200);
      const st = await call(FIN, 'GET', `/shops/${sh[FIN]}/financing/${plan}/statement`);
      expect(st.body.data.schedule.filter((s) => s.status === 'overdue').length).toBe(3);
      expect(st.body.data.schedule.reduce((a, s) => a + s.amount, 0)).toBe(8000); // schedule adds up exactly
    });
    test('full repayment makes the trader the owner; warranty request works', async () => {
      const r = rcpt(); await stk(r, 8000);
      const p = await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/payments`, { id: uid(), amount: 8000, mpesaReceipt: r });
      expect(p.body.data.plan.status).toBe('completed'); expect(p.body.data.plan.ownership).toBe('owned'); expect(p.body.data.plan.progress.balance).toBe(0);
      const rp = await call(FIN, 'POST', `/shops/${sh[FIN]}/financing/${plan}/repairs`, { id: uid(), kind: 'warranty', details: 'Display flickers' });
      expect(rp.status).toBe(201);
      expect((await call(ADMIN, 'POST', `/financing/admin/repairs/${rp.body.data.repair.id}/status`, { status: 'resolved', resolution: 'Replaced screen' })).status).toBe(200);
      expect((await call(FIN, 'GET', `/shops/${sh[FIN]}/financing/summary`)).body.data.outstandingDeviceFinancing).toBe(0);
    });
  });

  describe('chama-linked group buying', () => {
    const circle = uid(), order = uid(), supplier = uid(), quote = uid();
    let f2, f3;
    beforeAll(async () => {
      await sequelize.query(`INSERT INTO money_circles (id,owner_id,name,collected_amount) VALUES (:c,:o,'Wakulima Chama',3000)`, { replacements: { c: circle, o: ORG } });
      for (const [u, role] of [[ORG, 'owner'], [T2, 'member'], [T3, 'member']]) await sequelize.query(`INSERT INTO money_circle_members (circle_id,user_id,role) VALUES (:c,:u,:r)`, { replacements: { c: circle, u, r: role } });
      await call(SUP, 'POST', '/group-buy/suppliers', { id: supplier, businessName: 'Chama Wholesale', phone: '0712345678' });
      await call(ADMIN, 'POST', `/group-buy/suppliers/${supplier}/verify`);
      await call(ORG, 'POST', '/group-buy/orders', { id: order, shopId: sh[ORG], productName: 'Onions', unit: 'kg', market: 'Wakulima', minQty: 40, closesAt: future(24), paymentDeadline: future(48), qty: 10 });
      await call(T2, 'POST', `/group-buy/orders/${order}/join`, { shopId: sh[T2], qty: 15 });
      await call(T3, 'POST', `/group-buy/orders/${order}/join`, { shopId: sh[T3], qty: 20 });
      await call(SUP, 'POST', `/group-buy/orders/${order}/quotes`, { id: quote, unitPrice: 75, availableQty: 200, minOrderQty: 40 });
      const lk = await call(ORG, 'POST', `/group-buy/orders/${order}/lock`, { quoteId: quote }); expect(lk.status).toBe(200);
    });
    test('only the organiser (an active member) can share an order; non-members learn nothing', async () => {
      expect((await call(T2, 'POST', `/group-buy/orders/${order}/chama/link`, { circleId: circle })).status).toBe(403);
      expect((await call(OUT, 'GET', `/group-buy/chama/circles/${circle}/orders`)).status).toBe(404);
      expect((await call(T2, 'POST', `/group-buy/orders/${order}/chama/funding`, { id: uid(), circleId: circle, amount: 500 })).body.errorCode).toBe('NOT_LINKED');
      expect((await call(ORG, 'POST', `/group-buy/orders/${order}/chama/link`, { circleId: circle })).status).toBe(201);
      const l = await call(T3, 'GET', `/group-buy/chama/circles/${circle}/orders`);
      expect(l.body.data.orders[0].circleParticipants.length).toBe(3);
      expect(JSON.stringify(l.body.data)).not.toMatch(/amount_due|referencePrice/);
    });
    test('funding cannot exceed the amount due or the circle\'s available funds; own request cannot be voted on', async () => {
      expect((await call(T2, 'POST', `/group-buy/orders/${order}/chama/funding`, { id: uid(), circleId: circle, amount: 99999 })).body.errorCode).toBe('EXCEEDS_AMOUNT_DUE');
      const id = uid(); const r = await call(T2, 'POST', `/group-buy/orders/${order}/chama/funding`, { id, circleId: circle, amount: 500 });
      expect(r.status).toBe(201); f2 = id; expect(r.body.data.funding.voting.approvalsNeeded).toBe(2);
      expect((await call(T2, 'POST', `/group-buy/orders/${order}/chama/funding`, { id, circleId: circle, amount: 500 })).status).toBe(200); // retry
      expect((await call(T2, 'POST', `/group-buy/chama/funding/${f2}/vote`, { vote: 'approve' })).status).toBe(403);
      expect((await call(OUT, 'POST', `/group-buy/chama/funding/${f2}/vote`, { vote: 'approve' })).status).toBe(404);
    });
    test('approval needs the owner AND a majority; settlement is owner-only, unverified, and is not an order payment', async () => {
      expect((await call(T3, 'POST', `/group-buy/chama/funding/${f2}/vote`, { vote: 'approve' })).body.data.funding.status).toBe('requested'); // member alone is not enough
      expect((await call(ORG, 'POST', `/group-buy/chama/funding/${f2}/vote`, { vote: 'approve' })).body.data.funding.status).toBe('approved');
      expect((await call(T3, 'POST', `/group-buy/chama/funding/${f2}/settle`, { payoutRef: 'ABC123' })).status).toBe(403);
      const s = await call(ORG, 'POST', `/group-buy/chama/funding/${f2}/settle`, { payoutRef: 'PAYOUT-1', note: 'Sent via wallet' });
      expect(s.status).toBe(200); expect(s.body.data.funding.settlement.verified).toBe(false);
      const n = await q('SELECT COUNT(*)::int AS n FROM duka_gb_payments WHERE order_id=:o', { o: order }); expect(n[0].n).toBe(0);
      const bal = await q('SELECT collected_amount FROM money_circles WHERE id=:c', { c: circle }); expect(Number(bal[0].collected_amount)).toBe(3000); // module never edits the Chama balance
    });
    test('owner rejection ends a request; the audit trail records every step; reserved funds are respected', async () => {
      f3 = uid();
      await sequelize.query(`UPDATE money_circles SET collected_amount=700 WHERE id=:c`, { replacements: { c: circle } });
      expect((await call(T3, 'POST', `/group-buy/orders/${order}/chama/funding`, { id: f3, circleId: circle, amount: 400 })).body.errorCode).toBe('CIRCLE_INSUFFICIENT'); // 700 − 500 already paid out = 200
      expect((await call(T3, 'POST', `/group-buy/orders/${order}/chama/funding`, { id: f3, circleId: circle, amount: 150 })).status).toBe(201);
      expect((await call(ORG, 'POST', `/group-buy/chama/funding/${f3}/vote`, { vote: 'reject' })).body.data.funding.status).toBe('rejected');
      expect((await call(T3, 'POST', `/group-buy/chama/funding/${f3}/cancel`)).status).toBe(409);
      const a = await q(`SELECT action FROM duka_gb_audit WHERE order_id=:o AND action LIKE 'chama.%' ORDER BY id`, { o: order });
      expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['chama.link', 'chama.funding.request', 'chama.funding.vote', 'chama.funding.settle']));
    });
  });
});
