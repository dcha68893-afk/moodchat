'use strict';
/**
 * passwordHistoryService.js
 * P3 FIX (Forensic Audit): "Implement password history (last 5) — reject if
 * newPassword matches any of the last 5 used passwords."
 *
 * Fails open: if the password_history table/model isn't available (e.g.
 * migration not yet run), checks/recording are skipped with a warning rather
 * than blocking password changes.
 */
const { comparePassword } = require('../utils/passwordUtils');

const HISTORY_LIMIT = 5;

function _getModel() {
  try {
    const db = require('../models');
    return db.PasswordHistory;
  } catch (_) {
    return null;
  }
}

/**
 * Returns true if newPassword matches any of the user's last HISTORY_LIMIT
 * password hashes.
 */
async function isPasswordReused(userId, newPassword) {
  const PasswordHistory = _getModel();
  if (!PasswordHistory) return false;

  try {
    const recent = await PasswordHistory.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit: HISTORY_LIMIT,
    });

    for (const entry of recent) {
      if (await comparePassword(newPassword, entry.passwordHash)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[PasswordHistory] Check failed (failing open):', err.message);
    return false;
  }
}

/**
 * Record a new password hash in history and prune anything beyond
 * HISTORY_LIMIT for this user.
 */
async function recordPasswordHash(userId, passwordHash) {
  const PasswordHistory = _getModel();
  if (!PasswordHistory) return;

  try {
    await PasswordHistory.create({ userId, passwordHash });

    const all = await PasswordHistory.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
    });

    if (all.length > HISTORY_LIMIT) {
      const toRemove = all.slice(HISTORY_LIMIT);
      await PasswordHistory.destroy({ where: { id: toRemove.map(r => r.id) } });
    }
  } catch (err) {
    console.warn('[PasswordHistory] Failed to record password hash:', err.message);
  }
}

module.exports = { isPasswordReused, recordPasswordHash, HISTORY_LIMIT };
