/**
 * disappearingMessages.js — Auto-delete expired messages cron job
 *
 * Phase 3 feature: Disappearing messages auto-delete worker
 *
 * Runs every 60 seconds, deletes Messages WHERE "expiresAt" < NOW().
 * Also notifies affected users via Socket.IO so their chat UI removes
 * the messages in real-time without a page refresh.
 *
 * The Message model already has:
 *   - expiresAt  (DATE) — set at send time based on chat's disappearingTimer
 *   - disappearingTimer (INTEGER seconds)
 *
 * This job completes the loop: the model has the field, the cron was missing.
 *
 * Usage: require('./jobs/disappearingMessages').start()
 *        called from server.js after DB is ready (same pattern as keepAlive)
 */

'use strict';

const cron = require('node-cron');

let task = null;

/**
 * Delete all expired messages and notify participants.
 */
async function runCleanup() {
  let sequelize, wsService;

  try {
    // Lazy-load to avoid circular deps at startup
    const { getSequelize } = require('../config/database');
    sequelize = getSequelize();
  } catch (e) {
    console.warn('[DisappearingMessages] DB not ready:', e.message);
    return;
  }

  // Get all expired messages + their chatIds + participant lists
  let expired;
  try {
    expired = await sequelize.query(
      `SELECT m.id, m."chatId", m."senderId"
       FROM "Messages" m
       WHERE m."expiresAt" IS NOT NULL
         AND m."expiresAt" <= NOW()
         AND m."deletedAt" IS NULL
       LIMIT 500`,
      { type: sequelize.QueryTypes.SELECT }
    );
  } catch (e) {
    console.error('[DisappearingMessages] Query error:', e.message);
    return;
  }

  if (!expired.length) return;

  const msgIds = expired.map(m => m.id);

  // Group by chatId for efficient participant lookup + socket emit
  const byChatId = {};
  for (const m of expired) {
    if (!byChatId[m.chatId]) byChatId[m.chatId] = [];
    byChatId[m.chatId].push(m.id);
  }

  // Soft-delete the messages (sets deletedAt, preserves audit trail)
  try {
    await sequelize.query(
      `UPDATE "Messages"
       SET "deletedAt" = NOW(),
           content = '[This message has disappeared]',
           "updatedAt" = NOW()
       WHERE id = ANY(:ids)`,
      { replacements: { ids: msgIds } }
    );
    console.log(`[DisappearingMessages] ✅ Deleted ${msgIds.length} expired messages`);
  } catch (e) {
    console.error('[DisappearingMessages] Delete error:', e.message);
    return;
  }

  // Notify participants via Socket.IO
  try {
    // Try to get wsService from app.locals or global
    wsService = global.__wsService ||
                global._wsService  ||
                require('../app/index')?.wsService;
  } catch (_) {}

  if (!wsService?.sendToUser) {
    // Try direct Socket.IO io reference
    try {
      const io = global.__io || global.io;
      if (io) {
        wsService = {
          sendToUser: (userId, event, data) => {
            io.to(`user:${userId}`).emit(event, data);
          }
        };
      }
    } catch (_) {}
  }

  if (!wsService?.sendToUser) {
    console.log('[DisappearingMessages] No wsService — clients will see deletions on next poll');
    return;
  }

  for (const [chatId, ids] of Object.entries(byChatId)) {
    let participants;
    try {
      participants = await sequelize.query(
        `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
        { replacements: { chatId: parseInt(chatId) }, type: sequelize.QueryTypes.SELECT }
      );
    } catch (_) { continue; }

    for (const p of participants) {
      try {
        await wsService.sendToUser(p.userId, 'messages:disappeared', {
          chatId: parseInt(chatId),
          messageIds: ids,
        });
      } catch (_) {}
    }
  }
}

/**
 * Wire the expiresAt on message INSERT.
 * Called from messages.js route when a chat has disappearingTimer set.
 *
 * @param {object} sequelize
 * @param {number} chatId
 * @param {number|null} disappearingTimerSeconds  — 0 or null = disabled
 * @returns {Date|null}
 */
async function computeExpiresAt(sequelize, chatId, disappearingTimerSeconds) {
  // If timer passed directly, use it
  if (disappearingTimerSeconds && disappearingTimerSeconds > 0) {
    return new Date(Date.now() + disappearingTimerSeconds * 1000);
  }

  // Otherwise, look up the chat's setting
  if (!chatId) return null;

  try {
    const [chat] = await sequelize.query(
      `SELECT "disappearingTimer" FROM "Chats" WHERE id = :chatId LIMIT 1`,
      { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
    );
    const timer = chat?.disappearingTimer;
    if (timer && timer > 0) {
      return new Date(Date.now() + timer * 1000);
    }
  } catch (_) {}

  return null;
}

function start() {
  if (task) {
    console.log('[DisappearingMessages] Already running');
    return task;
  }

  // Run immediately on start to clear any backlog from downtime
  runCleanup().catch(e => console.warn('[DisappearingMessages] Initial cleanup error:', e.message));

  // Then every 60 seconds
  task = cron.schedule('* * * * *', () => {
    runCleanup().catch(e => console.error('[DisappearingMessages] Cleanup error:', e.message));
  }, { scheduled: true });

  console.log('[DisappearingMessages] ✅ Started — checking for expired messages every 60s');
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    console.log('[DisappearingMessages] Stopped');
  }
}

module.exports = { start, stop, runCleanup, computeExpiresAt };
