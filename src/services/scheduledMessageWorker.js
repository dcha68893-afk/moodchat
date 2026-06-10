/**
 * scheduledMessageWorker.js
 *
 * Runs every 60 seconds. Picks up any scheduled_messages with:
 *   status = 'pending' AND sendAt <= NOW()
 *
 * For each due message:
 *  1. Inserts into Messages table
 *  2. Emits message:new via WebSocket to chat participants
 *  3. Updates chat.lastMessageId / lastMessageAt
 *  4. Marks the scheduled_message row as 'sent'
 *
 * On failure: increments retryCount. After 3 retries → marks as 'failed'.
 *
 * Started automatically by server.js on boot.
 */

'use strict';

const MAX_RETRIES = 3;
const POLL_MS     = 60 * 1000; // 1 minute

let _timer = null;

async function processDueMessages() {
  let sequelize;
  try {
    const db = require('../models/index');
    sequelize = db.sequelize;
  } catch (e) {
    console.error('[ScheduledWorker] Cannot load DB:', e.message);
    return;
  }

  let wsService;
  try {
    wsService = require('./webSocketService');
  } catch (_) {}

  try {
    // Fetch due messages
    const due = await sequelize.query(
      `SELECT id, "userId", "chatId", content, type, "mediaUrl", metadata, "retryCount"
       FROM scheduled_messages
       WHERE status = 'pending' AND "sendAt" <= NOW()
       ORDER BY "sendAt" ASC LIMIT 20`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (!due || due.length === 0) return;
    console.log(`[ScheduledWorker] Processing ${due.length} due scheduled messages`);

    for (const sm of due) {
      try {
        // Insert the actual message
        const [result] = await sequelize.query(
          `INSERT INTO "Messages"
             ("chatId","senderId","content","type","reactions","metadata","sentAt","deliveredAt","createdAt","updatedAt")
           VALUES (:chatId,:userId,:content,:type,'{}', :metadata, NOW(), NOW(), NOW(), NOW())
           RETURNING id, "chatId", "senderId", content, type, "sentAt", "createdAt"`,
          {
            replacements: {
              chatId:   sm.chatId,
              userId:   sm.userId,
              content:  sm.content || '',
              type:     sm.type || 'text',
              metadata: JSON.stringify({ ...(sm.metadata || {}), scheduled: true, scheduledMessageId: sm.id }),
            },
          }
        );

        const newMsg = result[0];

        // Update chat's last message pointer
        await sequelize.query(
          `UPDATE chats SET "updatedAt"=NOW(), "lastMessageId"=:msgId, "lastMessageAt"=NOW() WHERE id=:chatId`,
          { replacements: { msgId: newMsg.id, chatId: sm.chatId } }
        );

        // Notify participants via WebSocket
        if (wsService) {
          const participants = await sequelize.query(
            `SELECT "userId" FROM chat_participants WHERE "chatId"=:chatId AND "userId"!=:senderId`,
            { replacements: { chatId: sm.chatId, senderId: sm.userId }, type: sequelize.QueryTypes.SELECT }
          );
          const payload = { ...newMsg, scheduledMessageId: sm.id };
          await Promise.allSettled([
            wsService.sendToUser(sm.userId, 'message:new', payload), // echo to sender too
            ...participants.map(p => wsService.sendToUser(p.userId, 'message:new', payload)),
          ]);
        }

        // Mark as sent
        await sequelize.query(
          `UPDATE scheduled_messages SET status='sent', "sentAt"=NOW(), "updatedAt"=NOW() WHERE id=:id`,
          { replacements: { id: sm.id } }
        );

        console.log(`[ScheduledWorker] ✅ Sent scheduled message id=${sm.id} → Messages.id=${newMsg.id}`);
      } catch (msgErr) {
        console.error(`[ScheduledWorker] ❌ Failed to send scheduled message id=${sm.id}:`, msgErr.message);

        const newRetry = (sm.retryCount || 0) + 1;
        const newStatus = newRetry >= MAX_RETRIES ? 'failed' : 'pending';
        await sequelize.query(
          `UPDATE scheduled_messages
           SET "retryCount"=:retryCount, status=:status, "failureReason"=:reason, "updatedAt"=NOW()
           WHERE id=:id`,
          { replacements: { retryCount: newRetry, status: newStatus, reason: msgErr.message.slice(0, 499), id: sm.id } }
        );
      }
    }
  } catch (err) {
    console.error('[ScheduledWorker] Unexpected error:', err.message);
  }
}

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

  console.log('[ScheduledWorker] Starting — polls every 60s for scheduled messages + expired messages');

  // Run immediately on start
  processDueMessages();
  cleanExpiredMessages();

  // Then every 60 seconds for scheduled messages
  _timer = setInterval(processDueMessages, POLL_MS);

  // Every 5 minutes for expired disappearing messages
  setInterval(cleanExpiredMessages, 5 * 60 * 1000);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[ScheduledWorker] Stopped');
  }
}

module.exports = { start, stop, processDueMessages, cleanExpiredMessages };
