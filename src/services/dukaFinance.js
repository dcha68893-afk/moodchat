'use strict';
/**
 * NECPRA DUKA SMART — Phase 5: shop financial records (mounted by routes/duka.js under /api/duka; lives in services/ so routes/index.js does not auto-mount it).
 *
 *   Expenses   GET/POST /shops/:shopId/expenses · POST .../expenses/:id/void
 *   Suppliers  GET/POST /shops/:shopId/suppliers · PATCH .../suppliers/:id
 *              POST .../suppliers/:id/bills · POST .../suppliers/:id/payments · GET .../suppliers/:id/ledger
 *   Debts      GET /shops/:shopId/debts (who owes us / who we owe)
 *              POST /shops/:shopId/customers/:customerId/payments · GET .../customers/:customerId/statement
 *   Reports    GET /shops/:shopId/reports?period=daily|weekly|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Money words are kept strictly apart (never mixed in one number):
 *   revenue            = value of completed sales (total after discount)        — earned, may not be paid yet
 *   cost of goods sold = buying price of what was sold (snapshotted on the sale)
 *   gross profit       = revenue − cost of goods sold
 *   expenses           = running costs (rent, transport...); voided ones are ignored
 *   NET PROFIT         = gross profit − expenses                                 — the "actual profit"
 *   cash received      = real payments taken at the till + customer debt collections (NOT credit, NOT profit)
 *   credit given       = sale value not paid at the till (customer debt)
 *   supplier payments  = money paid to suppliers. NOT an expense: stock cost reaches profit through COGS when sold.
 * Every create takes a client UUID as idempotency key (offline-outbox / retry safe). Nothing is hard-deleted.
 */
const MPESA_CODE_RE = /^[A-Z0-9]{10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ['cash', 'mpesa', 'other'];
const PERIODS = { daily: 'day', day: 'day', weekly: 'week', week: 'week', monthly: 'month', month: 'month' };
const MAX_RANGE_DAYS = 400;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function mount(ctx) {
  const { router, run, tx, wrap, audit, ownedShop, HttpError, v } = ctx;
  const { has, str, money, uuid, phoneKE, ensureObject } = v;
  const bad = (m, code) => new HttpError(400, m, code || 'VALIDATION_ERROR');

  function ymd(val, field) {
    if (!has(val)) return null;
    if (typeof val !== 'string' || !DATE_RE.test(val) || new Date(val + 'T00:00:00Z').toISOString().slice(0, 10) !== val) {
      throw bad(`${field} must be a date like 2026-11-30`);
    }
    return val;
  }
  const nairobiToday = async (t) =>
    (await run(`SELECT to_char((NOW() AT TIME ZONE 'Africa/Nairobi')::date,'YYYY-MM-DD') AS d`, {}, t))[0].d;
  async function checkDate(d, t, field) {
    const [r] = await run(
      `SELECT (:d::date > (NOW() AT TIME ZONE 'Africa/Nairobi')::date) AS fut,
              (:d::date < (NOW() AT TIME ZONE 'Africa/Nairobi')::date - ${MAX_RANGE_DAYS}) AS old`, { d }, t);
    if (r.fut) throw bad(`${field} cannot be in the future`);
    if (r.old) throw bad(`${field} is too old to record`);
  }
  const positive = (val, field) => {
    const a = money(val, field, { required: true });
    if (!(a > 0)) throw bad(`${field} must be greater than zero`);
    return a;
  };
  const cents = (x) => Math.round(Number(x) * 100);
  const method = (val, allowed = METHODS) => {
    const m = has(val) ? val : 'cash';
    if (!allowed.includes(m)) throw bad(`Payment method must be one of: ${allowed.join(', ')}`);
    return m;
  };

  /* ───────────── Expenses ───────────── */
  const expenseOut = (r) => ({
    id: r.id, category: r.category, description: r.description, amount: Number(r.amount), method: r.method,
    expenseDate: r.d || r.expense_date, status: r.status, voidReason: r.void_reason, voidedAt: r.voided_at, createdAt: r.created_at
  });

  router.post('/shops/:shopId/expenses', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'Expense id', { required: true });
    const amount = positive(b.amount, 'Amount');
    const category = (str(b.category, 'Category', { max: 40 }) || 'other').toLowerCase();
    const description = str(b.description, 'Description', { max: 200 });
    const m = method(b.method);
    const date = ymd(b.expenseDate, 'Expense date');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const ex = (await run(`SELECT *, to_char(expense_date,'YYYY-MM-DD') AS d FROM duka_expenses WHERE id = :id`, { id }, t))[0];
      if (ex) {
        if (ex.shop_id !== shop.id) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
        return { row: ex, created: false };
      }
      const d = date || (await nairobiToday(t));
      await checkDate(d, t, 'Expense date');
      const [row] = await run(
        `INSERT INTO duka_expenses (id,shop_id,category,description,amount,method,expense_date,created_by)
         VALUES (:id,:shopId,:category,:description,:amount,:m,:d,:userId)
         RETURNING *, to_char(expense_date,'YYYY-MM-DD') AS d`,
        { id, shopId: shop.id, category, description, amount, m, d, userId: req.user.id }, t);
      await audit(t, req, shop.id, 'expense.create', 'expense', id, null, expenseOut(row));
      return { row, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { expense: expenseOut(out.row), idempotent: !out.created } });
  }));

  router.get('/shops/:shopId/expenses', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const repl = { shopId: shop.id, limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500) };
    let w = 'shop_id = :shopId';
    const from = ymd(req.query.from, 'from'), to = ymd(req.query.to, 'to');
    if (from) { repl.from = from; w += ' AND expense_date >= :from'; }
    if (to) { repl.to = to; w += ' AND expense_date <= :to'; }
    if (has(req.query.category)) { repl.category = String(req.query.category).toLowerCase().slice(0, 40); w += ' AND category = :category'; }
    const rows = await run(
      `SELECT *, to_char(expense_date,'YYYY-MM-DD') AS d FROM duka_expenses WHERE ${w}
        ORDER BY expense_date DESC, created_at DESC LIMIT :limit`, repl);
    const byCat = await run(
      `SELECT category, COALESCE(SUM(amount),0) AS amt, COUNT(*)::int AS n FROM duka_expenses
        WHERE ${w} AND status = 'active' GROUP BY category ORDER BY amt DESC`, repl);
    res.json({
      success: true,
      data: {
        expenses: rows.map(expenseOut),
        total: r2(byCat.reduce((s, r) => s + Number(r.amt), 0)),
        byCategory: byCat.map((r) => ({ category: r.category, total: r2(r.amt), count: r.n }))
      }
    });
  }));

  router.post('/shops/:shopId/expenses/:expenseId/void', wrap(async (req, res) => {
    const b = ensureObject(req.body || {});
    const eid = uuid(req.params.expenseId, 'Expense id', { required: true });
    const reason = str(b.reason, 'Reason', { max: 200 });
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const ex = (await run(`SELECT * FROM duka_expenses WHERE id = :eid AND shop_id = :shopId FOR UPDATE`, { eid, shopId: shop.id }, t))[0];
      if (!ex) throw new HttpError(404, 'Expense not found', 'EXPENSE_NOT_FOUND');
      if (ex.status === 'voided') return { row: ex, changed: false };
      const [row] = await run(
        `UPDATE duka_expenses SET status='voided', void_reason=:reason, voided_at=NOW() WHERE id=:eid
         RETURNING *, to_char(expense_date,'YYYY-MM-DD') AS d`, { eid, reason }, t);
      await audit(t, req, shop.id, 'expense.void', 'expense', eid, expenseOut(ex), expenseOut(row));
      return { row, changed: true };
    });
    res.json({ success: true, data: { expense: expenseOut(out.row), idempotent: !out.changed } });
  }));

  /* ───────────── Suppliers & what we owe them ───────────── */
  const OWED = `COALESCE(SUM(CASE WHEN e.type='bill' THEN e.amount ELSE -e.amount END),0)`;
  const supplierOut = (r) => ({
    id: r.id, name: r.name, phone: r.phone, notes: r.notes, isActive: r.is_active, createdAt: r.created_at,
    owed: r.owed === undefined ? undefined : r2(r.owed)
  });
  const entryOut = (r) => ({
    id: r.id, supplierId: r.supplier_id, type: r.type, amount: Number(r.amount), method: r.method, reference: r.reference,
    note: r.note, entryDate: r.d || r.entry_date, dueDate: r.due || null, createdAt: r.created_at
  });
  async function supplierOwed(supplierId, t) {
    const [r] = await run(`SELECT ${OWED} AS owed FROM duka_supplier_entries e WHERE e.supplier_id = :supplierId`, { supplierId }, t);
    return r2(r.owed);
  }
  async function ownedSupplier(req, shopId, t, lock) {
    const sid = uuid(req.params.supplierId, 'Supplier id', { required: true });
    const [s] = await run(`SELECT * FROM duka_suppliers WHERE id = :sid AND shop_id = :shopId ${lock ? 'FOR UPDATE' : ''}`, { sid, shopId }, t);
    if (!s) throw new HttpError(404, 'Supplier not found', 'SUPPLIER_NOT_FOUND');
    return s;
  }

  router.get('/shops/:shopId/suppliers', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const rows = await run(
      `SELECT s.*, ${OWED} AS owed FROM duka_suppliers s LEFT JOIN duka_supplier_entries e ON e.supplier_id = s.id
        WHERE s.shop_id = :shopId AND s.is_active GROUP BY s.id ORDER BY lower(s.name)`, { shopId: shop.id });
    res.json({ success: true, data: { suppliers: rows.map(supplierOut), totalOwed: r2(rows.reduce((s, r) => s + Number(r.owed), 0)) } });
  }));

  router.post('/shops/:shopId/suppliers', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'Supplier id', { required: true });
    const name = str(b.name, 'Supplier name', { max: 120, required: true });
    const phone = phoneKE(b.phone, 'Phone');
    const notes = str(b.notes, 'Notes', { max: 240 });
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const ex = (await run('SELECT * FROM duka_suppliers WHERE id = :id', { id }, t))[0];
      if (ex) {
        if (ex.shop_id !== shop.id) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
        return { row: ex, created: false };
      }
      const [row] = await run(
        `INSERT INTO duka_suppliers (id,shop_id,name,phone,notes) VALUES (:id,:shopId,:name,:phone,:notes) RETURNING *`,
        { id, shopId: shop.id, name, phone, notes }, t);
      await audit(t, req, shop.id, 'supplier.create', 'supplier', id, null, supplierOut(row));
      return { row, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { supplier: supplierOut({ ...out.row, owed: 0 }), idempotent: !out.created } });
  }));

  router.patch('/shops/:shopId/suppliers/:supplierId', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const s = await ownedSupplier(req, shop.id, t, true);
      const name = has(b.name) ? str(b.name, 'Supplier name', { max: 120, required: true }) : s.name;
      const phone = 'phone' in b ? phoneKE(b.phone, 'Phone') : s.phone;
      const notes = 'notes' in b ? str(b.notes, 'Notes', { max: 240 }) : s.notes;
      let active = s.is_active;
      if ('isActive' in b) {
        if (typeof b.isActive !== 'boolean') throw bad('isActive must be true or false');
        active = b.isActive;
        if (!active && (await supplierOwed(s.id, t)) > 0) {
          throw new HttpError(409, 'You still owe this supplier. Record the payment before removing them.', 'SUPPLIER_OWED');
        }
      }
      const [row] = await run(
        `UPDATE duka_suppliers SET name=:name, phone=:phone, notes=:notes, is_active=:active, updated_at=NOW() WHERE id=:id RETURNING *`,
        { id: s.id, name, phone, notes, active }, t);
      await audit(t, req, shop.id, 'supplier.update', 'supplier', s.id, supplierOut(s), supplierOut(row));
      return { row, owed: await supplierOwed(s.id, t) };
    });
    res.json({ success: true, data: { supplier: supplierOut({ ...out.row, owed: out.owed }) } });
  }));

  async function addEntry(req, res, type) {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'Entry id', { required: true });
    const amount = positive(b.amount, 'Amount');
    const reference = str(b.reference, type === 'bill' ? 'Invoice number' : 'Reference', { max: 40 });
    const note = str(b.note, 'Note', { max: 240 });
    const m = type === 'payment' ? method(b.method) : null;
    const date = ymd(b.entryDate, 'Date');
    const due = type === 'bill' ? ymd(b.dueDate, 'Due date') : null;
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const s = await ownedSupplier(req, shop.id, t, true);
      if (!s.is_active) throw new HttpError(409, 'This supplier was removed', 'SUPPLIER_INACTIVE');
      const ex = (await run(`SELECT *, to_char(entry_date,'YYYY-MM-DD') AS d FROM duka_supplier_entries WHERE id = :id`, { id }, t))[0];
      if (ex) {
        if (ex.shop_id !== shop.id || ex.supplier_id !== s.id || ex.type !== type) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
        return { row: ex, created: false, balance: await supplierOwed(s.id, t) };
      }
      const d = date || (await nairobiToday(t));
      await checkDate(d, t, 'Date');
      if (due && due < d) throw bad('Due date cannot be before the bill date');
      const owed = await supplierOwed(s.id, t);
      if (type === 'payment' && cents(amount) > cents(owed)) {
        throw new HttpError(409, `You owe this supplier only KES ${owed.toFixed(2)}. You cannot pay more than that.`, 'OVERPAYMENT');
      }
      const [row] = await run(
        `INSERT INTO duka_supplier_entries (id,shop_id,supplier_id,type,amount,method,reference,note,entry_date,due_date,created_by)
         VALUES (:id,:shopId,:sid,:type,:amount,:m,:reference,:note,:d,:due,:userId)
         RETURNING *, to_char(entry_date,'YYYY-MM-DD') AS d, to_char(due_date,'YYYY-MM-DD') AS due`,
        { id, shopId: shop.id, sid: s.id, type, amount, m, reference, note, d, due, userId: req.user.id }, t);
      await audit(t, req, shop.id, 'supplier.' + type, 'supplier', s.id, null, entryOut(row));
      return { row, created: true, balance: await supplierOwed(s.id, t) };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { entry: entryOut(out.row), owed: out.balance, idempotent: !out.created } });
  }
  router.post('/shops/:shopId/suppliers/:supplierId/bills', wrap((req, res) => addEntry(req, res, 'bill')));
  router.post('/shops/:shopId/suppliers/:supplierId/payments', wrap((req, res) => addEntry(req, res, 'payment')));

  router.get('/shops/:shopId/suppliers/:supplierId/ledger', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const s = await ownedSupplier(req, shop.id);
    const rows = await run(
      `SELECT *, to_char(entry_date,'YYYY-MM-DD') AS d, to_char(due_date,'YYYY-MM-DD') AS due
         FROM duka_supplier_entries WHERE supplier_id = :sid ORDER BY entry_date, created_at, id`, { sid: s.id });
    let bal = 0;
    const entries = rows.map((r) => {
      bal = (cents(bal) + (r.type === 'bill' ? 1 : -1) * cents(r.amount)) / 100;
      return { ...entryOut(r), balanceAfter: r2(bal) };
    });
    res.json({ success: true, data: { supplier: supplierOut({ ...s, owed: bal }), entries: entries.reverse(), owed: r2(bal) } });
  }));

  /* ───────────── Customer credit: collecting what customers owe ───────────── */
  router.post('/shops/:shopId/customers/:customerId/payments', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'Payment id', { required: true });
    const amount = positive(b.amount, 'Amount');
    const m = method(b.method, ['cash', 'mpesa']);
    const note = str(b.note, 'Note', { max: 240 });
    let code = null;
    if (m === 'mpesa') {
      const raw = str(b.mpesaReceipt, 'M-PESA receipt code', { max: 20 });
      code = raw ? raw.toUpperCase().replace(/\s/g, '') : '';
      // Never record an M-PESA payment as received without the receipt code that proves it.
      if (!MPESA_CODE_RE.test(code)) throw bad('An M-PESA payment needs the 10-character M-PESA receipt code (e.g. SGH7K2L9QX)', 'MPESA_RECEIPT_REQUIRED');
    }
    const cid = uuid(req.params.customerId, 'Customer id', { required: true });
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const [cust] = await run('SELECT * FROM duka_customers WHERE id = :cid AND shop_id = :shopId', { cid, shopId: shop.id }, t);
      if (!cust) throw new HttpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
      const ex = (await run('SELECT * FROM duka_debt_payments WHERE id = :id', { id }, t))[0];
      if (ex) {
        if (ex.shop_id !== shop.id || ex.customer_id !== cid) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
        const al = await run('SELECT sale_id, amount FROM duka_debt_allocations WHERE payment_id = :id', { id }, t);
        return { pay: ex, alloc: al, created: false };
      }
      let verification = 'none';
      if (code) {
        const dup = await run('SELECT 1 FROM duka_sale_payments WHERE shop_id = :shopId AND mpesa_receipt = :code LIMIT 1', { shopId: shop.id, code }, t);
        if (dup.length) throw new HttpError(409, 'That M-PESA receipt code was already recorded in this shop', 'DUPLICATE');
        verification = 'receipt_recorded';
        // 'verified' only if the code matches a PAID NECPRA STK transaction for at least this amount.
        const hasStk = (await run(`SELECT to_regclass('stk_transactions') IS NOT NULL AS ok`, {}, t))[0].ok;
        if (hasStk) {
          const stk = await run(
            `SELECT 1 AS ok FROM stk_transactions WHERE mpesa_receipt = :code AND status = 'paid' AND paid_amount >= :amt LIMIT 1`, { code, amt: amount }, t);
          if (stk.length) verification = 'verified';
        }
      }
      const sales = await run(
        `SELECT id, balance_due FROM duka_sales WHERE shop_id = :shopId AND customer_id = :cid AND status = 'completed' AND balance_due > 0
          ORDER BY sold_at, receipt_no FOR UPDATE`, { shopId: shop.id, cid }, t);
      const owedC = sales.reduce((s, r) => s + cents(r.balance_due), 0);
      if (owedC <= 0) throw new HttpError(409, 'This customer does not owe anything', 'NO_DEBT');
      let left = cents(amount);
      if (left > owedC) throw new HttpError(409, `This customer owes only KES ${(owedC / 100).toFixed(2)}. You cannot collect more than that.`, 'OVERPAYMENT');
      const [pay] = await run(
        `INSERT INTO duka_debt_payments (id,shop_id,customer_id,amount,method,mpesa_receipt,verification,note,created_by)
         VALUES (:id,:shopId,:cid,:amount,:m,:code,:verification,:note,:userId) RETURNING *`,
        { id, shopId: shop.id, cid, amount, m, code, verification, note, userId: req.user.id }, t);
      const alloc = [];
      for (const s of sales) {
        if (left <= 0) break;
        const a = Math.min(left, cents(s.balance_due));
        await run(
          `UPDATE duka_sales SET amount_paid = amount_paid + :a::numeric, balance_due = balance_due - :a::numeric,
                  payment_status = CASE WHEN balance_due - :a::numeric = 0 THEN 'paid' ELSE 'partial' END WHERE id = :sid RETURNING id`,
          { a: a / 100, sid: s.id }, t);
        await run('INSERT INTO duka_debt_allocations (payment_id,sale_id,amount) VALUES (:id,:sid,:a) RETURNING payment_id', { id, sid: s.id, a: a / 100 }, t);
        alloc.push({ sale_id: s.id, amount: a / 100 });
        left -= a;
      }
      await audit(t, req, shop.id, 'customer.debt_payment', 'customer', cid, null, { paymentId: id, amount, method: m, verification, allocations: alloc });
      return { pay, alloc, created: true };
    });
    const [rem] = await run(
      `SELECT COALESCE(SUM(balance_due),0) AS owed FROM duka_sales WHERE customer_id = :cid AND status = 'completed'`, { cid });
    res.status(out.created ? 201 : 200).json({
      success: true,
      data: {
        payment: { id: out.pay.id, customerId: cid, amount: Number(out.pay.amount), method: out.pay.method, mpesaReceipt: out.pay.mpesa_receipt, verification: out.pay.verification, receivedAt: out.pay.received_at },
        allocations: out.alloc.map((a) => ({ saleId: a.sale_id, amount: Number(a.amount) })),
        remainingBalance: r2(rem.owed), idempotent: !out.created
      }
    });
  }));

  router.get('/shops/:shopId/customers/:customerId/statement', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const cid = uuid(req.params.customerId, 'Customer id', { required: true });
    const [cust] = await run('SELECT * FROM duka_customers WHERE id = :cid AND shop_id = :shopId', { cid, shopId: shop.id });
    if (!cust) throw new HttpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
    const open = await run(
      `SELECT id, receipt_no, total, amount_paid, balance_due, sold_at FROM duka_sales
        WHERE customer_id = :cid AND status = 'completed' AND balance_due > 0 ORDER BY sold_at, receipt_no`, { cid });
    const pays = await run(
      `SELECT id, amount, method, mpesa_receipt, verification, note, received_at FROM duka_debt_payments
        WHERE customer_id = :cid ORDER BY received_at DESC LIMIT 50`, { cid });
    res.json({
      success: true,
      data: {
        customer: { id: cust.id, name: cust.name, phone: cust.phone },
        owed: r2(open.reduce((s, r) => s + Number(r.balance_due), 0)),
        openSales: open.map((r) => ({ id: r.id, receiptNo: r.receipt_no, total: Number(r.total), amountPaid: Number(r.amount_paid), balanceDue: Number(r.balance_due), soldAt: r.sold_at })),
        payments: pays.map((r) => ({ id: r.id, amount: Number(r.amount), method: r.method, mpesaReceipt: r.mpesa_receipt, verification: r.verification, note: r.note, receivedAt: r.received_at }))
      }
    });
  }));

  router.get('/shops/:shopId/debts', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const cust = await run(
      `SELECT c.id, c.name, c.phone, SUM(s.balance_due) AS owed, COUNT(*)::int AS n, MIN(s.sold_at) AS oldest
         FROM duka_customers c JOIN duka_sales s ON s.customer_id = c.id AND s.status = 'completed' AND s.balance_due > 0
        WHERE c.shop_id = :shopId GROUP BY c.id ORDER BY owed DESC, lower(c.name)`, { shopId: shop.id });
    const sup = await run(
      `SELECT s.*, ${OWED} AS owed FROM duka_suppliers s JOIN duka_supplier_entries e ON e.supplier_id = s.id
        WHERE s.shop_id = :shopId GROUP BY s.id HAVING ${OWED} > 0 ORDER BY ${OWED} DESC`, { shopId: shop.id });
    res.json({
      success: true,
      data: {
        customersOweYou: { total: r2(cust.reduce((s, r) => s + Number(r.owed), 0)), customers: cust.map((r) => ({ id: r.id, name: r.name, phone: r.phone, owed: r2(r.owed), unpaidSales: r.n, oldestSaleAt: r.oldest })) },
        youOweSuppliers: { total: r2(sup.reduce((s, r) => s + Number(r.owed), 0)), suppliers: sup.map(supplierOut) }
      }
    });
  }));

  /* ───────────── Reports: daily / weekly / monthly ───────────── */
  router.get('/shops/:shopId/reports', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const p = PERIODS[String(req.query.period || 'daily').toLowerCase()];
    if (!p) throw bad('period must be daily, weekly or monthly');
    let from = ymd(req.query.from, 'from'), to = ymd(req.query.to, 'to');
    const today = await nairobiToday();
    to = to || today;
    if (!from) {
      const back = p === 'day' ? 13 : p === 'week' ? 55 : 180;
      from = (await run(`SELECT to_char(:to::date - ${back},'YYYY-MM-DD') AS d`, { to }))[0].d;
    }
    if (from > to) throw bad('from cannot be after to');
    const [span] = await run(`SELECT (:to::date - :from::date) AS days`, { from, to });
    if (Number(span.days) > MAX_RANGE_DAYS) throw bad(`The date range can be at most ${MAX_RANGE_DAYS} days`);

    const base = { shopId: shop.id, from, to, p };
    const SALE_DAY = `(s.sold_at AT TIME ZONE 'Africa/Nairobi')`;
    const B = (col) => `to_char(date_trunc(:p, ${col})::date,'YYYY-MM-DD')`;
    const [series, sales, saleCash, collected, exps, supPaid, cats] = await Promise.all([
      run(`SELECT to_char(g::date,'YYYY-MM-DD') AS b FROM generate_series(date_trunc(:p, :from::date), :to::date, ('1 ' || :p)::interval) g ORDER BY 1`, base),
      run(`SELECT ${B(SALE_DAY)} AS b, COUNT(*)::int AS n, COALESCE(SUM(s.total),0) AS revenue, COALESCE(SUM(s.cogs),0) AS cogs,
                  COALESCE(SUM(s.discount_amount),0) AS discount,
                  COALESCE(SUM(s.total - COALESCE((SELECT SUM(sp.amount) FROM duka_sale_payments sp WHERE sp.sale_id = s.id),0)),0) AS credit
             FROM duka_sales s WHERE s.shop_id = :shopId AND s.status = 'completed' AND ${SALE_DAY}::date BETWEEN :from AND :to GROUP BY 1`, base),
      run(`SELECT ${B(SALE_DAY)} AS b, sp.method, COALESCE(SUM(sp.amount),0) AS amt
             FROM duka_sale_payments sp JOIN duka_sales s ON s.id = sp.sale_id
            WHERE s.shop_id = :shopId AND s.status = 'completed' AND ${SALE_DAY}::date BETWEEN :from AND :to GROUP BY 1, 2`, base),
      run(`SELECT ${B(`(d.received_at AT TIME ZONE 'Africa/Nairobi')`)} AS b, COALESCE(SUM(d.amount),0) AS amt FROM duka_debt_payments d
            WHERE d.shop_id = :shopId AND (d.received_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN :from AND :to GROUP BY 1`, base),
      run(`SELECT ${B('e.expense_date')} AS b, COALESCE(SUM(e.amount),0) AS amt FROM duka_expenses e
            WHERE e.shop_id = :shopId AND e.status = 'active' AND e.expense_date BETWEEN :from AND :to GROUP BY 1`, base),
      run(`SELECT ${B('e.entry_date')} AS b, COALESCE(SUM(e.amount),0) AS amt FROM duka_supplier_entries e
            WHERE e.shop_id = :shopId AND e.type = 'payment' AND e.entry_date BETWEEN :from AND :to GROUP BY 1`, base),
      run(`SELECT category, COALESCE(SUM(amount),0) AS amt FROM duka_expenses
            WHERE shop_id = :shopId AND status = 'active' AND expense_date BETWEEN :from AND :to GROUP BY 1 ORDER BY 2 DESC`, base)
    ]);
    const idx = (rows) => Object.fromEntries(rows.map((r) => [r.b, r]));
    const S = idx(sales), C = idx(collected), E = idx(exps), P = idx(supPaid);
    const cashBy = (m) => Object.fromEntries(saleCash.filter((r) => r.method === m).map((r) => [r.b, Number(r.amt)]));
    const CASH = cashBy('cash'), MP = cashBy('mpesa');
    const rows = series.map(({ b }) => {
      const s = S[b] || {};
      const revenue = r2(s.revenue), cogs = r2(s.cogs), exp = r2((E[b] || {}).amt);
      const cash = r2(CASH[b]), mpesa = r2(MP[b]), coll = r2((C[b] || {}).amt);
      return {
        periodStart: b, salesCount: s.n || 0, revenue, costOfGoodsSold: cogs, grossProfit: r2(revenue - cogs),
        expenses: exp, netProfit: r2(revenue - cogs - exp),
        cashFromSales: cash, mpesaFromSales: mpesa, debtCollected: coll, totalCashReceived: r2(cash + mpesa + coll),
        creditGiven: r2(s.credit), discountsGiven: r2(s.discount), supplierPayments: r2((P[b] || {}).amt)
      };
    });
    const sum = (k) => r2(rows.reduce((a, r) => a + r[k], 0));
    const totals = {};
    ['salesCount', 'revenue', 'costOfGoodsSold', 'grossProfit', 'expenses', 'netProfit', 'cashFromSales', 'mpesaFromSales', 'debtCollected',
      'totalCashReceived', 'creditGiven', 'discountsGiven', 'supplierPayments'].forEach((k) => { totals[k] = k === 'salesCount' ? rows.reduce((a, r) => a + r.salesCount, 0) : sum(k); });
    const [snap] = await run(
      `SELECT (SELECT COALESCE(SUM(balance_due),0) FROM duka_sales WHERE shop_id = :shopId AND status = 'completed') AS cust,
              (SELECT COALESCE(SUM(CASE WHEN type='bill' THEN amount ELSE -amount END),0) FROM duka_supplier_entries WHERE shop_id = :shopId) AS sup,
              (SELECT COALESCE(SUM(GREATEST(stock_qty,0) * buying_price),0) FROM duka_products WHERE shop_id = :shopId AND is_active) AS stock`, { shopId: shop.id });
    res.json({
      success: true,
      data: {
        period: p === 'day' ? 'daily' : p === 'week' ? 'weekly' : 'monthly', from, to, timezone: 'Africa/Nairobi',
        rows, totals, expensesByCategory: cats.map((r) => ({ category: r.category, total: r2(r.amt) })),
        position: { customersOweYou: r2(snap.cust), youOweSuppliers: r2(snap.sup), stockAtCost: r2(snap.stock) },
        definitions: {
          revenue: 'Value of completed sales after discounts (may include credit not yet paid).',
          grossProfit: 'Revenue minus the buying cost of what was sold.',
          netProfit: 'Gross profit minus expenses. This is the actual profit.',
          totalCashReceived: 'Money really received: cash and M-PESA at the till plus customer debt collections. Not profit.',
          creditGiven: 'Sales value not paid at the till (customer debt).',
          supplierPayments: 'Money paid to suppliers. Not an expense: stock cost reaches profit when the stock is sold.'
        }
      }
    });
  }));
}

module.exports = { mount };
