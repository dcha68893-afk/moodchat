'use strict';
/**
 * src/services/accountDeletionService.js
 *
 * FIX (Play Store compliance audit, items #1 and #20): the app had two
 * separate, independently-written account-deletion implementations —
 * DELETE /api/account (routes/account.js, the more complete one) and
 * DELETE /api/settings/account (routes/settings.js) — with different
 * behavior, and the older one referenced an undefined `models` variable
 * (`const Token = models.Token`), throwing a ReferenceError on every call
 * that its own try/catch swallowed into a generic 500. Since the frontend's
 * actual "Delete Account" button called the BROKEN one, account deletion
 * was completely non-functional. This is the single canonical deletion
 * service both routes now call, per Google Play's requirement that account
 * deletion actually delete associated user data, not just deactivate it.
 *
 * Two-phase deletion, matching the confirmation email's promise (which
 * previously had nothing behind it — no purge job existed anywhere in the
 * repository):
 *   1. requestDeletion() — runs immediately when the person confirms:
 *      anonymises PII, revokes sessions/tokens, marks messages/media for
 *      removal, leaves groups. Recoverable in principle for the retention
 *      window, matching the "30 days" language already in the outgoing
 *      email.
 *   2. purgeExpiredAccounts() — src/jobs/accountPurgeJob.js calls this on a
 *      schedule; hard-deletes everything for accounts whose
 *      deletionRequestedAt is more than 30 days in the past, including
 *      Cloudinary-hosted status media (the one media type this app tracks
 *      a clean, reusable Cloudinary public_id for — see the comment on
 *      purgeExpiredAccounts for what's deliberately out of scope here).
 */

const { comparePassword } = require('../utils/passwordUtils');

const _getDb = () => require('../models');
const _getUsers = () => {
  const db = _getDb();
  return db.User || db.Users || db.sequelize?.models?.Users || db.sequelize?.models?.User;
};

const RETENTION_DAYS = 30;

/**
 * @param {number} userId
 * @param {{ password?: string, req?: object }} opts
 * @returns {Promise<{ success: boolean, status: number, message: string }>}
 */
async function requestDeletion(userId, { password, confirmation, req } = {}) {
  const db = _getDb();
  const Users = _getUsers();
  const user = await Users.findByPk(userId);
  if (!user) {
    return { success: false, status: 404, message: 'User not found' };
  }
  if (user.deletionRequestedAt) {
    return { success: true, status: 200, message: 'Account deletion was already requested — nothing further to do.' };
  }

  // Server-side re-check of the confirmation phrase, when the caller
  // supplied one (both current frontend call sites do) — the old, broken
  // /api/settings/account route had this; the newer /api/account route
  // never did. Optional so a caller with no phrase-confirmation UI (e.g. a
  // future admin tool) isn't forced to fabricate one.
  if (confirmation !== undefined && confirmation.trim().toLowerCase() !== 'delete my account') {
    return { success: false, status: 400, message: 'Confirmation text is required and must match "delete my account"' };
  }

  // FIX (Play Store audit #1): only require/verify a password for accounts
  // that actually have one they chose themselves (see the hasLocalPassword
  // column and its matching Change Password fix) — a Google-only account's
  // stored password is a random value it never saw, so it could never
  // supply one, which made deletion impossible for every Google sign-up.
  // The caller is already authenticated (a valid access token is required
  // to reach this at all), which is treated as sufficient confirmation for
  // that case.
  if (user.hasLocalPassword !== false) {
    if (!password) {
      return { success: false, status: 400, message: 'Password is required to delete your account' };
    }
    const valid = await comparePassword(password, user.password);
    if (!valid) {
      return { success: false, status: 401, message: 'Incorrect password' };
    }
  }

  const originalEmail = user.email;
  const anonymizedEmail = `deleted_${user.id}@deleted.necpa.local`;

  try {
    await user.update({
      isActive: false,
      email: anonymizedEmail,
      username: `deleted_${user.id}`,
      firstName: null,
      lastName: null,
      avatar: null,
      bio: null,
      fcmToken: null,
      mfaSecret: null,
      mfaEnabled: false,
      resetToken: null,
      resetTokenExpiry: null,
      deletionRequestedAt: new Date(),
    });
  } catch (e) {
    console.warn('[AccountDeletion] Full update failed, retrying with core fields only:', e.message);
    await user.update({
      isActive: false,
      email: anonymizedEmail,
      username: `deleted_${user.id}`,
      avatar: null,
      fcmToken: null,
      mfaSecret: null,
      mfaEnabled: false,
      resetToken: null,
      resetTokenExpiry: null,
      deletionRequestedAt: new Date(),
    });
  }

  try {
    const tokenService = require('./tokenService');
    if (typeof tokenService.revokeAllUserTokens === 'function') {
      await tokenService.revokeAllUserTokens(userId);
    } else if (db.Token) {
      await db.Token.update({ isRevoked: true }, { where: { userId } });
    }
  } catch (e) {
    console.warn('[AccountDeletion] Failed to revoke tokens:', e.message);
  }

  try {
    if (req) {
      const tokenService = require('./tokenService');
      const { blacklistAccessToken } = require('./tokenBlacklistService');
      const accessToken = tokenService.extractTokenFromRequest ? tokenService.extractTokenFromRequest(req) : null;
      if (accessToken) await blacklistAccessToken(accessToken);
    }
  } catch (e) {
    console.warn('[AccountDeletion] Failed to blacklist access token:', e.message);
  }

  try {
    if (db.Messages) {
      await db.Messages.update({ isDeleted: true }, { where: { senderId: userId } });
    }
  } catch (e) {
    console.warn('[AccountDeletion] Failed to mark messages deleted:', e.message);
  }

  try {
    if (db.GroupMembers) {
      await db.GroupMembers.destroy({ where: { userId } });
    }
  } catch (e) {
    console.warn('[AccountDeletion] Failed to remove group memberships:', e.message);
  }

  try {
    if (db.Settings) {
      await db.Settings.destroy({ where: { userId } });
    }
  } catch (e) {
    console.warn('[AccountDeletion] Failed to remove settings row:', e.message);
  }

  // FIX (delete account left the device live): push tokens / web-push subscriptions kept delivering to the phone, the
  // account's public E2E keys stayed published, and open sockets kept the session alive until they dropped on their own.
  // Each step is independent and best-effort so one missing table never blocks the deletion itself.
  for (const [label, sql] of [
    ['device push tokens',  'DELETE FROM device_push_tokens WHERE "userId" = :userId'],
    ['web push subscriptions', 'DELETE FROM push_subscriptions WHERE "userId" = :userId'],
    ['public encryption keys', 'DELETE FROM user_encryption_keys WHERE "userId" = :userId'],
  ]) {
    try { await db.sequelize.query(sql, { replacements: { userId } }); }
    catch (e) { console.warn('[AccountDeletion] Failed to remove ' + label + ':', e.message); }
  }
  try {
    const ws = require('./webSocketService');
    const ids = ws.onlineUsers && ws.onlineUsers.get(Number(userId));
    if (ids && ws.io && ws.io.sockets && ws.io.sockets.sockets) {
      for (const sid of Array.from(ids)) {
        try { const sock = ws.io.sockets.sockets.get(sid); if (sock) sock.disconnect(true); } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('[AccountDeletion] Failed to disconnect live sockets:', e.message);
  }

  try {
    const AuditLog = db.AuditLog;
    if (AuditLog) {
      await AuditLog.create({
        userId, action: 'account_deletion_requested', resourceType: 'user',
        resourceId: String(userId), details: {}, ipAddress: req?.ip || null,
      });
    }
  } catch (_) { /* audit logging is best-effort */ }

  if (originalEmail) {
    try {
      const emailService = require('./emailService');
      emailService.send(
        originalEmail,
        'Your Necpa Account Has Been Deleted',
        `<p>Your Necpa account and personal data have been deactivated and anonymised as requested.</p>
         <p>Remaining data will be permanently purged within ${RETENTION_DAYS} days. If you did not request this, contact support immediately.</p>`
      ).catch(e => console.warn('[AccountDeletion] Failed to send confirmation email:', e.message));
    } catch (_) {}
  }

  return {
    success: true, status: 200,
    message: `Your account has been deactivated and your personal data anonymised. Remaining data will be permanently deleted within ${RETENTION_DAYS} days.`,
  };
}

/**
 * Hard-deletes accounts whose deletionRequestedAt is older than
 * RETENTION_DAYS. Called on a schedule by src/jobs/accountPurgeJob.js.
 *
 * Scoped to what this codebase tracks a clean, reusable deletion handle
 * for: the Users row itself, this user's Status posts (including their
 * Cloudinary media, via the mediaPublicId column status.js already
 * populates), and their message_backups row. Deliberately NOT attempted
 * here: Cloudinary cleanup of avatar/cover photos and chat-media
 * attachments, since — unlike Status — those are stored elsewhere in this
 * codebase as bare URLs with no persisted Cloudinary public_id column to
 * delete by by; reconstructing one by parsing the URL was judged too
 * fragile to do silently in a destructive background job. That gap is
 * flagged in the audit response rather than papered over here.
 */
async function purgeExpiredAccounts() {
  const db = _getDb();
  const Users = _getUsers();
  const sequelize = db.sequelize;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const dueForPurge = await Users.findAll({
    where: { isActive: false, deletionRequestedAt: { [require('sequelize').Op.lte]: cutoff } },
    attributes: ['id'],
  });

  const results = { attempted: dueForPurge.length, purged: 0, failed: 0 };

  for (const row of dueForPurge) {
    const userId = row.id;
    try {
      // Cloudinary cleanup for this user's Status media, then the rows.
      if (db.Status) {
        try {
          const statuses = await db.Status.findAll({ where: { userId }, attributes: ['id', 'mediaPublicId'] });
          const { deleteFromCloudinary } = require('./cloudinaryService');
          for (const s of statuses) {
            if (s.mediaPublicId) {
              await deleteFromCloudinary(s.mediaPublicId).catch(e =>
                console.warn(`[AccountPurge] Cloudinary delete failed for status ${s.id}:`, e.message));
            }
          }
          await db.Status.destroy({ where: { userId } });
        } catch (e) {
          console.warn(`[AccountPurge] Status purge failed for user ${userId}:`, e.message);
        }
      }

      // message_backups (see the Backup & Restore fix — table created by
      // migration 20260918090000-create-message-backups.js).
      try {
        await sequelize.query('DELETE FROM message_backups WHERE "userId" = :userId', { replacements: { userId } });
      } catch (e) {
        console.warn(`[AccountPurge] Backup purge failed for user ${userId}:`, e.message);
      }

      // The user's own messages: hard-delete content now that the 30-day
      // window (during which other participants could still see "this
      // person left" context) has passed. Row stays if FK constraints
      // require it for thread integrity — deleting only the payload is
      // still a meaningful improvement over an indefinite soft-delete.
      try {
        if (db.Messages) {
          await db.Messages.update(
            { content: null, mediaUrl: null },
            { where: { senderId: userId } }
          ).catch(() => {});
        }
      } catch (_) {}

      await Users.destroy({ where: { id: userId } });
      results.purged++;
    } catch (e) {
      results.failed++;
      console.error(`[AccountPurge] Failed to purge user ${userId}:`, e.message);
    }
  }

  return results;
}

module.exports = { requestDeletion, purgeExpiredAccounts, RETENTION_DAYS };
