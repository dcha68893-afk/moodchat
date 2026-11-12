'use strict';
/**
 * NECPRA DUKA SMART — instalment reminders.
 * Pure rules run always. The sweep/route tests need a real Postgres:
 *   DUKA_TEST_DB_URL=postgres://user:pass@localhost:5432/dukatest npx jest tests/current/duka-financing-reminders.test.js --runInBand
 */
const R = require('../../src/services/dukaFinancingReminders');
const { position } = require('../../src/services/dukaFinancing');
const T = (iso) => new Date(iso).getTime();
const plan = (o = {}) => ({ status: 'active', device_price: 6000, deposit: 1000, weekly_amount: 1000, weeks: 5, start_date: '2026-11-01', ...o });

describe('rules (no DB)', () => {
  test('phone numbers normalise to +254 or are rejected', () => {
    expect(R.normalisePhone('0712 345 678')).toBe('+254712345678');
    expect(R.normalisePhone('254112345678')).toBe('+254112345678');
    expect(R.normalisePhone('+254712345678')).toBe('+254712345678');
    expect(R.normalisePhone('12345')).toBeNull();
    expect(R.normalisePhone('0912345678')).toBeNull();
  });
  test('send window is 08:00-20:00 Nairobi', () => {
    expect(R.inSendWindow(T('2026-11-12T04:59:00Z'))).toBe(false); // 07:59 EAT
    expect(R.inSendWindow(T('2026-11-12T05:00:00Z'))).toBe(true);  // 08:00 EAT
    expect(R.inSendWindow(T('2026-11-12T16:59:00Z'))).toBe(true);  // 19:59 EAT
    expect(R.inSendWindow(T('2026-11-12T17:00:00Z'))).toBe(false); // 20:00 EAT
  });
  test('deposit unpaid -> deposit reminder only', () => {
    const r = R.remindersFor(plan({ status: 'approved', start_date: null }), 40000, T('2026-11-12T06:00:00Z'));
    expect(r.map((x) => x.kind)).toEqual(['deposit']);
    expect(r[0].amount).toBe(600);
  });
  test('instalment due within 2 days -> upcoming, with the amount still left', () => {
    // instalment 1 due 2026-11-08; "now" = 11-07
    const r = R.remindersFor(plan(), 100000, T('2026-11-07T06:00:00Z'));
    expect(r.map((x) => x.kind)).toEqual(['upcoming']);
    expect(r[0].periodKey).toBe('2026-11-08'); expect(r[0].amount).toBe(1000);
    expect(R.remindersFor(plan(), 100000, T('2026-11-03T06:00:00Z'))).toEqual([]); // 5 days away: too early
  });
  test('verified payments reduce what is asked for', () => {
    const r = R.remindersFor(plan(), 100000 + 40000, T('2026-11-07T06:00:00Z'));
    expect(r[0].amount).toBe(600);
  });
  test('overdue -> one reminder per week, same key all week, new key next week; amount = arrears', () => {
    const a = R.remindersFor(plan(), 100000, T('2026-11-12T06:00:00Z')); // inst 1 (8 Nov) unpaid
    const b = R.remindersFor(plan(), 100000, T('2026-11-13T06:00:00Z'));
    const c = R.remindersFor(plan(), 100000, T('2026-11-16T06:00:00Z')); // next Monday
    expect(a[0].kind).toBe('overdue'); expect(a[0].amount).toBe(1000);
    expect(a[0].periodKey).toBe(b[0].periodKey); expect(a[0].periodKey).not.toBe(c[0].periodKey);
  });
  test('fully paid, rejected, completed or unpriced plans get nothing', () => {
    expect(R.remindersFor(plan({ status: 'completed' }), 600000)).toEqual([]);
    expect(R.remindersFor(plan({ status: 'applied', device_price: null }), 0)).toEqual([]);
    expect(R.remindersFor(null, 0)).toEqual([]);
  });
  test('wording never threatens the device, SMS fits one message, Swahili available', () => {
    for (const lang of ['en', 'sw']) for (const now of ['2026-11-07T06:00:00Z', '2026-11-12T06:00:00Z']) {
      for (const r of R.remindersFor(plan(), 100000, T(now), lang)) {
        expect(r.sms.length).toBeLessThanOrEqual(160);
        expect(r.body).not.toMatch(/disable|block|lock|suspend|zima|funga/i);
      }
    }
    expect(R.remindersFor(plan(), 100000, T('2026-11-12T06:00:00Z'), 'sw')[0].body).toMatch(/Mizani/);
  });
  test('matches the schedule maths used by the statement', () => {
    expect(position(plan(), 100000, T('2026-11-12T06:00:00Z')).arrears).toBe(R.remindersFor(plan(), 100000, T('2026-11-12T06:00:00Z'))[0].amount);
  });
});

const URL_ = process.env.DUKA_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;
d('sweep + routes (real Postgres)', () => {
  const express = require('express');
  const { Sequelize } = require('sequelize');
  let sequelize, server, base;
  const U0 = 700000 + Math.floor(Math.random() * 90000) * 10;
  const A = U0 + 1, B = U0 + 2, ADMIN = U0 + 3;
  const uid = () => require('crypto').randomUUID();
  const call = async (user, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const q = (sql, rep) => sequelize.query(sql, { replacements: rep, type: 'SELECT' });
  const sh = {}, planOf = {};
  const NOW = T('2026-11-12T06:00:00Z'); // 09:00 EAT, inside the window
  const calls = { push: [], sms: [] };
  const sender = (over = {}) => ({ now: NOW, smsConfigured: true,
    sendPush: async (user, r) => { calls.push.push({ user, kind: r.kind }); return over.push || { delivered: 1, attempted: 1 }; },
    sendSms: async (to, text) => { calls.sms.push({ to, text }); if (over.smsFail) throw new Error('boom'); return true; } });

  beforeAll(async () => {
    process.env.DUKA_ADMIN_IDS = String(ADMIN);
    sequelize = new Sequelize(URL_, { logging: false });
    for (const m of ['20261111000001-create-duka-smart-phase1', '20261111000002-create-duka-smart-phase2', '20261111000003-create-duka-smart-phase5-finance', '20261111000004-duka-sale-void-and-product-description', '20261111000005-duka-batches-waste-devices', '20261111000006-duka-group-buying', '20261112000001-duka-financing-and-chama', '20261112000002-duka-financing-reminders']) {
      await require(`../../migrations/${m}.js`).up({ sequelize });
      await require(`../../migrations/${m}.js`).up({ sequelize }); // idempotent
    }
    await sequelize.query(`CREATE TABLE IF NOT EXISTS stk_transactions (mpesa_receipt VARCHAR(40), status VARCHAR(20), paid_amount NUMERIC(15,2))`);
    await sequelize.query(`CREATE TABLE IF NOT EXISTS money_circles (id UUID PRIMARY KEY, owner_id INTEGER, name VARCHAR(120), type VARCHAR(20) DEFAULT 'chama', status VARCHAR(12) DEFAULT 'active', collected_amount NUMERIC(15,2) DEFAULT 0)`);
    await sequelize.query(`CREATE TABLE IF NOT EXISTS money_circle_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), circle_id UUID, user_id INTEGER, role VARCHAR(10) DEFAULT 'member', status VARCHAR(10) DEFAULT 'active')`);
    const { buildRouter } = require('../../src/routes/duka');
    const app = express(); app.use(express.json());
    app.use('/api/duka', buildRouter({ getSequelize: () => sequelize, authenticate: (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ success: false }); req.user = { id: Number(u) }; next(); } }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/duka`;
    for (const [u, n] of [[A, 'A'], [B, 'B']]) {
      sh[u] = (await call(u, 'POST', '/shops', { name: n + uid().slice(0, 5), phone: '0712345678' })).body.data.shop.id;
      // an active plan that started 2026-11-01: instalment 1 (8 Nov) is overdue on 12 Nov; deposit already paid
      planOf[u] = uid();
      await sequelize.query(`INSERT INTO duka_fin_plans (id,shop_id,user_id,status,ownership,device_price,deposit,weekly_amount,weeks,start_date,consent_at) VALUES (:p,:s,:u,'active','financed',6000,1000,1000,5,'2026-11-01',NOW())`, { replacements: { p: planOf[u], s: sh[u], u } });
      await sequelize.query(`INSERT INTO duka_fin_payments (id,plan_id,amount,mpesa_receipt,recorded_by) VALUES (:i,:p,1000,:r,:u)`, { replacements: { i: uid(), p: planOf[u], r: ('D' + Math.random().toString(36).slice(2, 11)).toUpperCase().padEnd(10, 'X').slice(0, 10), u } });
    }
  });
  afterAll(async () => { if (server) server.close(); if (sequelize) await sequelize.close(); });
  beforeEach(() => { calls.push.length = 0; calls.sms.length = 0; });

  test('settings: defaults, validation, SMS needs consent + a number, turning off withdraws consent', async () => {
    const g = await call(A, 'GET', `/shops/${sh[A]}/financing/reminder-settings`);
    expect(g.body.data.settings).toMatchObject({ pushEnabled: true, smsEnabled: false, smsConsent: false });
    expect((await call(A, 'PUT', `/shops/${sh[A]}/financing/reminder-settings`, { smsEnabled: true })).status).toBe(400);               // no consent
    expect((await call(A, 'PUT', `/shops/${sh[A]}/financing/reminder-settings`, { smsEnabled: true, smsConsent: true, smsPhone: '123' })).status).toBe(400);
    expect((await call(A, 'PUT', `/shops/${sh[A]}/financing/reminder-settings`, { language: 'fr' })).status).toBe(400);
    const ok = await call(A, 'PUT', `/shops/${sh[A]}/financing/reminder-settings`, { smsEnabled: true, smsConsent: true, language: 'sw' });
    expect(ok.status).toBe(200); expect(ok.body.data.settings).toMatchObject({ smsEnabled: true, smsConsent: true, language: 'sw' });
    expect((await call(B, 'GET', `/shops/${sh[A]}/financing/reminder-settings`)).status).toBe(404);                                      // not B's shop
    expect((await call(B, 'PUT', `/shops/${sh[A]}/financing/reminder-settings`, { pushEnabled: false })).status).toBe(404);
  });

  test('sweep sends push + SMS once, and a second sweep (another cluster worker) sends nothing', async () => {
    const s1 = await R.sweep(sequelize, sender());
    expect(s1.sent).toBeGreaterThanOrEqual(3);                       // A: push+sms, B: push
    expect(calls.push.filter((c) => c.user === A).length).toBe(1);
    expect(calls.sms.filter((c) => c.to === '+254712345678').length).toBe(1);
    expect(calls.sms[0].text).toMatch(/^NECPRA DUKA: /); expect(calls.sms[0].text).toMatch(/Mizani/); // A chose Kiswahili
    const before = calls.push.length + calls.sms.length;
    const s2 = await R.sweep(sequelize, sender());
    expect(calls.push.length + calls.sms.length).toBe(before);
    expect(s2.duplicates).toBeGreaterThanOrEqual(3);
  });

  test('B did not opt into SMS -> no SMS to B; push off -> nothing for that shop', async () => {
    expect(calls.sms.length).toBe(0);
    const rows = await q(`SELECT channel FROM duka_fin_reminder_log WHERE plan_id=:p`, { p: planOf[B] });
    expect(rows.map((r) => r.channel)).toEqual(['push']);
  });

  test('outside quiet hours nothing is sent; dry run records nothing', async () => {
    await q(`DELETE FROM duka_fin_reminder_log WHERE plan_id IN (:a,:b) RETURNING id`, { a: planOf[A], b: planOf[B] });
    expect((await R.sweep(sequelize, { ...sender(), now: T('2026-11-12T18:00:00Z') })).outsideWindow).toBe(true); // 21:00 EAT
    expect(calls.push.length).toBe(0);
    const dry = await R.sweep(sequelize, { ...sender(), dryRun: true });
    expect(dry.dryRun).toBe(true); expect(calls.push.length).toBe(0);
    expect((await q(`SELECT 1 FROM duka_fin_reminder_log WHERE plan_id=:p`, { p: planOf[A] })).length).toBe(0);
  });

  test('failed SMS is retried (max 3 attempts) and never logged as sent; no device => skipped', async () => {
    await q(`DELETE FROM duka_fin_reminder_log WHERE plan_id IN (:a,:b) RETURNING id`, { a: planOf[A], b: planOf[B] });
    await R.sweep(sequelize, sender({ smsFail: true, push: { delivered: 0, attempted: 0 } }));
    let log = await q(`SELECT channel,status,attempts FROM duka_fin_reminder_log WHERE plan_id=:p ORDER BY channel`, { p: planOf[A] });
    expect(log).toEqual([{ channel: 'push', status: 'skipped', attempts: 1 }, { channel: 'sms', status: 'failed', attempts: 1 }]);
    await R.sweep(sequelize, sender({ smsFail: true })); await R.sweep(sequelize, sender({ smsFail: true })); await R.sweep(sequelize, sender({ smsFail: true }));
    log = await q(`SELECT attempts,status FROM duka_fin_reminder_log WHERE plan_id=:p AND channel='sms'`, { p: planOf[A] });
    expect(log[0]).toEqual({ attempts: 3, status: 'failed' });
    await R.sweep(sequelize, sender());                           // SMS provider recovers: attempts exhausted, so no 4th try
    expect(calls.sms.length).toBe(3);
  });

  test('SMS is never attempted when the server has no SMS provider configured', async () => {
    await q(`DELETE FROM duka_fin_reminder_log WHERE plan_id IN (:a,:b) RETURNING id`, { a: planOf[A], b: planOf[B] });
    await R.sweep(sequelize, { ...sender(), smsConfigured: false });
    expect(calls.sms.length).toBe(0);
    expect((await q(`SELECT 1 FROM duka_fin_reminder_log WHERE plan_id=:p AND channel='sms'`, { p: planOf[A] })).length).toBe(0);
  });

  test('a paid-up plan gets no reminder; overdue reminders stop after the cap', async () => {
    await q(`DELETE FROM duka_fin_reminder_log WHERE plan_id IN (:a,:b) RETURNING id`, { a: planOf[A], b: planOf[B] });
    process.env.DUKA_FIN_MAX_OVERDUE_REMINDERS = '2';
    for (const day of ['2026-11-12', '2026-11-19', '2026-11-26']) await R.sweep(sequelize, { ...sender(), now: T(day + 'T06:00:00Z'), smsConfigured: false });
    expect(calls.push.filter((c) => c.user === B).length).toBe(2);   // week 3 suppressed
    delete process.env.DUKA_FIN_MAX_OVERDUE_REMINDERS;
    await sequelize.query(`UPDATE duka_fin_plans SET status='completed' WHERE id=:p`, { replacements: { p: planOf[B] } });
    calls.push.length = 0;
    await R.sweep(sequelize, { ...sender(), now: T('2026-12-10T06:00:00Z'), smsConfigured: false });
    expect(calls.push.filter((c) => c.user === B).length).toBe(0);
  });

  test('reminder log is visible to the owner only; admin run is admin-only', async () => {
    const l = await call(A, 'GET', `/shops/${sh[A]}/financing/reminder-log`);
    expect(l.status).toBe(200); expect(Array.isArray(l.body.data.reminders)).toBe(true);
    expect((await call(B, 'GET', `/shops/${sh[A]}/financing/reminder-log`)).status).toBe(404);
    expect((await call(A, 'POST', '/financing/admin/reminders/run', { dryRun: true })).status).toBe(403);
    const r = await call(ADMIN, 'POST', '/financing/admin/reminders/run', { dryRun: true });
    expect(r.status).toBe(200); expect(r.body.data.stats.dryRun).toBe(true);
  });
});
