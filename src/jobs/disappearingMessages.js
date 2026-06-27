// src/jobs/disappearingMessages.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX: Disappearing messages auto-delete worker
//
// The ScheduledMessage model and `disappearsAt` field on Message already exist.
// This cron runs every minute, finds all messages whose `disappearsAt` is in
// the past, deletes them from the DB, and notifies participants via WebSocket
// so the message vanishes in real-time from every open chat window.
//
// Wire up in src/server.js:
//   require('./jobs/disappearingMessages').start();
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cron = require('node-cron');
const { Op } = require('sequelize');

let _started = false;

async function deleteExpiredMessages() {
  let Message, sequelize, wsService;
  try {
    Message    = require('../models/Message');
    sequelize  = require('../config/database');
    wsService  = require('../services/webSocketService');
  } catch (e) {
    // Dependencies not ready yet — skip this tick
    return;
  }

  try {
    // Find all messages that have passed their disappear deadline
    const expired = await Message.findAll({
      where: {
        disappearsAt: { [Op.lte]: new Date() },
        deletedAt: null,          // not already soft-deleted
      },
      attributes: ['id', 'chatId', 'conversationId', 'senderId'],
      limit: 200,                  // process in batches to avoid table locks
      raw: true,
    });

    if (!expired.length) return;

    const ids    = expired.map(m => m.id);
    const chatIds = [...new Set(expired.map(m => m.chatId || m.conversationId).filter(Boolean))];

    // Hard-delete the expired messages
    await Message.destroy({ where: { id: { [Op.in]: ids } } });

    console.log(`[disappearingMessages] Deleted ${ids.length} expired messages from ${chatIds.length} chats`);

    // Notify every chat that had messages deleted, so clients can remove
    // the bubbles in real time without a reload.
    for (const chatId of chatIds) {
      const chatMessages = expired.filter(m => (m.chatId || m.conversationId) === chatId);
      const payload = {
        chatId,
        deletedIds: chatMessages.map(m => m.id),
        reason: 'disappearing',
        timestamp: new Date().toISOString(),
      };
      try {
        // Get participants for this chat
        const participants = await sequelize.query(
          `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId`,
          { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
        );
        await Promise.allSettled(
          (participants || []).map(row =>
            wsService.sendToUser(row.userId, 'messages:deleted', payload)
          )
        );
      } catch (_notifyErr) {
        // Non-fatal — the messages are already deleted from DB
        console.warn(`[disappearingMessages] WS notify failed for chat ${chatId}:`, _notifyErr.message);
      }
    }
  } catch (err) {
    console.error('[disappearingMessages] Cron error:', err.message);
  }
}

function start() {
  if (_started) return;
  _started = true;

  // Run every minute — disappearing messages have second-level granularity
  // but a 60-second window is fine for 24h/7d/90d timers.
  cron.schedule('* * * * *', deleteExpiredMessages, { timezone: 'UTC' });
  console.log('[disappearingMessages] ✅ Auto-delete cron started (every minute)');
}

module.exports = { start, deleteExpiredMessages };
