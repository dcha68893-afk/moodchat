'use strict';
/**
 * moneyReminderWorker.js - Money Circle (chama) payment schedule + reminders.
 *
 * Schedule lives in MoneyCircle.settings.schedule (no schema change):
 *   { dueDate:'YYYY-MM-DD', amountPerMember:Number, remindersEnabled:Boolean, startedAt:ISO }
 *
 * Rules (all times Africa/Nairobi):
 *  - 3 days and 1 day before the due date: one morning reminder to members who have not paid.
 *  - On the due date and every day after (overdue): up to 3 prompts a day - 08:00, 13:00, 18:00.
 *    Each slot only goes to members who still have not paid, so a member who pays in the morning
 *    gets no afternoon/evening prompt, and one who pays at lunch gets no evening prompt.
 *  - "Paid" is derived from confirmed (status=paid) MoneyContribution rows created since
 *    schedule.startedAt, never typed in by anyone. paid >= amountPerMember (or > 0 if no amount set).
 *
 * The backend runs several cluster workers that each start this cron. A transaction-level Postgres
 * advisory lock plus a per-circle "last slot sent" key stored in the circle settings guarantee each
 * slot is sent exactly once per circle no matter how many workers fire.
 */
const cron = require('node-cron');
const TZ = 'Africa/Nairobi';
let _started = false;

function nairobiParts(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(now); // YYYY-MM-DD
}
function dayDiff(dueDate, todayStr) {
  const a = Date.parse(dueDate + 'T00:00:00Z'), b = Date.parse(todayStr + 'T00:00:00Z');
  return Math.round((a - b) / 86400000); // >0 days left, 0 today, <0 overdue
}
const fmt = n => 'KSh ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });

/** Map userId -> amount confirmed-paid in the current cycle. */
async function paidByMember(d, circle) {
  const sched = (circle.settings && circle.settings.schedule) || {};
  const since = sched.startedAt ? new Date(sched.startedAt) : new Date(0);
  const rows = await d.MoneyContribution.findAll({ where: { circleId: circle.id, status: 'paid' }, attributes: ['contributorId', 'amount', 'createdAt'] });
  const m = new Map();
  rows.forEach(r => { if (new Date(r.createdAt) >= since) m.set(Number(r.contributorId), (m.get(Number(r.contributorId)) || 0) + Number(r.amount || 0)); });
  return m;
}
function hasPaid(sched, paidAmount) {
  const need = Number(sched.amountPerMember || 0);
  return need > 0 ? paidAmount >= need : paidAmount > 0;
}
/** Active members (not the ones who already paid) for a circle with a schedule. */
async function unpaidMembers(d, circle) {
  const sched = (circle.settings && circle.settings.schedule) || {};
  const [members, paid] = await Promise.all([
    d.MoneyCircleMember.findAll({ where: { circleId: circle.id, status: 'active' }, attributes: ['userId', 'role'] }),
    paidByMember(d, circle)
  ]);
  return members.filter(m => !hasPaid(sched, paid.get(Number(m.userId)) || 0)).map(m => Number(m.userId));
}

async function notify(userId, circle, title, body, kind) {
  const svc = require('./notificationService');
  return svc.createNotification(userId, {
    type: 'system', title: String(title).slice(0, 200), body,
    data: { kind: 'money_circle_' + kind, circleId: circle.id, module: 'money' },
    actionUrl: '/money.html', priority: 'high'
  });
}
function dueText(sched, diff) {
  const amt = Number(sched.amountPerMember || 0) > 0 ? fmt(sched.amountPerMember) : 'your contribution';
  if (diff > 0) return { title: 'Contribution due in ' + diff + (diff === 1 ? ' day' : ' days'), body: 'Please pay ' + amt + ' to "' + '%NAME%' + '" by ' + sched.dueDate + '.' };
  if (diff === 0) return { title: 'Contribution due today', body: 'Please pay ' + amt + ' to "%NAME%" today.' };
  const n = Math.abs(diff);
  return { title: 'Contribution overdue', body: amt.charAt(0).toUpperCase() + amt.slice(1) + ' for "%NAME%" is ' + n + (n === 1 ? ' day' : ' days') + ' overdue. Please pay now.' };
}

async function tick(slotIdx) {
  const d = require('../models');
  if (!d.MoneyCircle || !d.MoneyCircleMember || !d.MoneyContribution) return;
  const today = nairobiParts();
  const key = today + '-' + slotIdx;
  const circles = await d.MoneyCircle.findAll({ where: { status: 'active' } });
  for (const c0 of circles) {
    const s0 = c0.settings && c0.settings.schedule;
    if (!s0 || !s0.dueDate || s0.remindersEnabled === false) continue;
    const diff = dayDiff(s0.dueDate, today);
    const send = diff <= 0 || (slotIdx === 0 && (diff === 1 || diff === 3));
    if (!send) continue;
    try {
      await d.sequelize.transaction(async t => {
        const [[lock]] = await d.sequelize.query('SELECT pg_try_advisory_xact_lock(:k) AS ok', { replacements: { k: 7700000000 + (Number(String(c0.id).replace(/\D/g, '').slice(0, 8)) || 0) }, transaction: t });
        if (!lock || !lock.ok) return;
        const c = await d.MoneyCircle.findByPk(c0.id, { transaction: t });
        const log = (c.settings && c.settings.reminderLog) || {};
        if (log.lastKey === key) return;
        const sched = c.settings.schedule;
        const ids = await unpaidMembers(d, c);
        const txt = dueText(sched, dayDiff(sched.dueDate, today));
        for (const uid of ids) { try { await notify(uid, c, txt.title, txt.body.replace('%NAME%', c.name), 'due'); } catch (e) { console.warn('[moneyReminder] notify failed', e.message); } }
        c.settings = { ...(c.settings || {}), reminderLog: { lastKey: key, sentAt: new Date().toISOString(), count: ids.length } };
        c.changed('settings', true);
        await c.save({ transaction: t });
      });
    } catch (e) { console.warn('[moneyReminder] circle ' + c0.id + ' failed:', e.message); }
  }
}

function start() {
  if (_started) return; _started = true;
  // 08:00, 13:00, 18:00 Nairobi time
  [[8, 0], [13, 1], [18, 2]].forEach(([h, i]) => cron.schedule('0 ' + h + ' * * *', () => tick(i).catch(e => console.warn('[moneyReminder] tick failed', e.message)), { timezone: TZ }));
  console.log('[moneyReminder] started (08:00 / 13:00 / 18:00 ' + TZ + ')');
}

module.exports = { start, tick, paidByMember, hasPaid, unpaidMembers, notify, dueText, dayDiff, nairobiParts };
