'use strict';
/**
 * NECPRA DUKA SMART — Device financing (NECPRA Smart Scale on instalments). Kept SEPARATE from sales and business revenue.
 *
 * Trader (JWT, own shop only)
 *   GET  /shops/:shopId/financing/eligibility   indicative check from the shop's REAL sales (never a decision)
 *   POST /shops/:shopId/financing/applications  apply (needs explicit consent to share the eligibility figures with NECPRA)
 *   GET  /shops/:shopId/financing               plans with balance, schedule position and arrears
 *   GET  /shops/:shopId/financing/summary       outstanding balance + arrears (dashboard)
 *   GET  /shops/:shopId/financing/reminders     instalments due/overdue (for the app or a notification job)
 *   GET  /shops/:shopId/financing/:planId/statement
 *   POST /shops/:shopId/financing/:planId/payments   record a repayment; counted ONLY if the M-PESA receipt matches a PAID NECPRA STK payment
 *   POST /shops/:shopId/financing/:planId/repairs    warranty / repair request
 * Admin (user id listed in DUKA_ADMIN_IDS)
 *   GET  /financing/admin/applications?status=
 *   POST /financing/admin/:planId/approve   devicePrice, deposit, weeklyAmount, warrantyMonths  (terms are set by NECPRA, never invented here)
 *   POST /financing/admin/:planId/reject
 *   POST /financing/admin/:planId/link-device
 *   POST /financing/admin/repairs/:repairId/status
 *
 * Rules: a device is NEVER disabled, throttled or blocked because of arrears — nothing in this module touches device
 * credentials or sales. Arrears only produce reminders and a statement. Any future restriction must be disclosed in the
 * agreement first. Ownership becomes 'owned' only when the verified payments cover the full price.
 */
const MPESA_CODE_RE = /^[A-Z0-9]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const c = (x) => Math.round(Number(x) * 100);
const m = (cents) => cents / 100;
const DAY = 86400000;
const adminIds = () => String(process.env.DUKA_ADMIN_IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
const num = (name, d) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : d; };
const iso = (d) => new Date(d).toISOString().slice(0, 10);

/** Instalment schedule for a plan row. Last instalment carries the remainder so the schedule adds up exactly. */
function buildSchedule(plan) {
  if (!plan.start_date || !plan.weeks || !plan.weekly_amount) return [];
  const price = c(plan.device_price), dep = c(plan.deposit), w = c(plan.weekly_amount), n = Number(plan.weeks);
  const start = new Date(String(plan.start_date).slice(0, 10) + 'T00:00:00Z').getTime();
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ no: i, dueDate: iso(start + 7 * i * DAY), cents: i === n ? price - dep - w * (n - 1) : w });
  return rows;
}
/** Where the plan stands, from verified payments only. */
function position(plan, paidCents, now = Date.now()) {
  const price = plan.device_price == null ? 0 : c(plan.device_price), dep = plan.deposit == null ? 0 : c(plan.deposit);
  const depositPaid = Math.min(paidCents, dep), instPaid = Math.max(0, paidCents - dep);
  let cum = 0, dueSoFar = 0, next = null;
  const schedule = buildSchedule(plan).map((s) => {
    cum += s.cents;
    const paidPart = Math.max(0, Math.min(s.cents, instPaid - (cum - s.cents)));
    const settled = paidPart >= s.cents;
    const due = new Date(s.dueDate + 'T00:00:00Z').getTime() <= now;
    if (due) dueSoFar += s.cents;
    if (!settled && !next) next = { no: s.no, dueDate: s.dueDate, amountLeft: m(s.cents - paidPart) };
    return { no: s.no, dueDate: s.dueDate, amount: m(s.cents), paid: m(paidPart), status: settled ? 'paid' : (new Date(s.dueDate + 'T23:59:59Z').getTime() < now ? 'overdue' : 'upcoming') };
  });
  const active = plan.status === 'active';
  const arrears = active && depositPaid >= dep ? Math.max(0, dueSoFar - instPaid) : 0;
  return { priceTotal: m(price), deposit: m(dep), depositPaid: m(depositPaid), depositOutstanding: m(dep - depositPaid), paid: m(paidCents),
    balance: m(Math.max(0, price - paidCents)), arrears: m(arrears), nextInstalment: next, schedule };
}

function mount(ctx) {
  const { router, run, tx, wrap, audit, ownedShop, HttpError, v } = ctx;
  const { has, str, money, uuid, ensureObject } = v;
  const bad = (msg, code) => new HttpError(400, msg, code || 'VALIDATION_ERROR');
  const nf = (what) => new HttpError(404, `${what} not found`, 'NOT_FOUND');
  const isAdmin = (req) => adminIds().includes(req.user.id);
  const needAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(403, 'Not allowed', 'FORBIDDEN'); };
  const pid = (req, k) => { if (!UUID_RE.test(req.params[k] || '')) throw nf('Record'); return req.params[k].toLowerCase(); };

  const planOut = (p, paid) => ({
    id: p.id, shopId: p.shop_id, deviceModel: p.device_model, deviceId: p.device_id, status: p.status, ownership: p.ownership,
    startDate: p.start_date, warrantyUntil: p.warranty_until, rejectReason: p.reject_reason, createdAt: p.created_at,
    terms: p.device_price == null ? null : { devicePrice: Number(p.device_price), deposit: Number(p.deposit), weeklyAmount: Number(p.weekly_amount), weeks: p.weeks },
    ...(p.device_price == null ? { progress: null } : { progress: (({ schedule, ...rest }) => rest)(position(p, paid)) })
  });
  const paidOf = async (planId, t) => c((await run('SELECT COALESCE(SUM(amount),0) AS s FROM duka_fin_payments WHERE plan_id=:p', { p: planId }, t))[0].s);

  /** Indicative eligibility from the shop's own recorded sales. It informs NECPRA's decision; it does not make it. */
  async function eligibility(shop, weekly) {
    const [s] = await run(`SELECT COUNT(*) AS n, COUNT(DISTINCT (sold_at AT TIME ZONE 'Africa/Nairobi')::date) AS days,
        COALESCE(SUM(total - cogs),0) AS gp FROM duka_sales WHERE shop_id=:s AND status='completed' AND sold_at >= NOW() - INTERVAL '28 days'`, { s: shop.id });
    const ageDays = Math.floor((Date.now() - new Date(shop.created_at).getTime()) / DAY);
    const minAge = num('DUKA_FIN_MIN_SHOP_DAYS', 30), minSales = num('DUKA_FIN_MIN_SALES_28D', 20), maxShare = num('DUKA_FIN_MAX_PROFIT_SHARE', 0.2);
    const avgWeeklyGP = Math.round(Number(s.gp) / 4 * 100) / 100;
    const checks = [
      { key: 'shopAge', ok: ageDays >= minAge, detail: `Shop recorded for ${ageDays} days (needs ${minAge}).` },
      { key: 'activity', ok: Number(s.n) >= minSales, detail: `${s.n} completed sales in the last 28 days (needs ${minSales}).` }
    ];
    if (weekly != null) checks.push({ key: 'affordability', ok: avgWeeklyGP > 0 && weekly <= avgWeeklyGP * maxShare,
      detail: `Weekly instalment KSh ${weekly} vs average weekly gross profit KSh ${avgWeeklyGP} (instalment should be at most ${Math.round(maxShare * 100)}%).` });
    return { indicative: true, meetsGuidelines: checks.every((x) => x.ok), checks, figures: { shopAgeDays: ageDays, sales28d: Number(s.n), tradingDays28d: Number(s.days), avgWeeklyGrossProfit: avgWeeklyGP },
      note: 'Calculated from your recorded sales. This is a guide only; NECPRA makes the final decision and may ask for more information.' };
  }

  router.get('/shops/:shopId/financing/eligibility', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const w = has(req.query.weeklyAmount) ? money(req.query.weeklyAmount, 'weeklyAmount') : null;
    res.json({ success: true, data: await eligibility(shop, w) });
  }));

  router.post('/shops/:shopId/financing/applications', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = uuid(b.id, 'id', { required: true });
    if (b.consentShareData !== true) throw bad('Please agree to share your shop figures with NECPRA for this application', 'CONSENT_REQUIRED');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const [ex] = await run('SELECT * FROM duka_fin_plans WHERE id=:id', { id }, t);
      if (ex) { if (ex.shop_id !== shop.id) throw nf('Application'); return { p: ex, created: false }; }
      const [open] = await run(`SELECT 1 AS x FROM duka_fin_plans WHERE shop_id=:s AND status IN ('applied','approved','active')`, { s: shop.id }, t);
      if (open) throw new HttpError(409, 'This shop already has an open device application or plan', 'PLAN_EXISTS');
      const el = await eligibility(shop, null);
      const [p] = await run(`INSERT INTO duka_fin_plans (id,shop_id,user_id,device_model,consent_at,eligibility,note) VALUES (:id,:s,:u,:dm,NOW(),:el::jsonb,:n) RETURNING *`,
        { id, s: shop.id, u: req.user.id, dm: str(b.deviceModel, 'Device model', { max: 80 }) || 'NECPRA Smart Scale', el: JSON.stringify(el), n: str(b.note, 'Note', { max: 300 }) }, t);
      await audit(t, req, shop.id, 'financing.apply', 'fin_plan', p.id, null, { consent: true });
      return { p, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { plan: planOut(out.p, 0), note: 'Application received. NECPRA will set the price, deposit and weekly amount when it approves; you will see them here before you pay anything.' } });
  }));

  router.get('/shops/:shopId/financing', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const rows = await run('SELECT * FROM duka_fin_plans WHERE shop_id=:s ORDER BY created_at DESC', { s: shop.id });
    const plans = [];
    for (const p of rows) plans.push(planOut(p, await paidOf(p.id)));
    res.json({ success: true, data: { plans } });
  }));

  router.get('/shops/:shopId/financing/summary', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const rows = await run(`SELECT * FROM duka_fin_plans WHERE shop_id=:s AND status IN ('approved','active')`, { s: shop.id });
    let outstanding = 0, arrears = 0;
    for (const p of rows) { const pos = position(p, await paidOf(p.id)); outstanding += c(pos.balance); arrears += c(pos.arrears); }
    res.json({ success: true, data: { outstandingDeviceFinancing: m(outstanding), arrears: m(arrears), openPlans: rows.length } });
  }));

  router.get('/shops/:shopId/financing/reminders', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const rows = await run(`SELECT * FROM duka_fin_plans WHERE shop_id=:s AND status IN ('approved','active')`, { s: shop.id });
    const reminders = [];
    for (const p of rows) {
      const pos = position(p, await paidOf(p.id));
      if (pos.depositOutstanding > 0) reminders.push({ planId: p.id, kind: 'deposit', amount: pos.depositOutstanding, message: `Deposit of KSh ${pos.depositOutstanding} is still to be paid to start your plan.` });
      if (pos.arrears > 0) reminders.push({ planId: p.id, kind: 'overdue', amount: pos.arrears, message: `KSh ${pos.arrears} of instalments is overdue. Your scale keeps working normally.` });
      else if (pos.nextInstalment) {
        const days = Math.ceil((new Date(pos.nextInstalment.dueDate + 'T23:59:59Z').getTime() - Date.now()) / DAY);
        if (days >= 0 && days <= 2) reminders.push({ planId: p.id, kind: 'upcoming', amount: pos.nextInstalment.amountLeft, dueDate: pos.nextInstalment.dueDate, message: `Instalment of KSh ${pos.nextInstalment.amountLeft} is due ${pos.nextInstalment.dueDate}.` });
      }
    }
    res.json({ success: true, data: { reminders, note: 'Reminders only. Late payment never disables the device or blocks sales.' } });
  }));

  async function ownPlan(req, shop, t, lock = false) {
    const [p] = await run(`SELECT * FROM duka_fin_plans WHERE id=:id AND shop_id=:s ${lock ? 'FOR UPDATE' : ''}`, { id: pid(req, 'planId'), s: shop.id }, t);
    if (!p) throw nf('Plan');
    return p;
  }

  router.get('/shops/:shopId/financing/:planId/statement', wrap(async (req, res) => {
    const shop = await ownedShop(req), p = await ownPlan(req, shop);
    const pays = await run('SELECT id,amount,mpesa_receipt,created_at FROM duka_fin_payments WHERE plan_id=:p ORDER BY created_at, id', { p: p.id });
    const paid = pays.reduce((a, x) => a + c(x.amount), 0);
    const repairs = await run('SELECT id,kind,details,status,resolution,created_at FROM duka_fin_repairs WHERE plan_id=:p ORDER BY created_at DESC', { p: p.id });
    const pos = p.device_price == null ? null : position(p, paid);
    res.json({ success: true, data: { plan: planOut(p, paid), schedule: pos ? pos.schedule : [],
      payments: pays.map((x) => ({ id: x.id, amount: Number(x.amount), mpesaReceipt: x.mpesa_receipt, recordedAt: x.created_at })),
      repairs: repairs.map((r) => ({ id: r.id, kind: r.kind, details: r.details, status: r.status, resolution: r.resolution, createdAt: r.created_at })),
      generatedAt: new Date().toISOString() } });
  }));

  router.post('/shops/:shopId/financing/:planId/payments', wrap(async (req, res) => {
    const b = ensureObject(req.body), payId = uuid(b.id, 'id', { required: true });
    const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero');
    const code = String(b.mpesaReceipt || '').trim().toUpperCase();
    if (!MPESA_CODE_RE.test(code)) throw bad('Enter the 10-character M-PESA receipt code');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t }), p = await ownPlan(req, shop, t, true);
      const [dupId] = await run('SELECT * FROM duka_fin_payments WHERE id=:id', { id: payId }, t);
      if (dupId) { if (dupId.plan_id !== p.id) throw nf('Payment'); return { p, replay: true }; }
      if (!['approved', 'active'].includes(p.status)) throw new HttpError(409, 'This plan is not accepting payments', 'PLAN_NOT_PAYABLE');
      const paid = await paidOf(p.id, t), price = c(p.device_price);
      if (c(amount) > price - paid) throw new HttpError(409, `That is more than the remaining balance of KSh ${m(price - paid).toFixed(2)}`, 'OVERPAYMENT');
      const [used] = await run(`SELECT (SELECT COUNT(*) FROM duka_fin_payments WHERE mpesa_receipt=:c) + (SELECT COUNT(*) FROM duka_gb_payments WHERE mpesa_receipt=:c) AS n`, { c: code }, t);
      if (Number(used.n) > 0) throw new HttpError(409, 'That M-PESA receipt was already used', 'RECEIPT_USED');
      let ok = [];
      try { ok = await run(`SELECT 1 AS ok FROM stk_transactions WHERE mpesa_receipt=:c AND status='paid' AND paid_amount >= :a LIMIT 1`, { c: code, a: amount }, t); } catch (_) { ok = []; }
      if (!ok[0]) throw new HttpError(409, `M-PESA receipt ${code} could not be confirmed as a paid NECPRA payment of KSh ${amount.toFixed(2)}. Nothing was recorded.`, 'MPESA_NOT_VERIFIED');
      await run('INSERT INTO duka_fin_payments (id,plan_id,amount,mpesa_receipt,recorded_by) VALUES (:id,:p,:a,:c,:u) RETURNING id', { id: payId, p: p.id, a: amount, c: code, u: req.user.id }, t);
      const total = paid + c(amount);
      let next = p;
      if (total >= price) [next] = await run(`UPDATE duka_fin_plans SET status='completed', ownership='owned', updated_at=NOW() WHERE id=:id RETURNING *`, { id: p.id }, t);
      else if (p.status === 'approved' && total >= c(p.deposit)) [next] = await run(`UPDATE duka_fin_plans SET status='active', ownership='financed', start_date=(NOW() AT TIME ZONE 'Africa/Nairobi')::date, updated_at=NOW() WHERE id=:id RETURNING *`, { id: p.id }, t);
      await audit(t, req, shop.id, 'financing.payment', 'fin_plan', p.id, null, { amount, receipt: code, status: next.status });
      return { p: next, total };
    });
    const paid = out.replay ? await paidOf(out.p.id) : out.total;
    res.status(out.replay ? 200 : 201).json({ success: true, data: { plan: planOut(out.p, paid), replay: !!out.replay } });
  }));

  router.post('/shops/:shopId/financing/:planId/repairs', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = uuid(b.id, 'id', { required: true });
    if (!['warranty', 'repair'].includes(b.kind)) throw bad('kind must be warranty or repair');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t }), p = await ownPlan(req, shop, t);
      const [ex] = await run('SELECT * FROM duka_fin_repairs WHERE id=:id', { id }, t);
      if (ex) { if (ex.plan_id !== p.id) throw nf('Request'); return ex; }
      if (!['active', 'completed'].includes(p.status)) throw new HttpError(409, 'The device is not yet with you under this plan', 'PLAN_NOT_ACTIVE');
      const [r] = await run('INSERT INTO duka_fin_repairs (id,plan_id,kind,details,created_by) VALUES (:id,:p,:k,:d,:u) RETURNING *', { id, p: p.id, k: b.kind, d: str(b.details, 'Details', { max: 400, required: true }), u: req.user.id }, t);
      await audit(t, req, shop.id, 'financing.repair', 'fin_repair', r.id, null, { kind: b.kind });
      return r;
    });
    res.status(201).json({ success: true, data: { repair: { id: out.id, kind: out.kind, details: out.details, status: out.status } } });
  }));

  /* ───── NECPRA admin ───── */
  router.get('/financing/admin/applications', wrap(async (req, res) => {
    needAdmin(req);
    const st = String(req.query.status || 'applied');
    if (!['applied', 'approved', 'active', 'completed', 'rejected', 'cancelled'].includes(st)) throw bad('Unknown status');
    const rows = await run(`SELECT p.*, s.name AS shop_name, s.phone AS shop_phone FROM duka_fin_plans p JOIN duka_shops s ON s.id=p.shop_id WHERE p.status=:st ORDER BY p.created_at LIMIT 100`, { st });
    res.json({ success: true, data: { applications: rows.map((p) => ({ ...planOut(p, 0), shopName: p.shop_name, shopPhone: p.shop_phone, eligibility: p.eligibility, note: p.note })) } });
  }));
  router.post('/financing/admin/:planId/approve', wrap(async (req, res) => {
    needAdmin(req);
    const b = ensureObject(req.body), id = pid(req, 'planId');
    const price = money(b.devicePrice, 'Device price'), dep = money(b.deposit, 'Deposit'), weekly = money(b.weeklyAmount, 'Weekly amount');
    if (!(price > 0) || !(weekly > 0) || dep < 0 || dep >= price) throw bad('Price and weekly amount must be above zero and the deposit must be less than the price');
    const weeks = Math.ceil((c(price) - c(dep)) / c(weekly));
    if (weeks > 104) throw bad('That weekly amount would take more than two years to repay');
    const months = has(b.warrantyMonths) ? Math.min(Math.max(parseInt(b.warrantyMonths, 10) || 0, 0), 60) : 0;
    const out = await tx(async (t) => {
      const [p] = await run('SELECT * FROM duka_fin_plans WHERE id=:id FOR UPDATE', { id }, t);
      if (!p) throw nf('Application');
      if (p.status !== 'applied') throw new HttpError(409, 'Only a new application can be approved', 'BAD_STATE');
      const [u] = await run(`UPDATE duka_fin_plans SET status='approved', device_price=:pr, deposit=:d, weekly_amount=:w, weeks=:wk,
          warranty_until=(NOW() + (:mo || ' months')::interval)::date, decided_by=:u, decided_at=NOW(), updated_at=NOW() WHERE id=:id RETURNING *`,
        { pr: price, d: dep, w: weekly, wk: weeks, mo: String(months), u: req.user.id, id }, t);
      await audit(t, req, p.shop_id, 'financing.approve', 'fin_plan', id, null, { price, dep, weekly, weeks });
      return u;
    });
    res.json({ success: true, data: { plan: planOut(out, 0) } });
  }));
  router.post('/financing/admin/:planId/reject', wrap(async (req, res) => {
    needAdmin(req);
    const b = ensureObject(req.body), id = pid(req, 'planId');
    const reason = str(b.reason, 'Reason', { max: 240, required: true });
    const out = await tx(async (t) => {
      const [p] = await run(`UPDATE duka_fin_plans SET status='rejected', reject_reason=:r, decided_by=:u, decided_at=NOW(), updated_at=NOW() WHERE id=:id AND status='applied' RETURNING *`, { r: reason, u: req.user.id, id }, t);
      if (!p) throw new HttpError(409, 'Only a new application can be rejected', 'BAD_STATE');
      await audit(t, req, p.shop_id, 'financing.reject', 'fin_plan', id, null, { reason });
      return p;
    });
    res.json({ success: true, data: { plan: planOut(out, 0) } });
  }));
  router.post('/financing/admin/:planId/link-device', wrap(async (req, res) => {
    needAdmin(req);
    const b = ensureObject(req.body), id = pid(req, 'planId'), deviceId = uuid(b.deviceId, 'deviceId', { required: true });
    const out = await tx(async (t) => {
      const [p] = await run('SELECT * FROM duka_fin_plans WHERE id=:id FOR UPDATE', { id }, t);
      if (!p) throw nf('Plan');
      const [d] = await run('SELECT id FROM duka_devices WHERE id=:d AND shop_id=:s', { d: deviceId, s: p.shop_id }, t);
      if (!d) throw new HttpError(409, 'Register the device on this trader\'s shop first', 'DEVICE_NOT_IN_SHOP');
      const [u] = await run('UPDATE duka_fin_plans SET device_id=:d, updated_at=NOW() WHERE id=:id RETURNING *', { d: deviceId, id }, t);
      await audit(t, req, p.shop_id, 'financing.link_device', 'fin_plan', id, null, { deviceId });
      return u;
    });
    res.json({ success: true, data: { plan: planOut(out, await paidOf(id)) } });
  }));
  router.post('/financing/admin/repairs/:repairId/status', wrap(async (req, res) => {
    needAdmin(req);
    const b = ensureObject(req.body), id = pid(req, 'repairId');
    if (!['in_repair', 'resolved', 'rejected'].includes(b.status)) throw bad('Unknown status');
    const [r] = await run('UPDATE duka_fin_repairs SET status=:s, resolution=:n, updated_at=NOW() WHERE id=:id RETURNING *', { s: b.status, n: str(b.resolution, 'Resolution', { max: 300 }), id });
    if (!r) throw nf('Request');
    res.json({ success: true, data: { repair: { id: r.id, status: r.status, resolution: r.resolution } } });
  }));
}
module.exports = { mount, position, buildSchedule };
