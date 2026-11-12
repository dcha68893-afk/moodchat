'use strict';
/**
 * NECPRA DUKA SMART — Smart Scale instalment reminders (push + SMS). Reminders ONLY: nothing here touches the device,
 * sales or stock, and every message says the scale keeps working. Late payment never disables anything.
 *
 *   GET /shops/:shopId/financing/reminder-settings
 *   PUT /shops/:shopId/financing/reminder-settings   { pushEnabled?, smsEnabled?, smsPhone?, smsConsent?, language? ('en'|'sw') }
 *   GET /shops/:shopId/financing/reminder-log        last 30 reminders for this shop (what was sent, on which channel)
 *   POST /financing/admin/reminders/run              { dryRun? }  (DUKA_ADMIN_IDS only) run the sweep now
 *
 * How it behaves
 *  - An hourly sweep (Africa/Nairobi) looks at approved/active plans. The amounts come from the same position() the statement
 *    uses, i.e. from VERIFIED payments only.
 *  - Kinds: deposit (every 3 days until paid), upcoming (instalment due today..2 days), overdue (once a week, at most
 *    DUKA_FIN_MAX_OVERDUE_REMINDERS = 6 per plan).
 *  - Quiet hours: nothing is sent before 08:00 or from 20:00 Nairobi time; it goes out in the next sweep inside the window.
 *  - PUSH is on by default (Android FCM + web push). SMS is OFF until the trader turns it on and ticks consent (it costs
 *    NECPRA money per message). SMS also needs DUKA_FIN_SMS_ENABLED=true and the Africa's Talking credentials already used by
 *    airtime (AFRICASTALKING_API_KEY / AFRICASTALKING_USERNAME); optional DUKA_FIN_SMS_SENDER_ID. Not configured => no SMS is
 *    attempted and nothing is logged as sent.
 *  - Each (plan, kind, period, channel) is claimed with INSERT .. ON CONFLICT before sending, so cluster workers, restarts and
 *    retries cannot send it twice. A failed send is retried on the next sweeps, up to 3 attempts.
 *  - 'sent' means the provider accepted it (FCM/web-push success, or Africa's Talking status 101). It is not proof of reading.
 */
const { position } = require('./dukaFinancing');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000, HOUR = 3600000, EAT_OFFSET = 3 * HOUR; // Kenya has no daylight saving
const WINDOW_START = 8, WINDOW_END = 20;
const envOn = (n, d = false) => { const v = process.env[n]; return v == null || v === '' ? d : String(v).toLowerCase() === 'true'; };
const maxOverdue = () => { const n = Number(process.env.DUKA_FIN_MAX_OVERDUE_REMINDERS); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6; };

const eatDate = (now) => new Date(now + EAT_OFFSET).toISOString().slice(0, 10);
const eatHour = (now) => new Date(now + EAT_OFFSET).getUTCHours();
const inSendWindow = (now = Date.now()) => { const h = eatHour(now); return h >= WINDOW_START && h < WINDOW_END; };
const mondayOf = (iso) => { const t = new Date(iso + 'T00:00:00Z').getTime(); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * DAY).toISOString().slice(0, 10); };
const kes = (n) => String(Math.round(Number(n) * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const niceDate = (iso, lang) => {
  const M = lang === 'sw' ? ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ago', 'Sep', 'Okt', 'Nov', 'Des'] : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(iso.slice(8, 10))} ${M[Number(iso.slice(5, 7)) - 1]}`;
};

/** +2547XXXXXXXX / +2541XXXXXXXX or null. Accepts 07.., 01.., 7.., 2547.., +2547.. */
function normalisePhone(p) {
  const s = String(p || '').replace(/[\s\-()]/g, '');
  let m = /^(?:\+?254|0)?([71]\d{8})$/.exec(s);
  return m ? '+254' + m[1] : null;
}

const TEXT = {
  en: {
    deposit: (a) => `Deposit of KSh ${kes(a)} is still to be paid to start your Smart Scale plan.`,
    upcoming: (a, d) => `Instalment of KSh ${kes(a)} is due ${d}.`,
    overdue: (a) => `KSh ${kes(a)} of instalments is overdue. Your scale keeps working normally.`,
    titles: { deposit: 'Smart Scale deposit', upcoming: 'Instalment due soon', overdue: 'Instalment overdue' }
  },
  sw: {
    deposit: (a) => `Amana ya KSh ${kes(a)} bado haijalipwa ili kuanza mpango wako wa Smart Scale.`,
    upcoming: (a, d) => `Malipo ya awamu ya KSh ${kes(a)} yanatakiwa ifikapo ${d}.`,
    overdue: (a) => `Malipo ya awamu ya KSh ${kes(a)} yamechelewa. Mizani yako inaendelea kufanya kazi kama kawaida.`,
    titles: { deposit: 'Amana ya Smart Scale', upcoming: 'Malipo ya awamu yanakaribia', overdue: 'Malipo ya awamu yamechelewa' }
  }
};

/**
 * Pure: which reminders does this plan need right now? `paidCents` = verified payments. Same rules as GET .../financing/reminders.
 * Returns [{ kind, periodKey, amount, dueDate?, title, body, sms }].
 */
function remindersFor(plan, paidCents, now = Date.now(), lang = 'en') {
  const L = TEXT[lang] || TEXT.en;
  if (!plan || !['approved', 'active'].includes(plan.status) || plan.device_price == null) return [];
  const pos = position(plan, paidCents, now), out = [];
  const mk = (kind, periodKey, amount, dueDate, body) => out.push({ kind, periodKey, amount, dueDate: dueDate || null, title: L.titles[kind], body, sms: 'NECPRA DUKA: ' + body });
  const today = eatDate(now);
  if (pos.depositOutstanding > 0) {
    mk('deposit', 'd' + Math.floor(new Date(today + 'T00:00:00Z').getTime() / DAY / 3), pos.depositOutstanding, null, L.deposit(pos.depositOutstanding));
    return out; // nothing else is due until the plan starts
  }
  if (pos.arrears > 0) mk('overdue', 'w' + mondayOf(today), pos.arrears, null, L.overdue(pos.arrears));
  else if (pos.nextInstalment) {
    const days = Math.ceil((new Date(pos.nextInstalment.dueDate + 'T23:59:59Z').getTime() - now) / DAY);
    if (days >= 0 && days <= 2) mk('upcoming', pos.nextInstalment.dueDate, pos.nextInstalment.amountLeft, pos.nextInstalment.dueDate, L.upcoming(pos.nextInstalment.amountLeft, niceDate(pos.nextInstalment.dueDate, lang)));
  }
  return out;
}

/* ───────── channels ───────── */
const smsConfigured = () => envOn('DUKA_FIN_SMS_ENABLED') && !!(process.env.AFRICASTALKING_API_KEY || process.env.AT_API_KEY) && !!(process.env.AFRICASTALKING_USERNAME || process.env.AT_USERNAME);

async function sendSmsAT(to, message) {
  const key = process.env.AFRICASTALKING_API_KEY || process.env.AT_API_KEY, user = process.env.AFRICASTALKING_USERNAME || process.env.AT_USERNAME;
  const sandbox = (process.env.AFRICASTALKING_ENV || process.env.AT_ENV || 'production') === 'sandbox';
  const body = new URLSearchParams({ username: user, to, message });
  if (process.env.DUKA_FIN_SMS_SENDER_ID) body.set('from', process.env.DUKA_FIN_SMS_SENDER_ID);
  const r = await fetch(`https://api.${sandbox ? 'sandbox.' : ''}africastalking.com/version1/messaging`, {
    method: 'POST', headers: { Accept: 'application/json', apiKey: key, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (_) { /* non-JSON error page */ }
  const rec = j && j.SMSMessageData && j.SMSMessageData.Recipients && j.SMSMessageData.Recipients[0];
  if (!r.ok || !rec || Number(rec.statusCode) !== 101) throw new Error(`SMS not accepted (${r.status}${rec ? ' ' + (rec.status || rec.statusCode) : ''})`);
  return true;
}

/** Push to every device the trader has: Android FCM + web push. Returns { delivered, attempted }. */
async function sendPush(userId, r, sequelize) {
  let delivered = 0, attempted = 0;
  try {
    const fcm = require('./pushService');
    const res = await fcm.sendToUsers([Number(userId)], { title: r.title, body: r.body }, { type: 'duka_financing', channelId: 'general', url: '/duka.html', planKind: r.kind }, { category: 'other' });
    attempted += (res.successCount || 0) + (res.failureCount || 0); delivered += res.successCount || 0;
  } catch (e) { console.warn('[dukaFinReminders] FCM:', e.message); }
  try {
    const web = require('./pushNotificationService');
    const n = await web.sendToUser(Number(userId), 'duka:financing', { title: r.title, message: r.body, kind: r.kind }, sequelize);
    delivered += Number(n) || 0; attempted += Number(n) || 0;
  } catch (e) { console.warn('[dukaFinReminders] web push:', e.message); }
  return { delivered, attempted };
}

/* ───────── the sweep ───────── */
async function sweep(sequelize, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now, dryRun = !!opts.dryRun;
  const send = { push: opts.sendPush || sendPush, sms: opts.sendSms || sendSmsAT };
  const smsOk = opts.smsConfigured == null ? smsConfigured() : opts.smsConfigured;
  const q = (sql, rep) => sequelize.query(sql, { replacements: rep, type: 'SELECT' });
  const stats = { considered: 0, due: 0, sent: 0, failed: 0, skipped: 0, duplicates: 0, dryRun, outsideWindow: false };
  if (!inSendWindow(now) && !opts.ignoreWindow) { stats.outsideWindow = true; return stats; }

  const plans = await q(`SELECT p.*, s.owner_id, s.phone AS shop_phone,
        COALESCE(rs.push_enabled, TRUE) AS push_enabled, COALESCE(rs.sms_enabled, FALSE) AS sms_enabled, rs.sms_phone, rs.sms_consent_at, COALESCE(rs.language,'en') AS language,
        (SELECT COALESCE(SUM(amount),0) FROM duka_fin_payments fp WHERE fp.plan_id = p.id) AS paid
      FROM duka_fin_plans p JOIN duka_shops s ON s.id = p.shop_id LEFT JOIN duka_fin_reminder_settings rs ON rs.shop_id = s.id
      WHERE p.status IN ('approved','active') AND s.status = 'active' ORDER BY p.created_at LIMIT 5000`, {});
  for (const p of plans) {
    stats.considered++;
    const list = remindersFor(p, Math.round(Number(p.paid) * 100), now, p.language);
    for (const r of list) {
      stats.due++;
      const channels = [];
      if (p.push_enabled) channels.push('push');
      const phone = normalisePhone(p.sms_phone || p.shop_phone);
      if (p.sms_enabled && p.sms_consent_at && phone && smsOk) channels.push('sms');
      if (r.kind === 'overdue') {
        const [n] = await q(`SELECT COUNT(DISTINCT period_key) AS n FROM duka_fin_reminder_log WHERE plan_id=:p AND kind='overdue' AND status IN ('sent','sending') AND period_key <> :k`, { p: p.id, k: r.periodKey });
        if (Number(n.n) >= maxOverdue()) { stats.skipped++; continue; }
      }
      for (const ch of channels) {
        if (dryRun) { stats.sent++; continue; }
        const claim = await q(`INSERT INTO duka_fin_reminder_log (plan_id,kind,period_key,channel,status) VALUES (:p,:k,:pk,:ch,'sending')
            ON CONFLICT (plan_id,kind,period_key,channel) DO UPDATE SET status='sending', attempts = duka_fin_reminder_log.attempts + 1, updated_at = NOW()
            WHERE duka_fin_reminder_log.attempts < 3 AND (duka_fin_reminder_log.status = 'failed'
               OR (duka_fin_reminder_log.status = 'sending' AND duka_fin_reminder_log.updated_at < NOW() - INTERVAL '10 minutes'))
            RETURNING id`, { p: p.id, k: r.kind, pk: r.periodKey, ch });
        if (!claim[0]) { stats.duplicates++; continue; }
        let status = 'sent', detail = null;
        try {
          if (ch === 'push') {
            const res = await send.push(p.owner_id, r, sequelize);
            if (res.delivered > 0) detail = `${res.delivered} device(s)`;
            else if (res.attempted === 0) { status = 'skipped'; detail = 'No registered device'; }
            else { status = 'failed'; detail = 'Provider rejected every device'; }
          } else { await send.sms(phone, r.sms); detail = 'Accepted by SMS provider'; }
        } catch (e) { status = 'failed'; detail = String(e.message || e).slice(0, 190); }
        await q(`UPDATE duka_fin_reminder_log SET status=:s, detail=:d, updated_at=NOW() WHERE id=:id RETURNING id`, { s: status, d: detail, id: claim[0].id });
        stats[status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'skipped']++;
      }
    }
  }
  return stats;
}

let _started = false;
/** Hourly at :05 Nairobi time. Safe to call from every cluster worker (the log's unique key de-duplicates). */
function startJob(sequelize) {
  if (_started || !envOn('DUKA_FIN_REMINDERS_ENABLED', true)) return false;
  let cron; try { cron = require('node-cron'); } catch (e) { console.warn('[dukaFinReminders] node-cron missing — reminders disabled'); return false; }
  _started = true;
  cron.schedule('5 * * * *', () => { sweep(sequelize).then((s) => { if (s.sent || s.failed) console.log('[dukaFinReminders]', JSON.stringify(s)); }).catch((e) => console.warn('[dukaFinReminders] sweep failed:', e.message)); }, { timezone: 'Africa/Nairobi' });
  console.log('[dukaFinReminders] hourly instalment reminder sweep scheduled');
  return true;
}

function mount(ctx) {
  const { router, run, tx, wrap, audit, ownedShop, HttpError, getSequelize, v } = ctx;
  const { has, ensureObject } = v;
  const adminIds = () => String(process.env.DUKA_ADMIN_IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
  const out = (s) => ({ pushEnabled: !!s.push_enabled, smsEnabled: !!s.sms_enabled, smsPhone: s.sms_phone || null, smsConsent: !!s.sms_consent_at, language: s.language });

  router.get('/shops/:shopId/financing/reminder-settings', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const [s] = await run('SELECT * FROM duka_fin_reminder_settings WHERE shop_id=:s', { s: shop.id });
    res.json({ success: true, data: { settings: out(s || { push_enabled: true, sms_enabled: false, language: 'en' }), smsAvailable: smsConfigured(), shopPhone: shop.phone || null, quietHours: '08:00-20:00 Africa/Nairobi',
      note: 'Reminders only. Late payment never disables your scale or blocks sales. SMS is optional and only sent after you agree.' } });
  }));

  router.put('/shops/:shopId/financing/reminder-settings', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const settings = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      const [cur] = await run('SELECT * FROM duka_fin_reminder_settings WHERE shop_id=:s FOR UPDATE', { s: shop.id }, t);
      const next = { push_enabled: cur ? cur.push_enabled : true, sms_enabled: cur ? cur.sms_enabled : false, sms_phone: cur ? cur.sms_phone : null, sms_consent_at: cur ? cur.sms_consent_at : null, language: cur ? cur.language : 'en' };
      if (has(b.pushEnabled)) { if (typeof b.pushEnabled !== 'boolean') throw new HttpError(400, 'pushEnabled must be true or false', 'VALIDATION_ERROR'); next.push_enabled = b.pushEnabled; }
      if (has(b.language)) { if (!['en', 'sw'].includes(b.language)) throw new HttpError(400, 'language must be en or sw', 'VALIDATION_ERROR'); next.language = b.language; }
      if (has(b.smsPhone)) { const ph = normalisePhone(b.smsPhone); if (!ph) throw new HttpError(400, 'Enter a valid Kenyan mobile number', 'VALIDATION_ERROR'); next.sms_phone = ph; }
      if (has(b.smsEnabled)) {
        if (typeof b.smsEnabled !== 'boolean') throw new HttpError(400, 'smsEnabled must be true or false', 'VALIDATION_ERROR');
        if (b.smsEnabled) {
          if (b.smsConsent !== true && !next.sms_consent_at) throw new HttpError(400, 'Please agree to receive SMS reminders', 'CONSENT_REQUIRED');
          if (!normalisePhone(next.sms_phone || shop.phone)) throw new HttpError(400, 'Add a mobile number for SMS reminders', 'PHONE_REQUIRED');
          if (b.smsConsent === true && !next.sms_consent_at) next.sms_consent_at = new Date();
        } else next.sms_consent_at = null; // turning SMS off withdraws consent
        next.sms_enabled = b.smsEnabled;
      }
      const [row] = await run(`INSERT INTO duka_fin_reminder_settings (shop_id,push_enabled,sms_enabled,sms_phone,sms_consent_at,language,updated_at) VALUES (:s,:pu,:se,:ph,:co,:lg,NOW())
          ON CONFLICT (shop_id) DO UPDATE SET push_enabled=:pu, sms_enabled=:se, sms_phone=:ph, sms_consent_at=:co, language=:lg, updated_at=NOW() RETURNING *`,
        { s: shop.id, pu: next.push_enabled, se: next.sms_enabled, ph: next.sms_phone, co: next.sms_consent_at, lg: next.language }, t);
      await audit(t, req, shop.id, 'financing.reminder_settings', 'fin_reminder_settings', shop.id, cur ? out(cur) : null, out(row));
      return row;
    });
    res.json({ success: true, data: { settings: out(settings), smsAvailable: smsConfigured() } });
  }));

  router.get('/shops/:shopId/financing/reminder-log', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const rows = await run(`SELECT l.kind,l.channel,l.status,l.detail,l.created_at FROM duka_fin_reminder_log l JOIN duka_fin_plans p ON p.id=l.plan_id WHERE p.shop_id=:s ORDER BY l.created_at DESC LIMIT 30`, { s: shop.id });
    res.json({ success: true, data: { reminders: rows.map((r) => ({ kind: r.kind, channel: r.channel, status: r.status, detail: r.detail, at: r.created_at })) } });
  }));

  router.post('/financing/admin/reminders/run', wrap(async (req, res) => {
    if (!adminIds().includes(req.user.id)) throw new HttpError(403, 'Not allowed', 'FORBIDDEN');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const seq = getSequelize ? getSequelize() : require('../models').sequelize;
    res.json({ success: true, data: { stats: await sweep(seq, { dryRun: b.dryRun === true }) } });
  }));
}

module.exports = { mount, startJob, sweep, remindersFor, normalisePhone, inSendWindow, TEXT };
