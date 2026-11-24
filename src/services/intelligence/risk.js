'use strict';
/**
 * NECPRA Financial Intelligence: transaction risk scoring.
 *
 * SAFETY CONTRACT (brief section 6):
 *  - This module only SCORES and RECORDS. It never approves, executes, reverses or blocks a payment. Existing authentication,
 *    step-up, limits and idempotency in the wallet / STK / money routes are untouched and still decide everything.
 *  - A score is a hint, never proof of wrongdoing. Every result says so (`notProof: true`) and every warning is written for a
 *    legitimate user: they can confirm "this is me" (status `user_confirmed_ok`), which feeds back as a trusted pattern.
 *  - action: allow (normal) | warn (show the user a warning, normal confirmation applies) | review (ask for an explicit
 *    acknowledgement before the request continues). "review" can be satisfied by the user themselves; nobody is locked out.
 *  - Reasons are deterministic and explainable. No hidden model, no private data leaves the server.
 */
const crypto = require('crypto');

const WEIGHTS = {
  amount_outlier: 25, amount_extreme: 35, first_recipient_large: 15, velocity_high: 35, velocity_medium: 18, possible_duplicate: 30,
  repeated_attempts: 20, new_device: 15, new_device_large: 10, odd_hour: 8, new_account: 15, drains_balance: 12, scam_wording: 30, amount_mismatch: 30
};

const MESSAGES = {
  amount_outlier: ['This is much larger than your usual payments.', 'Kiasi hiki ni kikubwa kuliko malipo yako ya kawaida.'],
  amount_extreme: ['This is more than ten times your usual payment.', 'Kiasi hiki ni zaidi ya mara kumi ya malipo yako ya kawaida.'],
  first_recipient_large: ['You have not sent money to this person before.', 'Hujawahi kutuma pesa kwa mtu huyu hapo awali.'],
  velocity_high: ['Many payments were attempted in a few minutes.', 'Malipo mengi yamejaribiwa ndani ya dakika chache.'],
  velocity_medium: ['Several payments were attempted in a few minutes.', 'Malipo kadhaa yamejaribiwa ndani ya dakika chache.'],
  possible_duplicate: ['A payment of the same amount to the same person was just attempted. This may be a duplicate.', 'Malipo ya kiasi kilekile kwa mtu yuleyule yamejaribiwa punde. Huenda ni mara mbili.'],
  repeated_attempts: ['This payment has been attempted several times recently.', 'Malipo haya yamejaribiwa mara kadhaa hivi karibuni.'],
  new_device: ['This payment is from a device we have not seen on your account.', 'Malipo haya yanatoka kwenye kifaa ambacho hatujakiona kwenye akaunti yako.'],
  new_device_large: ['A large payment from a new device.', 'Malipo makubwa kutoka kifaa kipya.'],
  odd_hour: ['This payment is at an unusual hour for you.', 'Malipo haya ni saa isiyo ya kawaida kwako.'],
  new_account: ['Your account is very new.', 'Akaunti yako ni mpya sana.'],
  drains_balance: ['This would use almost all of your balance.', 'Hii itatumia karibu salio lako lote.'],
  scam_wording: ['The request wording looks like a common scam pattern (urgency, "wrong number", refunds, prizes).', 'Maneno ya ombi yanafanana na ulaghai unaojulikana (haraka, "nimetuma kimakosa", marejesho, zawadi).'],
  amount_mismatch: ['The amount is different from what was expected.', 'Kiasi ni tofauti na kilichotarajiwa.']
};

const SCAM_RE = /\b(?:urgent|urgently|asap|immediately|wrong number|sent (?:to you )?by mistake|send (?:it )?back|reversal|refund me|you (?:have )?won|prize|winner|claim|lottery|nimetuma kimakosa|nirudishie|rudisha pesa|umeshinda|zawadi|haraka sana|tuma haraka|activation fee|processing fee|verification fee)\b/i;

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const LARGE_FLOOR = Number(process.env.NECPRA_RISK_LARGE_FLOOR || 5000);   // KES: below this a first-time recipient alone is not interesting
const T_MEDIUM = Number(process.env.NECPRA_RISK_WARN_AT || 30), T_HIGH = Number(process.env.NECPRA_RISK_REVIEW_AT || 60);

/**
 * Pure scoring. No I/O.
 * @param {{kind:string, amount:number, counterparty?:string, purpose?:string, expectedAmount?:number, deviceHash?:string, at?:Date, balance?:number}} ev
 * @param {{amounts?:number[], knownCounterparties?:string[], knownDevices?:string[], recent?:Array<{at:Date|number,amount:number,counterparty?:string}>, accountAgeHours?:number|null}} hist
 */
function assess(ev, hist = {}) {
  const now = ev.at ? new Date(ev.at) : new Date();
  const amount = Number(ev.amount) || 0;
  const amounts = (hist.amounts || []).filter((x) => Number.isFinite(x) && x > 0);
  const known = new Set(hist.knownCounterparties || []);
  const devices = new Set(hist.knownDevices || []);
  const recent = (hist.recent || []).map((r) => ({ t: new Date(r.at).getTime(), amount: Number(r.amount) || 0, cp: r.counterparty || null }));
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, weight: WEIGHTS[code], message: { en: MESSAGES[code][0], sw: MESSAGES[code][1] }, detail: detail || undefined });

  const med = median(amounts);
  if (amounts.length >= 5 && med > 0) {
    if (amount >= med * 10 && amount >= LARGE_FLOOR) add('amount_extreme', { typical: Math.round(med) });
    else if (amount >= med * 3 && amount >= LARGE_FLOOR) add('amount_outlier', { typical: Math.round(med) });
  }
  if (ev.counterparty && amounts.length >= 3 && !known.has(ev.counterparty) && amount >= LARGE_FLOOR) add('first_recipient_large');

  const win = (ms) => recent.filter((r) => now.getTime() - r.t >= 0 && now.getTime() - r.t <= ms);
  const last10 = win(10 * 60000);
  if (last10.length >= 5) add('velocity_high', { count: last10.length });
  else if (last10.length >= 3) add('velocity_medium', { count: last10.length });
  if (ev.counterparty && win(10 * 60000).some((r) => r.cp === ev.counterparty && Math.abs(r.amount - amount) < 0.01)) add('possible_duplicate');
  if (win(15 * 60000).length >= 3 && !reasons.some((r) => r.code.startsWith('velocity') )) add('repeated_attempts');

  if (ev.deviceHash && devices.size > 0 && !devices.has(ev.deviceHash)) {
    add('new_device');
    if (med > 0 && amount >= med * 3 && amount >= LARGE_FLOOR) add('new_device_large');
  }
  const nairobiHour = (now.getUTCHours() + 3) % 24;
  if (nairobiHour >= 1 && nairobiHour <= 4 && med > 0 && amount > med) add('odd_hour');
  if (hist.accountAgeHours != null && hist.accountAgeHours < 24 && amount >= 2000) add('new_account');
  if (Number(ev.balance) >= 1000 && amount >= 0.9 * Number(ev.balance)) add('drains_balance');
  if (ev.purpose && SCAM_RE.test(String(ev.purpose))) add('scam_wording');
  if (ev.expectedAmount != null && Math.abs(Number(ev.expectedAmount) - amount) > 0.5) add('amount_mismatch', { expected: Number(ev.expectedAmount) });

  const score = Math.min(100, reasons.reduce((s, r) => s + r.weight, 0));
  const level = score >= T_HIGH ? 'high' : score >= T_MEDIUM ? 'medium' : 'low';
  return { score, level, action: level === 'high' ? 'review' : level === 'medium' ? 'warn' : 'allow', reasons, notProof: true,
    note: 'A risk score is a hint to double-check, not proof that anything is wrong.' };
}

const sha = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32) : null);

/** DB-facing service. Reads only the caller's own history; writes only to ai_risk_events. Never touches money tables. */
function createService(opts = {}) {
  const sq = opts.getSequelize || (() => require('../../models').sequelize);
  const q = (sql, replacements) => sq().query(sql, { replacements, type: 'SELECT' });
  const exec = (sql, replacements) => sq().query(sql, { replacements });

  async function buildHistory(userId, ev) {
    const uid = Number(userId);
    const [debits, events, acct] = await Promise.all([
      q(`SELECT "amount", "createdAt" AS at, "metadata"->>'counterparty_id' AS cp FROM "wallet_transactions"
         WHERE "user_id" = :uid AND "type" = 'debit' AND "createdAt" > NOW() - INTERVAL '90 days' ORDER BY "createdAt" DESC LIMIT 200`, { uid }).catch(() => []),
      q(`SELECT "counterparty" AS cp, "amount", "created_at" AS at, "device_hash", "status" FROM ai_risk_events
         WHERE "user_id" = :uid AND "created_at" > NOW() - INTERVAL '90 days' ORDER BY "created_at" DESC LIMIT 300`, { uid }).catch(() => []),
      q(`SELECT EXTRACT(EPOCH FROM (NOW() - "createdAt"))/3600 AS hours FROM "Users" WHERE "id" = :uid LIMIT 1`, { uid }).catch(() => [])
    ]);
    const trusted = events.filter((e) => e.status === 'user_confirmed_ok');
    return {
      amounts: debits.map((d) => Number(d.amount)),
      knownCounterparties: Array.from(new Set(debits.map((d) => d.cp).filter(Boolean).map((c) => 'u:' + c).concat(trusted.map((e) => e.cp).filter(Boolean)))),
      knownDevices: Array.from(new Set(events.filter((e) => e.status !== 'user_reported').map((e) => e.device_hash).filter(Boolean))),
      recent: events.map((e) => ({ at: e.at, amount: Number(e.amount), counterparty: e.cp })),
      accountAgeHours: acct[0] && acct[0].hours != null ? Number(acct[0].hours) : null
    };
  }

  /** Score + record. Never throws into a payment flow: on any failure it returns a neutral "allow" result with `unavailable: true`. */
  async function assessAndRecord(ev, ctx = {}) {
    try {
      const norm = Object.assign({}, ev, { counterparty: ev.counterparty ? String(ev.counterparty).slice(0, 64) : null, deviceHash: ev.deviceHash || null });
      const hist = await buildHistory(ev.userId, norm);
      const result = assess(norm, hist);
      const id = crypto.randomUUID();
      await exec(`INSERT INTO ai_risk_events (id, user_id, kind, amount, counterparty, score, level, action, reasons, device_hash, ip_hash, mode, created_at)
                  VALUES (:id, :uid, :kind, :amount, :cp, :score, :level, :action, CAST(:reasons AS jsonb), :dev, :ip, :mode, NOW())`,
        { id, uid: Number(ev.userId), kind: String(ev.kind || 'payment').slice(0, 24), amount: Number(ev.amount) || 0, cp: norm.counterparty, score: result.score, level: result.level,
          action: result.action, reasons: JSON.stringify(result.reasons.map((r) => ({ code: r.code, weight: r.weight, detail: r.detail }))), dev: norm.deviceHash, ip: ctx.ipHash || null, mode: ctx.mode || 'observe' });
      return Object.assign({ eventId: id }, result);
    } catch (e) {
      return { eventId: null, score: 0, level: 'low', action: 'allow', reasons: [], notProof: true, unavailable: true, error: String(e && e.message || e).slice(0, 120) };
    }
  }

  /** The user says what really happened. Only the owner of the event can resolve it. */
  async function resolve(userId, eventId, outcome, note) {
    const status = outcome === 'ok' ? 'user_confirmed_ok' : outcome === 'report' ? 'user_reported' : null;
    if (!status) return { ok: false, status: 400, error: 'bad_outcome' };
    const [rows] = await sq().query(`UPDATE ai_risk_events SET status = :status, resolved_at = NOW(), resolved_note = :note WHERE id = :id AND user_id = :uid RETURNING id, status`,
      { replacements: { status, note: note ? String(note).slice(0, 200) : null, id: String(eventId), uid: Number(userId) } });
    return rows && rows[0] ? { ok: true, event: rows[0] } : { ok: false, status: 404, error: 'not_found' };
  }

  async function listForUser(userId, limit = 20) {
    return q(`SELECT id, kind, amount, score, level, action, reasons, status, created_at FROM ai_risk_events WHERE user_id = :uid ORDER BY created_at DESC LIMIT :lim`, { uid: Number(userId), lim: Math.min(100, Math.max(1, Number(limit) || 20)) });
  }
  return { buildHistory, assessAndRecord, resolve, listForUser };
}

module.exports = { assess, createService, WEIGHTS, MESSAGES, sha, SCAM_RE, T_MEDIUM, T_HIGH };
