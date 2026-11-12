'use strict';
/**
 * NECPRA DUKA SMART — Phase 5 (finance) integration tests (real Postgres, no mocks).
 *   DUKA_TEST_DB_URL=postgres://user:pass@localhost:5432/dukatest npx jest tests/current/duka-finance.test.js --runInBand
 * Skips cleanly when DUKA_TEST_DB_URL is not set.
 */
const URL_ = process.env.DUKA_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;

d('duka phase 5 finance', () => {
  const express = require('express');
  const { Sequelize } = require('sequelize');
  let sequelize, server, base, shopId, custId, prodId;
  const A = 5101, B = 5202;
  const uid = () => require('crypto').randomUUID();
  const call = async (user, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const nairobiToday = async () => (await sequelize.query(`SELECT to_char((NOW() AT TIME ZONE 'Africa/Nairobi')::date,'YYYY-MM-DD') AS d`, { type: 'SELECT' }))[0].d;

  beforeAll(async () => {
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance']) {
      await require(`../../migrations/${m}.js`).up({ sequelize });
      await require(`../../migrations/${m}.js`).up({ sequelize }); // idempotent re-run
    }
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({
      getSequelize: () => sequelize,
      authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); }
    }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    shopId = (await call(A, 'POST', '/shops', { name: 'Fin Shop ' + uid().slice(0, 6) })).body.data.shop.id;
    prodId = uid();
    await call(A, 'POST', `/shops/${shopId}/products`, { id: prodId, name: 'Sugar 1kg', buyingPrice: 100, sellingPrice: 150, openingStock: 100 });
    custId = uid();
    await call(A, 'POST', `/shops/${shopId}/customers`, { id: custId, name: 'Wanjiru' });
  });
  afterAll(async () => { if (server) server.close(); if (sequelize) await sequelize.close(); });

  test('requires auth and ownership', async () => {
    expect((await fetch(base + `/shops/${shopId}/expenses`)).status).toBe(401);
    expect((await call(B, 'GET', `/shops/${shopId}/expenses`)).status).toBe(404);
    expect((await call(B, 'POST', `/shops/${shopId}/expenses`, { id: uid(), amount: 5 })).status).toBe(404);
    expect((await call(B, 'GET', `/shops/${shopId}/reports`)).status).toBe(404);
    expect((await call(B, 'GET', `/shops/${shopId}/debts`)).status).toBe(404);
  });

  test('expenses: validate, idempotent, void, totals by category', async () => {
    const id = uid();
    expect((await call(A, 'POST', `/shops/${shopId}/expenses`, { id, amount: 0 })).status).toBe(400);
    expect((await call(A, 'POST', `/shops/${shopId}/expenses`, { id, amount: 10.123 })).status).toBe(400);
    expect((await call(A, 'POST', `/shops/${shopId}/expenses`, { amount: 10 })).status).toBe(400); // id required
    expect((await call(A, 'POST', `/shops/${shopId}/expenses`, { id, amount: 10, expenseDate: '2999-01-01' })).status).toBe(400);
    expect((await call(A, 'POST', `/shops/${shopId}/expenses`, { id, amount: 10, expenseDate: '2026-02-30' })).status).toBe(400);
    const c1 = await call(A, 'POST', `/shops/${shopId}/expenses`, { id, category: 'Rent', amount: 300, description: 'Nov rent' });
    expect(c1.status).toBe(201); expect(c1.body.data.expense.category).toBe('rent');
    const c2 = await call(A, 'POST', `/shops/${shopId}/expenses`, { id, category: 'Rent', amount: 300 });
    expect(c2.status).toBe(200); expect(c2.body.data.idempotent).toBe(true);
    expect((await call(B, 'POST', `/shops/${shopId}/expenses`, { id, amount: 1 })).status).toBe(404);
    const e2 = uid();
    await call(A, 'POST', `/shops/${shopId}/expenses`, { id: e2, category: 'transport', amount: 50.5, method: 'mpesa' });
    const list = await call(A, 'GET', `/shops/${shopId}/expenses`);
    expect(list.body.data.total).toBe(350.5);
    expect(list.body.data.byCategory.map((c) => c.category)).toEqual(['rent', 'transport']);
    const v = await call(A, 'POST', `/shops/${shopId}/expenses/${e2}/void`, { reason: 'entered twice' });
    expect(v.status).toBe(200); expect(v.body.data.expense.status).toBe('voided');
    expect((await call(A, 'POST', `/shops/${shopId}/expenses/${e2}/void`, {})).body.data.idempotent).toBe(true);
    expect((await call(A, 'GET', `/shops/${shopId}/expenses`)).body.data.total).toBe(300);
    expect((await call(B, 'POST', `/shops/${shopId}/expenses/${e2}/void`, {})).status).toBe(404);
  });

  test('suppliers: bills, payments, no overpayment, idempotent, ledger, isolation', async () => {
    const sid = uid();
    const s1 = await call(A, 'POST', `/shops/${shopId}/suppliers`, { id: sid, name: 'Bidco Agent', phone: '0722000111' });
    expect(s1.status).toBe(201);
    expect((await call(A, 'POST', `/shops/${shopId}/suppliers`, { id: uid(), name: 'bidco agent' })).status).toBe(409);
    const bill = uid();
    const b1 = await call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/bills`, { id: bill, amount: 5000, reference: 'INV-9', dueDate: '2999-01-01' });
    expect(b1.status).toBe(201); expect(b1.body.data.owed).toBe(5000);
    expect((await call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/bills`, { id: bill, amount: 5000 })).body.data.owed).toBe(5000); // replay
    const p = uid();
    const p1 = await call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/payments`, { id: p, amount: 2000, method: 'cash' });
    expect(p1.status).toBe(201); expect(p1.body.data.owed).toBe(3000);
    expect((await call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/payments`, { id: p, amount: 2000 })).body.data.owed).toBe(3000); // replay: not paid twice
    const over = await call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/payments`, { id: uid(), amount: 3000.01 });
    expect(over.status).toBe(409); expect(over.body.errorCode).toBe('OVERPAYMENT');
    // two concurrent payments of the full balance: only one may succeed
    const [x, y] = await Promise.all([1, 2].map(() => call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/payments`, { id: uid(), amount: 3000 })));
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const led = await call(A, 'GET', `/shops/${shopId}/suppliers/${sid}/ledger`);
    expect(led.body.data.owed).toBe(0); expect(led.body.data.entries).toHaveLength(3);
    expect((await call(B, 'GET', `/shops/${shopId}/suppliers/${sid}/ledger`)).status).toBe(404);
    expect((await call(A, 'PATCH', `/shops/${shopId}/suppliers/${sid}`, { isActive: false })).status).toBe(200);
  });

  test('supplier with a balance cannot be removed', async () => {
    const sid = uid();
    await call(A, 'POST', `/shops/${shopId}/suppliers`, { id: sid, name: 'Owed Ltd' });
    await call(A, 'POST', `/shops/${shopId}/suppliers/${sid}/bills`, { id: uid(), amount: 10 });
    const r = await call(A, 'PATCH', `/shops/${shopId}/suppliers/${sid}`, { isActive: false });
    expect(r.status).toBe(409); expect(r.body.errorCode).toBe('SUPPLIER_OWED');
  });

  test('customer debt: credit sale, FIFO collection, overpayment blocked, mpesa needs code, idempotent', async () => {
    const mk = async (qty) => {
      const sale = uid();
      const r = await call(A, 'POST', `/shops/${shopId}/sales`, { id: sale, customerId: custId, items: [{ productId: prodId, qty }], payments: [] });
      expect(r.status).toBe(201); return sale;
    };
    const s1 = await mk(2); // 300 credit
    const s2 = await mk(1); // 150 credit  -> owed 450
    expect((await call(A, 'GET', `/shops/${shopId}/debts`)).body.data.customersOweYou.total).toBe(450);
    expect((await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: uid(), amount: 450.01, method: 'cash' })).body.errorCode).toBe('OVERPAYMENT');
    const mp = await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: uid(), amount: 10, method: 'mpesa' });
    expect(mp.status).toBe(400); expect(mp.body.errorCode).toBe('MPESA_RECEIPT_REQUIRED');
    const pid = uid();
    const p1 = await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: pid, amount: 350, method: 'cash' });
    expect(p1.status).toBe(201); expect(p1.body.data.remainingBalance).toBe(100);
    expect(p1.body.data.allocations).toHaveLength(2); // 300 to the oldest, 50 to the next
    const rep = await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: pid, amount: 350, method: 'cash' });
    expect(rep.status).toBe(200); expect(rep.body.data.idempotent).toBe(true); expect(rep.body.data.remainingBalance).toBe(100);
    const r1 = (await call(A, 'GET', `/shops/${shopId}/sales/${s1}`)).body.data.sale;
    const r2 = (await call(A, 'GET', `/shops/${shopId}/sales/${s2}`)).body.data.sale;
    expect([r1.paymentStatus, r1.balanceDue, r1.amountPaid]).toEqual(['paid', 0, 300]);
    expect([r2.paymentStatus, r2.balanceDue, r2.amountPaid]).toEqual(['partial', 100, 50]);
    const code = 'QWE1RTY2UI';
    const m1 = await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: uid(), amount: 100, method: 'mpesa', mpesaReceipt: code });
    expect(m1.status).toBe(201); expect(m1.body.data.payment.verification).toBe('receipt_recorded'); // never "verified" without a paid STK record
    expect(m1.body.data.remainingBalance).toBe(0);
    expect((await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: uid(), amount: 1, method: 'cash' })).body.errorCode).toBe('NO_DEBT');
    const st = await call(A, 'GET', `/shops/${shopId}/customers/${custId}/statement`);
    expect(st.body.data.owed).toBe(0); expect(st.body.data.payments).toHaveLength(2);
    expect((await call(B, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: uid(), amount: 1, method: 'cash' })).status).toBe(404);
    // a used sale receipt code cannot be reused for a debt payment
    const sale3 = uid();
    await call(A, 'POST', `/shops/${shopId}/sales`, { id: sale3, customerId: custId, items: [{ productId: prodId, qty: 2 }], payments: [{ method: 'mpesa', amount: 100, mpesaReceipt: 'ABCD1234EF' }] });
    const dup = await call(A, 'POST', `/shops/${shopId}/customers/${custId}/payments`, { id: uid(), amount: 50, method: 'mpesa', mpesaReceipt: 'ABCD1234EF' });
    expect(dup.status).toBe(409);
  });

  test('concurrent collections never collect more than is owed', async () => {
    const cust = uid(); await call(A, 'POST', `/shops/${shopId}/customers`, { id: cust, name: 'Race' });
    await call(A, 'POST', `/shops/${shopId}/sales`, { id: uid(), customerId: cust, items: [{ productId: prodId, qty: 1 }], payments: [] }); // 150
    const rs = await Promise.all([1, 2, 3].map(() => call(A, 'POST', `/shops/${shopId}/customers/${cust}/payments`, { id: uid(), amount: 150, method: 'cash' })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect((await call(A, 'GET', `/shops/${shopId}/customers/${cust}/statement`)).body.data.owed).toBe(0);
  });

  test('reports keep revenue, cash, credit, expenses and net profit apart; dashboard agrees', async () => {
    const shop = (await call(A, 'POST', '/shops', { name: 'Report Shop ' + uid().slice(0, 6) })).body.data.shop.id;
    const prod = uid();
    await call(A, 'POST', `/shops/${shop}/products`, { id: prod, name: 'Bread', buyingPrice: 50, sellingPrice: 70, openingStock: 100 });
    const cust = uid(); await call(A, 'POST', `/shops/${shop}/customers`, { id: cust, name: 'Credit Cust' });
    // sale 1: 10 x 70 = 700, paid cash 700. sale 2: 5 x 70 = 350, 100 cash + 250 credit
    expect((await call(A, 'POST', `/shops/${shop}/sales`, { id: uid(), items: [{ productId: prod, qty: 10 }], payments: [{ method: 'cash', amount: 700 }] })).status).toBe(201);
    expect((await call(A, 'POST', `/shops/${shop}/sales`, { id: uid(), customerId: cust, items: [{ productId: prod, qty: 5 }], payments: [{ method: 'cash', amount: 100 }] })).status).toBe(201);
    await call(A, 'POST', `/shops/${shop}/expenses`, { id: uid(), category: 'rent', amount: 200 });
    await call(A, 'POST', `/shops/${shop}/customers/${cust}/payments`, { id: uid(), amount: 50, method: 'cash' });
    const sup = uid(); await call(A, 'POST', `/shops/${shop}/suppliers`, { id: sup, name: 'Sup' });
    await call(A, 'POST', `/shops/${shop}/suppliers/${sup}/bills`, { id: uid(), amount: 900 });
    await call(A, 'POST', `/shops/${shop}/suppliers/${sup}/payments`, { id: uid(), amount: 400 });
    const rep = await call(A, 'GET', `/shops/${shop}/reports?period=daily`);
    expect(rep.status).toBe(200);
    const t = rep.body.data.totals, today = await nairobiToday();
    expect(rep.body.data.rows.length).toBe(14);
    expect(rep.body.data.rows[13].periodStart).toBe(today);
    expect(t.revenue).toBe(1050);                 // earned, including unpaid credit
    expect(t.costOfGoodsSold).toBe(750);          // 15 x 50
    expect(t.grossProfit).toBe(300);
    expect(t.expenses).toBe(200);
    expect(t.netProfit).toBe(100);                // gross − expenses; supplier payments are NOT an expense
    expect(t.cashFromSales).toBe(800);
    expect(t.debtCollected).toBe(50);
    expect(t.totalCashReceived).toBe(850);        // real money only
    expect(t.creditGiven).toBe(250);              // fixed at sale time, unaffected by later collections
    expect(t.supplierPayments).toBe(400);
    expect(rep.body.data.position.customersOweYou).toBe(200);
    expect(rep.body.data.position.youOweSuppliers).toBe(500);
    for (const p of ['weekly', 'monthly']) {
      const r = await call(A, 'GET', `/shops/${shop}/reports?period=${p}`);
      expect(r.status).toBe(200); expect(r.body.data.totals.netProfit).toBe(100);
    }
    expect((await call(A, 'GET', `/shops/${shop}/reports?period=yearly`)).status).toBe(400);
    expect((await call(A, 'GET', `/shops/${shop}/reports?from=2020-01-01&to=2026-11-01`)).status).toBe(400); // range too long
    expect((await call(A, 'GET', `/shops/${shop}/reports?from=2026-11-05&to=2026-11-01`)).status).toBe(400);
    const dash = (await call(A, 'GET', `/shops/${shop}/dashboard`)).body.data;
    expect(dash.totalExpenses).toBe(200); expect(dash.netProfit).toBe(100); expect(dash.estimatedProfit).toBe(300);
    expect(dash.supplierDebts).toBe(500); expect(dash.debtCollectedToday).toBe(50);
    expect(dash.customerDebts.total).toBe(200);
  });
});
