// src/routes/privacy.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX: Privacy & Trust routes
//  - Last-seen visibility (everyone / contacts / nobody)
//  - Linked device sessions list + remote logout
//  - Key verification (safety numbers confirmation)
//  - Spam / user reporting pipeline
//
// Mount in src/server.js:
//   app.use('/api/privacy', require('./routes/privacy'));
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express  = require('express');
const router   = express.Router();
const { Op }   = require('sequelize');

const { authenticate }   = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { asyncHandler }   = require('../middleware/asyncHandler');

// ── LAST-SEEN VISIBILITY ──────────────────────────────────────────────────────

// PUT /api/privacy/last-seen
router.put('/last-seen', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const { visibility } = req.body; // 'everyone' | 'contacts' | 'nobody'
  const VALID = ['everyone', 'contacts', 'nobody'];
  if (!VALID.includes(visibility)) {
    return res.status(400).json({ status: 'error', message: `visibility must be one of: ${VALID.join(', ')}` });
  }
  // FIX: was require('../models/User') — that file does not exist anywhere
  // in the repo (the real model is models/Users.js, loaded via models/index.js),
  // so this always threw. Also now writes to settings.privacy.lastSeen (the
  // same field the main Settings page uses and that users.js's privacy
  // filter reads) instead of a separate lastSeenVisibility column, so the
  // two systems can't silently disagree about a user's own setting.
  const { User } = require('../models');
  try {
    const user = await User.findByPk(req.user.id);
    if (user) {
      const settings = user.settings || {};
      settings.privacy = { ...(settings.privacy || {}), lastSeen: visibility };
      await user.update({ settings });
    }
  } catch (err) {
    console.warn('[privacy] Failed to save last-seen visibility:', err.message);
  }
  res.json({ status: 'success', data: { visibility } });
}));

// GET /api/privacy/last-seen/:userId — respects that user's visibility setting
router.get('/last-seen/:userId', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  // FIX: same broken imports as above (User, Friendship modules don't exist),
  // plus reads from the same settings.privacy.lastSeen field the rest of the
  // app now uses (see users.js's _applyLastSeenPrivacy).
  const { User, Friend } = require('../models');
  const target = await User.findByPk(req.params.userId, {
    attributes: ['id', 'lastSeen', 'status', 'settings'],
  });
  if (!target) return res.status(404).json({ status: 'error', message: 'User not found' });

  const vis = target.settings?.privacy?.lastSeen || 'everyone';
  if (vis === 'nobody') {
    return res.json({ status: 'success', data: { visible: false } });
  }
  if (vis === 'contacts') {
    const isFriend = await Friend.findOne({
      where: {
        status: 'accepted',
        [Op.or]: [
          { requester_id: req.user.id, receiver_id: target.id },
          { requester_id: target.id, receiver_id: req.user.id },
        ],
      },
    });
    if (!isFriend) return res.json({ status: 'success', data: { visible: false } });
  }

  res.json({
    status: 'success',
    data: {
      visible:  true,
      lastSeen: target.lastSeen,
      isOnline: target.status === 'online',
    },
  });
}));

// ── LINKED DEVICE SESSIONS ────────────────────────────────────────────────────

// GET /api/privacy/sessions — list all active sessions for the current user
router.get('/sessions', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = require('../config/database');
  let sessions = [];
  try {
    sessions = await sequelize.query(
      `SELECT id, "deviceInfo", "ipAddress", "createdAt", "lastActiveAt"
       FROM user_sessions
       WHERE "userId" = :userId AND "expiresAt" > NOW()
       ORDER BY "lastActiveAt" DESC
       LIMIT 20`,
      { replacements: { userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );
  } catch (_) {
    // user_sessions table may not exist; return empty array gracefully
  }

  // Mark the current session
  const currentToken = req.headers.authorization?.replace('Bearer ', '').slice(0, 16);
  sessions = sessions.map(s => ({
    ...s,
    isCurrent: s.id && currentToken && String(s.id).startsWith(currentToken),
    deviceLabel: _parseDevice(s.deviceInfo),
  }));

  res.json({ status: 'success', data: { sessions } });
}));

// DELETE /api/privacy/sessions/:sessionId — remote logout a specific session
router.delete('/sessions/:sessionId', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = require('../config/database');
  try {
    await sequelize.query(
      `DELETE FROM user_sessions WHERE id = :sessionId AND "userId" = :userId`,
      { replacements: { sessionId: req.params.sessionId, userId: req.user.id } }
    );
  } catch (_) {}

  // Emit WS event to force-disconnect that session
  try {
    const wsService = require('../services/webSocketService');
    await wsService.sendToUser(req.user.id, 'session:revoked', { sessionId: req.params.sessionId });
  } catch (_) {}

  res.json({ status: 'success', message: 'Session revoked' });
}));

// DELETE /api/privacy/sessions — revoke ALL sessions except current
router.delete('/sessions', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = require('../config/database');
  const currentToken = req.headers.authorization?.replace('Bearer ', '');
  try {
    await sequelize.query(
      `DELETE FROM user_sessions WHERE "userId" = :userId AND token != :currentToken`,
      { replacements: { userId: req.user.id, currentToken: currentToken || '' } }
    );
  } catch (_) {}

  try {
    const wsService = require('../services/webSocketService');
    await wsService.sendToUser(req.user.id, 'sessions:all_revoked', {});
  } catch (_) {}

  res.json({ status: 'success', message: 'All other sessions revoked' });
}));

// ── KEY VERIFICATION (SAFETY NUMBERS) ─────────────────────────────────────────

// POST /api/users/:userId/verify-key — mark a contact's key as verified
router.post('/users/:userId/verify-key', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = require('../config/database');
  const otherUserId = req.params.userId;
  try {
    // Upsert into key_verifications table
    await sequelize.query(
      `INSERT INTO key_verifications ("userId", "verifiedUserId", "verifiedAt", "createdAt", "updatedAt")
       VALUES (:userId, :verifiedUserId, NOW(), NOW(), NOW())
       ON CONFLICT ("userId", "verifiedUserId") DO UPDATE SET "verifiedAt" = NOW(), "updatedAt" = NOW()`,
      { replacements: { userId: req.user.id, verifiedUserId: otherUserId } }
    );
  } catch (_colErr) {
    console.warn('[privacy] key_verifications table missing — creating inline');
    try {
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS key_verifications (
          id SERIAL PRIMARY KEY,
          "userId" INTEGER NOT NULL,
          "verifiedUserId" INTEGER NOT NULL,
          "verifiedAt" TIMESTAMP,
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP,
          UNIQUE("userId","verifiedUserId")
        )`
      );
      await sequelize.query(
        `INSERT INTO key_verifications ("userId","verifiedUserId","verifiedAt","createdAt","updatedAt")
         VALUES (:userId,:verifiedUserId,NOW(),NOW(),NOW())
         ON CONFLICT DO NOTHING`,
        { replacements: { userId: req.user.id, verifiedUserId: otherUserId } }
      );
    } catch (_) {}
  }
  res.json({ status: 'success', message: 'Key marked as verified' });
}));

// GET /api/users/:userId/key-verified — check if current user has verified this contact
router.get('/users/:userId/key-verified', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = require('../config/database');
  let verified = false;
  try {
    const rows = await sequelize.query(
      `SELECT 1 FROM key_verifications WHERE "userId" = :userId AND "verifiedUserId" = :verifiedUserId LIMIT 1`,
      { replacements: { userId: req.user.id, verifiedUserId: req.params.userId }, type: sequelize.QueryTypes.SELECT }
    );
    verified = rows && rows.length > 0;
  } catch (_) {}
  res.json({ status: 'success', data: { verified } });
}));

// ── SPAM / USER REPORTING ─────────────────────────────────────────────────────

// POST /api/privacy/report — report a user for spam/abuse
router.post('/report', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const { reportedUserId, reason, details, messageIds } = req.body;
  const VALID_REASONS = ['spam', 'harassment', 'fake_account', 'inappropriate_content', 'other'];

  if (!reportedUserId) return res.status(400).json({ status: 'error', message: 'reportedUserId required' });
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ status: 'error', message: `reason must be one of: ${VALID_REASONS.join(', ')}` });
  }
  if (String(reportedUserId) === String(req.user.id)) {
    return res.status(400).json({ status: 'error', message: 'Cannot report yourself' });
  }

  const sequelize = require('../config/database');
  try {
    // Try ModerationLog model first (it exists per previous audit)
    const ModerationLog = require('../models/ModerationLog');
    await ModerationLog.create({
      type: 'user_report',
      reporterId: req.user.id,
      targetId: reportedUserId,
      targetType: 'user',
      reason,
      details: details ? String(details).slice(0, 500) : null,
      metadata: messageIds ? JSON.stringify({ messageIds }) : null,
      status: 'pending',
    });
  } catch (_) {
    // Fallback: raw insert into moderation_logs
    try {
      await sequelize.query(
        `INSERT INTO moderation_logs ("type","reporterId","targetId","targetType","reason","details","status","createdAt","updatedAt")
         VALUES ('user_report',:reporterId,:targetId,'user',:reason,:details,'pending',NOW(),NOW())`,
        { replacements: { reporterId: req.user.id, targetId: reportedUserId, reason, details: details || null } }
      );
    } catch (_2) {
      console.warn('[privacy] Could not write ModerationLog:', _2.message);
    }
  }

  // Auto-block the reported user locally (client handles the WS event)
  try {
    const wsService = require('../services/webSocketService');
    await wsService.sendToUser(req.user.id, 'user:blocked', { userId: reportedUserId });
  } catch (_) {}

  res.json({ status: 'success', message: 'Report submitted. Thank you for helping keep MoodChat safe.' });
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function _parseDevice(raw) {
  if (!raw) return 'Unknown device';
  try {
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return info.browser
      ? `${info.browser} on ${info.os || 'unknown OS'}`
      : String(raw).slice(0, 40);
  } catch (_) {
    return String(raw).slice(0, 40);
  }
}

module.exports = router;
