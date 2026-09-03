/**
 * scheduledMessageWorker.js
 *
 * NOTE (messaging module deletion): this worker used to do two unrelated
 * jobs — (1) deliver due rows from the scheduled_messages table, which was
 * a DM-only feature whose only creator was the now-deleted
 * routes/messagingFeatures.js, and (2) clean up expired ("disappearing")
 * messages from the shared Messages table. Job (1) has been removed since
 * nothing can create a scheduled_messages row anymore. Job (2) is kept —
 * disappearing messages are set via expiresAt on the generic Messages
 * table and are used by the Group module too (see routes/group.js), not
 * just direct messages.
 *
 * Runs every 5 minutes, cleaning up any Messages rows with:
 *   expiresAt IS NOT NULL AND expiresAt <= NOW() AND isDeleted = false
 *
 * Started automatically by server.js on boot.
 */

'use strict';

let _timer = null;

// Expired message cleanup — runs every 5 minutes
async function cleanExpiredMessages() {
  let sequelize;
  try {
    const db = require('../models/index');
    sequelize = db.sequelize;
  } catch (e) { return; }

  let wsService;
  try { wsService = require('./webSocketService'); } catch (_) {}

  try {
    // Fetch messages about to be deleted so we can notify clients
    const expired = await sequelize.query(
      `SELECT id, "chatId" FROM "Messages"
       WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= NOW() AND "isDeleted"=false
       LIMIT 100`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (!expired || expired.length === 0) return;
    console.log(`[ScheduledWorker] Cleaning ${expired.length} expired (disappearing) messages`);

    for (const msg of expired) {
      await sequelize.query(
        `UPDATE "Messages" SET "isDeleted"=true, "deletedAt"=NOW(), "content"='This message has disappeared', "updatedAt"=NOW()
         WHERE id=:id`,
        { replacements: { id: msg.id } }
      );

      if (wsService) {
        try {
          const participants = await sequelize.query(
            `SELECT "userId" FROM chat_participants WHERE "chatId"=:chatId`,
            { replacements: { chatId: msg.chatId }, type: sequelize.QueryTypes.SELECT }
          );
          await Promise.allSettled(
            participants.map(p => wsService.sendToUser(p.userId, 'message:expired', { messageId: msg.id, chatId: msg.chatId }))
          );
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (err) {
    console.error('[ScheduledWorker] Expiry cleanup error:', err.message);
  }
}

function start() {
  if (_timer) return; // already running

  console.log('[ScheduledWorker] Starting — polls every 5 minutes for expired (disappearing) messages');

  // Run immediately on start
  cleanExpiredMessages();

  // Every 5 minutes for expired disappearing messages
  _timer = setInterval(cleanExpiredMessages, 5 * 60 * 1000);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[ScheduledWorker] Stopped');
  }
}

module.exports = { start, stop, cleanExpiredMessages };
