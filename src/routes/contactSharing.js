'use strict';

/**
 * Contact Sharing Routes
 *
 * Contact messages use the existing type='contact' already in the Messages
 * ENUM and ALLOWED_MSG_TYPES — sending one works today via POST /api/messages
 * with { type: 'contact', clientMetadata: { contact: {...} } }.
 *
 * What was MISSING before this file:
 *   1. A search endpoint so the sender can find Nexopa users to share
 *      (rather than hand-building the vCard payload themselves).
 *   2. A contact-card hydration endpoint so a received contact card can be
 *      rendered with live avatar/status even if the underlying user changed
 *      their profile since the message was sent.
 *   3. An "add as friend" shortcut from a received contact card — one tap
 *      to send a friend request to the shared contact without leaving the chat.
 */

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');

function safeInt(val) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildContactCard(user) {
  return {
    userId: user.id,
    username: user.username,
    displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    phone: user.phone || null,
    avatar: user.avatar || null,
    bio: user.bio || null,
    // Never share email in a contact card — that's private and the user hasn't
    // explicitly consented to it being forwarded to strangers in a chat.
  };
}

// ============================================================================
// GET /api/contact-sharing/search?q=:query — Search Nexopa users to share
// Returns up to 20 results matching username/displayName/phone prefix
// ============================================================================
router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const userId = req.user.id;
  const q = String(req.query.q || '').trim();

  if (q.length < 2) {
    return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
  }
  if (q.length > 50) {
    return res.status(400).json({ success: false, message: 'Search query too long' });
  }

  // Sanitize: only allow alphanumeric, spaces, dots, hyphens, underscores, and + for phone
  if (!/^[\w\s.+@-]{2,50}$/.test(q)) {
    return res.status(400).json({ success: false, message: 'Invalid search query' });
  }

  const pattern = `%${q}%`;
  const users = await sequelize.query(
    `SELECT id, username, "firstName", "lastName", avatar, bio, phone
     FROM "Users"
     WHERE id != :userId
       AND "isActive" != false
       AND (
         username ILIKE :pattern
         OR "firstName" ILIKE :pattern
         OR "lastName" ILIKE :pattern
         OR CONCAT("firstName", ' ', "lastName") ILIKE :pattern
       )
     ORDER BY username ASC
     LIMIT 20`,
    { replacements: { userId, pattern }, type: sequelize.QueryTypes.SELECT }
  );

  res.json({
    success: true,
    data: { contacts: users.map(buildContactCard) },
  });
}));

// ============================================================================
// GET /api/contact-sharing/:userId/card — Get a live contact card for a user
// Used by the chat UI to re-hydrate a shared contact card with current
// avatar/bio in case the user updated their profile since the message was sent
// ============================================================================
router.get('/:userId/card', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const targetUserId = safeInt(req.params.userId);
  if (!targetUserId) return res.status(400).json({ success: false, message: 'Invalid userId' });

  const [user] = await sequelize.query(
    `SELECT id, username, "firstName", "lastName", avatar, bio, phone
     FROM "Users" WHERE id = :targetUserId AND "isActive" != false LIMIT 1`,
    { replacements: { targetUserId }, type: sequelize.QueryTypes.SELECT }
  );

  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  res.json({ success: true, data: { contact: buildContactCard(user) } });
}));

// ============================================================================
// POST /api/contact-sharing/:userId/add-friend — Send a friend request to a
// user whose contact card was shared in a chat — one-tap shortcut from the
// received contact card bubble rather than having to navigate to the user's
// profile first.
// ============================================================================
router.post('/:userId/add-friend', apiRateLimiter, asyncHandler(async (req, res) => {
  const sequelize = req.app.locals.db;
  const requesterId = req.user.id;
  const targetUserId = safeInt(req.params.userId);
  if (!targetUserId) return res.status(400).json({ success: false, message: 'Invalid userId' });

  if (requesterId === targetUserId) {
    return res.status(400).json({ success: false, message: 'You cannot add yourself as a friend' });
  }

  // Confirm target user exists
  const [target] = await sequelize.query(
    `SELECT id, username FROM "Users" WHERE id = :targetUserId AND "isActive" != false LIMIT 1`,
    { replacements: { targetUserId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!target) return res.status(404).json({ success: false, message: 'User not found' });

  // Check if already friends or a request is already pending
  const existing = await sequelize.query(
    `SELECT id, status FROM "Friends"
     WHERE ("userId" = :requesterId AND "friendId" = :targetUserId)
        OR ("userId" = :targetUserId AND "friendId" = :requesterId)
     LIMIT 1`,
    { replacements: { requesterId, targetUserId }, type: sequelize.QueryTypes.SELECT }
  );

  if (existing && existing.length > 0) {
    const status = existing[0].status;
    if (status === 'accepted') {
      return res.status(409).json({ success: false, message: 'You are already friends with this user' });
    }
    if (status === 'pending') {
      return res.status(409).json({ success: false, message: 'A friend request to this user is already pending' });
    }
  }

  await sequelize.query(
    `INSERT INTO "Friends" ("userId", "friendId", status, "createdAt", "updatedAt")
     VALUES (:requesterId, :targetUserId, 'pending', NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    { replacements: { requesterId, targetUserId } }
  );

  // Notify the target user via socket so they see the request live
  try {
    const wsService = require('../services/webSocketService');
    const [requester] = await sequelize.query(
      `SELECT id, username, avatar FROM "Users" WHERE id = :requesterId LIMIT 1`,
      { replacements: { requesterId }, type: sequelize.QueryTypes.SELECT }
    );
    wsService.sendToUser(targetUserId, 'friend:request', {
      from: { id: requesterId, username: requester?.username, avatar: requester?.avatar },
      message: `${requester?.username || 'Someone'} wants to add you as a friend`,
    });
  } catch (_) {}

  res.status(201).json({
    success: true,
    message: `Friend request sent to ${target.username}`,
    data: { targetUserId, targetUsername: target.username },
  });
}));

module.exports = router;
