'use strict';
/**
 * src/routes/account.js
 * P2 FIXES (Forensic Audit):
 *  - GET    /api/account/export   — GDPR data export (JSON download)
 *  - DELETE /api/account           — Right to erasure (soft delete + anonymise)
 *  - PUT    /api/account/password  — Change password (requires current password)
 *
 * Mounted under authenticated routes by src/routes/index.js's auto-loader.
 */
const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');

// AUTH-X FIX pattern (matches auth.js): resolve models lazily, not at module
// load time, since sequelize.sync() may not have completed yet.
const _getDb = () => require('../models');
const _getUsers = () => {
    const db = _getDb();
    return db.User || db.Users || db.sequelize?.models?.Users || db.sequelize?.models?.User;
};

const { dataExportLimiter } = require('../middleware/rateLimiter');
const { hashPassword, comparePassword } = require('../utils/passwordUtils');
const { checkPwnedPassword } = require('../utils/pwnedPasswordCheck');
const passwordHistoryService = require('../services/passwordHistoryService');
const emailService = require('../services/emailService');
const tokenService = require('../services/tokenService');
const { blacklistAccessToken } = require('../services/tokenBlacklistService');

function getUserId(req) {
    return req.user?.userId || req.user?.id;
}

async function writeAuditLog(userId, action, details = {}, req = null) {
    try {
        const db = _getDb();
        const AuditLog = db.AuditLog;
        if (!AuditLog) return;
        await AuditLog.create({
            // NOTE: AuditLog.userId is typed as UUID while Users.id is an
            // INTEGER in this schema — a pre-existing mismatch. We pass the
            // value through as-is; if Sequelize rejects it, the catch below
            // swallows the error so this never blocks the main operation.
            userId,
            action,
            resourceType: 'user',
            resourceId: String(userId),
            details,
            ipAddress: req?.ip || details.ip || null,
        });
    } catch (e) {
        console.warn('[Account] Failed to write audit log:', e.message);
    }
}

// ── GET /api/account/export ─────────────────────────────────────────────────
// P2 FIX: GDPR data export. Returns a JSON download of the user's data.
// Rate-limited to once per 24h. Logs the export event.
router.get('/export', dataExportLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const db = _getDb();

    const user = await _getUsers().findByPk(userId);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    const exportData = {
        exportedAt: new Date().toISOString(),
        profile: user.toJSON(),
    };

    // Each section is best-effort: a missing/changed association in one
    // model must not prevent exporting the rest of the user's data.
    const sections = [
        {
            key: 'messages',
            run: async () => {
                const Messages = db.Messages;
                if (!Messages) return [];
                return Messages.findAll({ where: { senderId: userId }, limit: 5000 });
            }
        },
        {
            key: 'friends',
            run: async () => {
                const Friend = db.Friend;
                if (!Friend) return [];
                return Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }] }
                });
            }
        },
        {
            key: 'groupMemberships',
            run: async () => {
                const GroupMembers = db.GroupMembers;
                if (!GroupMembers) return [];
                return GroupMembers.findAll({ where: { userId } });
            }
        },
        {
            key: 'statuses',
            run: async () => {
                const Status = db.Status;
                if (!Status) return [];
                return Status.findAll({ where: { userId }, limit: 1000 });
            }
        },
        {
            key: 'calls',
            run: async () => {
                const Calls = db.Calls;
                if (!Calls) return [];
                // Calls store participants as a JSON array rather than a FK column
                const all = await Calls.findAll({ limit: 2000, order: [['createdAt', 'DESC']] });
                return all.filter(c => Array.isArray(c.participants) && c.participants.includes(userId));
            }
        },
        {
            key: 'activeSessions',
            run: async () => {
                const TokenModel = db.Token;
                if (!TokenModel) return [];
                return TokenModel.findAll({
                    where: { userId, tokenType: 'refresh' },
                    attributes: { exclude: ['token', 'tokenHash'] }
                });
            }
        }
    ];

    for (const section of sections) {
        try {
            exportData[section.key] = await section.run();
        } catch (e) {
            console.warn(`[Account Export] Failed to export section "${section.key}":`, e.message);
            exportData[section.key] = { error: 'Could not export this section' };
        }
    }

    await writeAuditLog(userId, 'data_export', {}, req);

    res.setHeader('Content-Disposition', `attachment; filename="nexopa-data-export-${userId}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ success: true, data: exportData });
}));

// ── PUT /api/account/password ───────────────────────────────────────────────
// P3 FIX: change password — requires current password verification.
// Also runs the HaveIBeenPwned check (P2) on the new password.
router.put('/password', asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Current and new password are required' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const user = await _getUsers().findByPk(userId);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    const valid = await comparePassword(currentPassword, user.password);
    if (!valid) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const pwnedCheck = await checkPwnedPassword(newPassword);
    if (pwnedCheck.pwned) {
        return res.status(400).json({
            success: false,
            message: 'This password has appeared in a data breach. Please choose a different password.',
            errorCode: 'PASSWORD_PWNED'
        });
    }

    // P3 FIX (Forensic Audit): "Implement password history (last 5)"
    if (await passwordHistoryService.isPasswordReused(userId, newPassword)) {
        return res.status(400).json({
            success: false,
            message: `You can't reuse one of your last ${passwordHistoryService.HISTORY_LIMIT} passwords. Please choose a different password.`,
            errorCode: 'PASSWORD_REUSED'
        });
    }

    const hashedPassword = await hashPassword(newPassword);
    await user.update({ password: hashedPassword });
    await passwordHistoryService.recordPasswordHash(userId, hashedPassword);

    await writeAuditLog(userId, 'password_changed', {}, req);

    if (user.email) {
        emailService.passwordChangedAlert(user.email)
            .catch(e => console.warn('[Account] Failed to send password changed alert:', e.message));
    }

    return res.status(200).json({ success: true, message: 'Password changed successfully' });
}));

// ── DELETE /api/account ─────────────────────────────────────────────────────
// P2 FIX: Right to erasure. Requires current password re-entry.
// Soft-deletes + anonymises PII immediately; permanent purge is intended to
// run as a scheduled job 30 days after `deletionRequestedAt`.
router.delete('/', asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { password } = req.body;
    const db = _getDb();

    if (!password) {
        return res.status(400).json({ success: false, message: 'Password is required to delete your account' });
    }

    const user = await _getUsers().findByPk(userId);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    const valid = await comparePassword(password, user.password);
    if (!valid) {
        return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    const originalEmail = user.email;
    const anonymizedEmail = `deleted_${user.id}@deleted.nexopa.local`;

    // Anonymise PII and deactivate the account
    try {
        await user.update({
            isActive: false,
            email: anonymizedEmail,
            username: `deleted_${user.id}`,
            firstName: null,
            lastName: null,
            avatar: null,
            fcmToken: null,
            mfaSecret: null,
            mfaEnabled: false,
            resetToken: null,
            resetTokenExpiry: null,
            deletionRequestedAt: new Date(),
        });
    } catch (e) {
        // If optional columns don't exist in this schema yet, retry with
        // only the guaranteed columns.
        console.warn('[Account Delete] Full update failed, retrying with core fields only:', e.message);
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
        });
    }

    // Revoke all refresh tokens / sessions for this user
    try {
        if (typeof tokenService.revokeAllUserTokens === 'function') {
            await tokenService.revokeAllUserTokens(userId);
        } else {
            const TokenModel = db.Token;
            if (TokenModel) {
                await TokenModel.destroy({ where: { userId } });
            }
        }
    } catch (e) {
        console.warn('[Account Delete] Failed to revoke tokens:', e.message);
    }

    // Blacklist the access token used for this request
    try {
        const accessToken = tokenService.extractTokenFromRequest
            ? tokenService.extractTokenFromRequest(req)
            : null;
        if (accessToken) {
            await blacklistAccessToken(accessToken);
        }
    } catch (e) {
        console.warn('[Account Delete] Failed to blacklist access token:', e.message);
    }

    // Soft-delete the user's messages (preserve thread integrity for other
    // participants) — actual content removal happens in the 30-day purge job
    try {
        const Messages = db.Messages;
        if (Messages) {
            await Messages.update(
                { isDeleted: true },
                { where: { senderId: userId } }
            );
        }
    } catch (e) {
        console.warn('[Account Delete] Failed to mark messages deleted:', e.message);
    }

    // Remove from groups
    try {
        const GroupMembers = db.GroupMembers;
        if (GroupMembers) {
            await GroupMembers.destroy({ where: { userId } });
        }
    } catch (e) {
        console.warn('[Account Delete] Failed to remove group memberships:', e.message);
    }

    await writeAuditLog(userId, 'account_deletion_requested', {}, req);

    // Send confirmation email to the ORIGINAL address (before anonymisation)
    if (originalEmail) {
        emailService.send(
            originalEmail,
            'Your Nexopa Account Has Been Deleted',
            `<p>Your Nexopa account and personal data have been deactivated and anonymised as requested.</p>
             <p>Remaining data will be permanently purged within 30 days. If you did not request this, contact support immediately.</p>`
        ).catch(e => console.warn('[Account Delete] Failed to send confirmation email:', e.message));
    }

    return res.status(200).json({
        success: true,
        message: 'Your account has been deactivated and your personal data anonymised. Remaining data will be permanently deleted within 30 days.'
    });
}));

module.exports = router;
