// src/services/typingIndicatorService.js
//
// FIX (Privacy/Chats architecture audit): this file used to be an exact
// duplicate of src/models/TypingIndicator.js — a Sequelize model-definition
// factory `(sequelize, DataTypes) => {...}`, not a service. Every method
// typingIndicatorController.js called on it (startTyping, stopTyping,
// getActiveTypingIndicators, getTypingStatusForChats, getUserTypingActivity,
// clearExpiredIndicators, bulkUpdateTypingIndicators, getTypingStatistics)
// therefore did not exist — every single call into this file threw
// "typingIndicatorService.X is not a function", on every request to any
// /api/typing-indicators/* route. This is the real service the controller
// was always meant to get, built on top of the real, already-correct
// TypingIndicator model (which is unchanged).
//
// Also added here, since neither existed before: (1) enforcement of
// Settings > Privacy > "Typing Indicators" — the typer's own choice about
// whether others get to see they're typing, not the viewer's; and (2) an
// actual realtime push to the other chat participant(s) over the socket
// layer, since a typing indicator that only lives in a database row with no
// push is useless in practice — the other person would have to poll for it.

const { Op } = require('sequelize');
const db = require('../models');

function getModel()     { return db.TypingIndicator || db.models?.TypingIndicator; }
function getUsers()     { return db.Users || db.models?.Users; }
function getSequelize() { return db.sequelize; }

async function getOtherParticipantIds(chatId, excludeUserId) {
  try {
    const sequelize = getSequelize();
    const rows = await sequelize.query(
      `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :excludeUserId`,
      { replacements: { chatId, excludeUserId }, type: sequelize.QueryTypes.SELECT }
    );
    return rows.map(r => r.userId);
  } catch (_) {
    return [];
  }
}

async function isTypingIndicatorsEnabled(userId) {
  const Users = getUsers();
  if (!Users) return true; // fail open — don't block the feature over a lookup failure
  try {
    const user = await Users.findByPk(userId, { attributes: ['settings'] });
    return user?.settings?.privacy?.typingIndicators !== false;
  } catch (_) {
    return true;
  }
}

async function broadcastTyping(chatId, userId, isTyping) {
  try {
    const webSocketService = require('./webSocketService');
    const otherIds = await getOtherParticipantIds(chatId, userId);
    const payload = { chatId, userId, isTyping, timestamp: new Date().toISOString() };
    await Promise.allSettled(otherIds.map(id => webSocketService.sendToUser(id, 'typing:update', payload)));
  } catch (_) {
    // Realtime push is a convenience on top of the REST state below, never
    // a hard dependency — a push failure must not fail the request.
  }
}

const typingIndicatorService = {
  async startTyping(userId, chatId, messageType = 'text') {
    const Model = getModel();
    if (!Model) throw new Error('TypingIndicator model unavailable');

    // FIX (Privacy #7 continued): see file header. Suppressed on the
    // TYPER's side — no row is created/updated and nothing is broadcast,
    // so the other participant never learns this person is typing.
    if (!(await isTypingIndicatorsEnabled(userId))) {
      return { chatId, userId, isActive: false, suppressed: true };
    }

    // Model.startTyping's own signature is (chatId, userId) — preserved as-is.
    const indicator = await Model.startTyping(chatId, userId);
    if (messageType && messageType !== 'text') {
      try {
        indicator.metadata = Object.assign({}, indicator.metadata, { messageType });
        await indicator.save();
      } catch (_) {}
    }

    await broadcastTyping(chatId, userId, true);
    return indicator.toJSON ? indicator.toJSON() : indicator;
  },

  async stopTyping(userId, chatId) {
    const Model = getModel();
    if (!Model) throw new Error('TypingIndicator model unavailable');

    const indicator = await Model.stopTyping(chatId, userId);
    await broadcastTyping(chatId, userId, false);
    return indicator ? (indicator.toJSON ? indicator.toJSON() : indicator) : { chatId, userId, isActive: false };
  },

  async getActiveTypingIndicators(chatId) {
    const Model = getModel();
    if (!Model) return [];
    const rows = await Model.getActiveTypers(chatId);
    return rows.map(r => r.toJSON ? r.toJSON() : r);
  },

  async getTypingStatusForChats(chatIds) {
    const Model = getModel();
    if (!Model || !chatIds.length) return chatIds.map(id => ({ chatId: id, typingUserIds: [] }));

    const cutoff = new Date(Date.now() - 10000); // matches the model's own 10s staleness window
    const rows = await Model.findAll({
      where: { chatId: { [Op.in]: chatIds }, isActive: true, lastUpdatedAt: { [Op.gte]: cutoff } },
      attributes: ['chatId', 'userId', 'lastUpdatedAt'],
    });

    const byChat = new Map(chatIds.map(id => [id, []]));
    for (const r of rows) {
      if (!byChat.has(r.chatId)) byChat.set(r.chatId, []);
      byChat.get(r.chatId).push(r.userId);
    }
    return chatIds.map(id => ({ chatId: id, typingUserIds: byChat.get(id) || [] }));
  },

  async getUserTypingActivity(userId, { limit = 20, offset = 0 } = {}) {
    const Model = getModel();
    if (!Model) return { records: [], total: 0 };
    const { count, rows } = await Model.findAndCountAll({
      where: { userId },
      order: [['lastUpdatedAt', 'DESC']],
      limit,
      offset,
    });
    return { records: rows.map(r => r.toJSON ? r.toJSON() : r), total: count };
  },

  async clearExpiredIndicators() {
    const Model = getModel();
    if (!Model) return { clearedCount: 0, remainingActive: 0 };
    const cutoff = new Date(Date.now() - 10000);
    const [clearedCount] = await Model.update(
      { isActive: false },
      { where: { isActive: true, lastUpdatedAt: { [Op.lt]: cutoff } } }
    );
    const remainingActive = await Model.count({ where: { isActive: true } });
    return { clearedCount, remainingActive };
  },

  async bulkUpdateTypingIndicators(updates) {
    let succeeded = 0, failed = 0;
    const failures = [];
    for (const update of updates) {
      try {
        if (update.action === 'start') {
          await typingIndicatorService.startTyping(update.userId, update.chatId, update.messageType || 'text');
        } else if (update.action === 'stop') {
          await typingIndicatorService.stopTyping(update.userId, update.chatId);
        } else {
          throw new Error(`Unknown action "${update.action}"`);
        }
        succeeded++;
      } catch (e) {
        failed++;
        failures.push({ userId: update.userId, chatId: update.chatId, error: e.message });
      }
    }
    return { processed: updates.length, succeeded, failed, failures };
  },

  async getTypingStatistics({ startDate, endDate, chatId } = {}) {
    const Model = getModel();
    if (!Model) return { totalIndicatorEvents: 0, currentlyActive: 0 };
    const where = {};
    if (chatId) where.chatId = chatId;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = startDate;
      if (endDate) where.createdAt[Op.lte] = endDate;
    }
    const [totalIndicatorEvents, currentlyActive] = await Promise.all([
      Model.count({ where }),
      Model.count({ where: Object.assign({}, where, { isActive: true }) }),
    ]);
    return { totalIndicatorEvents, currentlyActive };
  },
};

module.exports = typingIndicatorService;
