/**
 * twoFactor.js — TOTP 2FA routes
 *
 * POST /api/2fa/setup      — Generate TOTP secret + QR code
 * POST /api/2fa/verify     — Verify TOTP code and enable 2FA
 * POST /api/2fa/validate   — Validate TOTP during login
 * DELETE /api/2fa/disable  — Disable 2FA (requires current TOTP)
 * GET  /api/2fa/backup-codes — List remaining backup codes
 * POST /api/2fa/backup-codes/regenerate — Generate new backup codes
 * GET  /api/2fa/status     — Check if 2FA is enabled for current user
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('express-async-handler');
const crypto       = require('crypto');
const { authenticator } = require('otplib');

// otplib config — 30s window, allow 1 step drift
authenticator.options = { window: 1 };

function getSequelize() { return require('../models/index').sequelize; }

const APP_NAME = process.env.APP_NAME || 'Kynecta';

// ── Generate backup codes ─────────────────────────────────────────────────────
function _generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw  = crypto.randomBytes(5).toString('hex').toUpperCase();
    const code = raw.slice(0, 5) + '-' + raw.slice(5);
    codes.push({ code, used: false });
  }
  return codes;
}

// ── Hash a backup code ────────────────────────────────────────────────────────
function _hashCode(code) {
  return crypto.createHash('sha256').update(code.replace('-', '').toUpperCase()).digest('hex');
}

// ── GET /api/2fa/status ───────────────────────────────────────────────────────
router.get('/status', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  const rows      = await sequelize.query(
    `SELECT "isEnabled" FROM user_totp_secrets WHERE "userId"=:userId LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  const isEnabled = rows?.length > 0 ? rows[0].isEnabled : false;
  res.json({ status: 'success', data: { enabled: isEnabled } });
}));

// ── POST /api/2fa/setup — generate secret + QR code ─────────────────────────
router.post('/setup', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();

  // Check if already enabled
  const existing = await sequelize.query(
    `SELECT "isEnabled" FROM user_totp_secrets WHERE "userId"=:userId LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (existing?.length > 0 && existing[0].isEnabled) {
    return res.status(409).json({ status: 'error', message: '2FA is already enabled. Disable it first.' });
  }

  // Get user email/username for QR label
  const userRows = await sequelize.query(
    `SELECT username, email FROM "Users" WHERE id=:userId LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  const userLabel = userRows?.[0]?.email || userRows?.[0]?.username || `user_${userId}`;

  const secret  = authenticator.generateSecret(32);
  const otpauth = authenticator.keyuri(userLabel, APP_NAME, secret);
  const backupCodes = _generateBackupCodes(10);

  // Store secret (not yet enabled until verified)
  await sequelize.query(
    `INSERT INTO user_totp_secrets ("userId", secret, "isEnabled", "backupCodes", "createdAt", "updatedAt")
     VALUES (:userId, :secret, false, :backupCodes, NOW(), NOW())
     ON CONFLICT ("userId") DO UPDATE
       SET secret=:secret, "isEnabled"=false, "backupCodes"=:backupCodes, "updatedAt"=NOW()`,
    { replacements: { userId, secret, backupCodes: JSON.stringify(backupCodes) } }
  );

  // Generate QR code as data URL (using qrcode if available, otpauth URI otherwise)
  let qrCode = null;
  try {
    const QRCode = require('qrcode');
    qrCode = await QRCode.toDataURL(otpauth);
  } catch (_) {
    // qrcode not installed — return the otpauth URI for client-side rendering
  }

  res.json({
    status: 'success',
    data: {
      secret,
      otpauthUrl: otpauth,
      qrCode,
      backupCodes: backupCodes.map(b => b.code),
    },
    message: 'Scan the QR code with your authenticator app, then call /api/2fa/verify to enable.',
  });
}));

// ── POST /api/2fa/verify — verify TOTP and enable ────────────────────────────
router.post('/verify', asyncHandler(async (req, res) => {
  const userId  = req.user.id;
  const { token } = req.body;

  if (!token || typeof token !== 'string' || token.length < 6) {
    return res.status(400).json({ status: 'error', message: 'token (6-digit TOTP code) is required' });
  }

  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT secret FROM user_totp_secrets WHERE "userId"=:userId LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );

  if (!rows?.length) {
    return res.status(404).json({ status: 'error', message: 'Run /api/2fa/setup first' });
  }

  const valid = authenticator.verify({ token: token.replace(/\s/g, ''), secret: rows[0].secret });
  if (!valid) {
    return res.status(401).json({ status: 'error', message: 'Invalid TOTP code. Check your authenticator app time sync.' });
  }

  await sequelize.query(
    `UPDATE user_totp_secrets SET "isEnabled"=true, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );

  res.json({ status: 'success', message: '2FA enabled successfully. Save your backup codes!' });
}));

// ── POST /api/2fa/validate — called during login when 2FA is required ─────────
router.post('/validate', asyncHandler(async (req, res) => {
  const userId  = req.user.id;
  const { token } = req.body;

  if (!token) return res.status(400).json({ status: 'error', message: 'token required' });

  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT secret, "isEnabled", "backupCodes" FROM user_totp_secrets WHERE "userId"=:userId LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );

  if (!rows?.length || !rows[0].isEnabled) {
    return res.status(404).json({ status: 'error', message: '2FA not enabled for this account' });
  }

  const { secret, backupCodes } = rows[0];
  const cleanToken = token.replace(/\s/g, '').toUpperCase();

  // Try TOTP first
  if (authenticator.verify({ token: cleanToken, secret })) {
    return res.json({ status: 'success', message: '2FA validated' });
  }

  // Try backup codes
  let codes = Array.isArray(backupCodes) ? backupCodes : JSON.parse(backupCodes || '[]');
  const matchIdx = codes.findIndex(c => !c.used && c.code.replace('-', '') === cleanToken.replace('-', ''));

  if (matchIdx >= 0) {
    codes[matchIdx].used = true;
    await sequelize.query(
      `UPDATE user_totp_secrets SET "backupCodes"=:codes, "updatedAt"=NOW() WHERE "userId"=:userId`,
      { replacements: { codes: JSON.stringify(codes), userId } }
    );
    const remaining = codes.filter(c => !c.used).length;
    return res.json({
      status: 'success',
      message: `Backup code used. ${remaining} code${remaining !== 1 ? 's' : ''} remaining.`,
      data: { backupCodeUsed: true, remaining },
    });
  }

  res.status(401).json({ status: 'error', message: 'Invalid 2FA code' });
}));

// ── DELETE /api/2fa/disable ───────────────────────────────────────────────────
router.delete('/disable', asyncHandler(async (req, res) => {
  const userId  = req.user.id;
  const { token } = req.body;

  if (!token) return res.status(400).json({ status: 'error', message: 'Current TOTP token required to disable 2FA' });

  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT secret FROM user_totp_secrets WHERE "userId"=:userId AND "isEnabled"=true LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );

  if (!rows?.length) return res.status(404).json({ status: 'error', message: '2FA is not enabled' });

  if (!authenticator.verify({ token: token.replace(/\s/g, ''), secret: rows[0].secret })) {
    return res.status(401).json({ status: 'error', message: 'Invalid TOTP code' });
  }

  await sequelize.query(
    `UPDATE user_totp_secrets SET "isEnabled"=false, secret='', "backupCodes"='[]', "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );

  res.json({ status: 'success', message: '2FA disabled' });
}));

// ── GET /api/2fa/backup-codes ─────────────────────────────────────────────────
router.get('/backup-codes', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT "backupCodes" FROM user_totp_secrets WHERE "userId"=:userId AND "isEnabled"=true LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows?.length) return res.status(404).json({ status: 'error', message: '2FA not enabled' });

  const codes = Array.isArray(rows[0].backupCodes) ? rows[0].backupCodes : JSON.parse(rows[0].backupCodes || '[]');
  const remaining = codes.filter(c => !c.used);
  res.json({ status: 'success', data: { remaining: remaining.length, codes: remaining.map(c => c.code) } });
}));

// ── POST /api/2fa/backup-codes/regenerate ─────────────────────────────────────
router.post('/backup-codes/regenerate', asyncHandler(async (req, res) => {
  const userId  = req.user.id;
  const { token } = req.body;

  if (!token) return res.status(400).json({ status: 'error', message: 'Current TOTP token required' });

  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT secret FROM user_totp_secrets WHERE "userId"=:userId AND "isEnabled"=true LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows?.length) return res.status(404).json({ status: 'error', message: '2FA not enabled' });
  if (!authenticator.verify({ token: token.replace(/\s/g, ''), secret: rows[0].secret })) {
    return res.status(401).json({ status: 'error', message: 'Invalid TOTP code' });
  }

  const newCodes = _generateBackupCodes(10);
  await sequelize.query(
    `UPDATE user_totp_secrets SET "backupCodes"=:codes, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { codes: JSON.stringify(newCodes), userId } }
  );

  res.json({ status: 'success', data: { codes: newCodes.map(c => c.code) }, message: 'New backup codes generated. Old codes are now invalid.' });
}));

module.exports = router;
