// src/jobs/gameDailyReminder.js
// Sends a "Your daily reward is waiting!" push notification once per day to
// users who have a saved game progress record but haven't claimed today's
// daily reward yet (lastClaim is not today).
//
// Requires the optional 'web-push' package:
//   npm install web-push
// and VAPID keys configured via env vars:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL)
//
// Wire this up in app.js / server entrypoint with:
//   require('./jobs/gameDailyReminder').start();

const cron = require('node-cron');

let webpush = null;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('[gameDailyReminder] "web-push" package not installed — daily reminders disabled. Run: npm install web-push');
}

function configureWebPush() {
  if (!webpush) return false;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[gameDailyReminder] VAPID keys not configured — daily reminders disabled.');
    return false;
  }
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:support@nexopa.app',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  return true;
}

async function sendDailyReminders() {
  let db, GameProgress, PushSubscription;
  try {
    db = require('../models');
    GameProgress     = db.models?.GameProgress     || db.GameProgress;
    PushSubscription = db.models?.PushSubscription || db.PushSubscription;
  } catch (e) {
    console.error('[gameDailyReminder] model load error:', e.message);
    return;
  }
  if (!GameProgress || !PushSubscription) return;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Find users who haven't claimed today
  const { Op } = db.Sequelize || require('sequelize');
  const pending = await GameProgress.findAll({
    where: {
      [Op.or]: [
        { lastClaim: null },
        { lastClaim: { [Op.lt]: todayStart } },
      ],
    },
    attributes: ['userId', 'streak'],
  });

  if (!pending.length) {
    console.log('[gameDailyReminder] No users pending a reminder.');
    return;
  }

  const userIds = pending.map(p => p.userId);
  const streakByUser = Object.fromEntries(pending.map(p => [p.userId, p.streak || 0]));

  const subs = await PushSubscription.findAll({
    where: {
      userId: { [Op.in]: userIds },
      gameRemindersEnabled: true,
      [Op.or]: [
        { lastDailyReminderSentAt: null },
        { lastDailyReminderSentAt: { [Op.lt]: todayStart } },
      ],
    },
  });

  console.log(`[gameDailyReminder] Sending ${subs.length} daily reward reminders…`);

  for (const sub of subs) {
    const streak = streakByUser[sub.userId] || 0;
    const payload = JSON.stringify({
      type: 'daily_reward',
      title: '🎁 Your Daily Reward is waiting!',
      body: streak > 0
        ? `Don't break your ${streak}-day streak! Claim today's reward in the games hub.`
        : `Open the games hub to claim your daily login reward.`,
      icon: '/icons/nexopa-192.png',
      url: '/game.html',
    });

    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      await sub.update({ lastDailyReminderSentAt: new Date() });
    } catch (err) {
      // 410 Gone / 404 — subscription expired, remove it
      if (err.statusCode === 410 || err.statusCode === 404) {
        await sub.destroy().catch(() => {});
      } else {
        console.warn('[gameDailyReminder] push send error:', err.message);
      }
    }
  }
}

function start() {
  const ready = configureWebPush();
  if (!ready) return;

  // Run once daily at 18:00 server time (evening reminder)
  cron.schedule('0 18 * * *', () => {
    sendDailyReminders().catch(err => console.error('[gameDailyReminder] job error:', err.message));
  });

  console.log('[gameDailyReminder] Scheduled daily reward reminders at 18:00.');
}

module.exports = { start, sendDailyReminders };