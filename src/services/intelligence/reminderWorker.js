'use strict';
/**
 * NECPRA Personal Assistant: reminder delivery. Once a minute, due reminders get ONE push notification each.
 *  - Each reminder is pushed at most once: the row is locked (FOR UPDATE SKIP LOCKED) and stamped notified_at in the same transaction,
 *    so several cluster workers (or two ticks overlapping) can never send it twice.
 *  - A reminder more than 24h late (server was down) is not pushed (an old alarm is noise); it is stamped and still shows in GET /reminders/due.
 *  - If the person has no push subscription, or push fails, nothing is lost: the reminder stays 'pending' and is returned by GET /reminders/due.
 *  - The push carries only the reminder text the person chose (short) and its id. Delivery counts are recorded honestly in push_count.
 * Dependencies are injectable so tests can run it against a real database without real push.
 */
const TZ = 'Africa/Nairobi';
const MAX_BATCH = 100, STALE_MS = 24 * 3600000;
let _started = false;

function createWorker(opts = {}) {
  const sq = opts.getSequelize || (() => require('../../models').sequelize);
  const push = opts.push || (() => require('../pushNotificationService'));
  const now = opts.now || (() => new Date());
  const log = opts.log || ((m) => console.warn('[reminderWorker]', m));

  /** Returns { due, pushed, skippedStale, failed }. Safe to call concurrently. */
  async function tick() {
    const sequelize = sq(), t = now(), out = { due: 0, pushed: 0, skippedStale: 0, failed: 0 };
    await sequelize.transaction({}, async (tx) => {
      const rows = await sequelize.query(
        `SELECT id, user_id, text, due_at FROM ai_reminders WHERE status = 'pending' AND notified_at IS NULL AND due_at <= :now
          ORDER BY due_at ASC LIMIT ${MAX_BATCH} FOR UPDATE SKIP LOCKED`, { replacements: { now: t.toISOString() }, type: 'SELECT', transaction: tx });
      out.due = rows.length;
      for (const r of rows) {
        let delivered = 0;
        if (t.getTime() - new Date(r.due_at).getTime() > STALE_MS) out.skippedStale++;
        else {
          try {
            const svc = typeof push === 'function' ? push() : push;
            delivered = Number(await svc.sendToUser(r.user_id, 'reminder', { reminderId: r.id, text: r.text, dueAt: new Date(r.due_at).toISOString() }, sequelize)) || 0;
            if (delivered > 0) out.pushed++;
          } catch (e) { out.failed++; log('push failed for one reminder: ' + (e && e.message)); }
        }
        await sequelize.query(`UPDATE ai_reminders SET notified_at = :now, push_count = :n WHERE id = :id`, { replacements: { now: t.toISOString(), n: Math.min(delivered, 32000), id: r.id }, type: 'UPDATE', transaction: tx });
      }
    });
    return out;
  }
  return { tick };
}

function start() {
  if (_started) return; _started = true;
  const cron = require('node-cron'), w = createWorker();
  cron.schedule('* * * * *', () => w.tick().catch((e) => console.warn('[reminderWorker] tick failed', e && e.message)), { timezone: TZ });
}

module.exports = { createWorker, start };
