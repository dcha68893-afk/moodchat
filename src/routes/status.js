'use strict';
/**
 * src/routes/status.js
 *
 * Mood/status posts feature — mounted at /api/status/*.
 * (Not to be confused with /api/user-status/* which is online-presence,
 * implemented separately in userStatus.js.)
 *
 * HISTORY / WHY THIS FILE LOOKS THE WAY IT DOES:
 * A file previously at this path was a stray byte-identical copy of
 * src/models/Status.js (a Sequelize model factory `(sequelize, DataTypes) =>
 * {...}`), accidentally saved into routes/ instead of models/. The route
 * auto-loader in index.js treated it as a router, called it with zero
 * arguments (`routerInstance = routeHandler()`), and the model factory threw
 * "Cannot read properties of undefined (reading 'define')" because
 * `sequelize` was undefined. That failure was caught per-file by the mount
 * loop's try/catch, logged, and skipped — so it never crashed the server,
 * but it meant THIS file mounted nothing.
 *
 * A second file, statusFeed.js, was created as a workaround and mounted at
 * the same /status path immediately after (alphabetical load order), so in
 * practice statusFeed.js silently took over the /status mount and served a
 * partial implementation (/my, /friends, /stats, /user/:userId only).
 *
 * This file replaces both: it's the real router, covering every endpoint
 * documented in index.js's API listing, built on top of the existing,
 * already-correct statusController.js + statusService.js (which already
 * handle WebSocket broadcast via getIO(req) with multiple fallbacks, so no
 * req.io injection is required here). statusFeed.js has been removed —
 * see index.js for the corresponding mount-path fix.
 */
const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');

const statusController = require('../controllers/statusController');
const { authenticateToken, optionalAuthenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

const _getStatusModel = () => require('../models').Status;

function getUserId(req) {
  return req.user?.userId || req.user?.id;
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS (no auth required — router mounted without auth wrapper
// in index.js; optionalAuthenticateToken lets logged-in users still get
// privacy-aware results where relevant, without forcing a 401 for guests)
// ─────────────────────────────────────────────────────────────────────────

// GET /api/status/health
router.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'Status service healthy' });
});

// GET /api/status/  and  GET /api/status/public — active public statuses
router.get(['/', '/public'], optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Status = _getStatusModel();
  if (!Status) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const { limit, offset, type, moodType } = req.query;
  const statuses = await Status.getActiveStatuses({
    type: type || undefined,
    moodType: moodType || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return res.json({ success: true, data: statuses });
}));

// GET /api/status/trending
router.get('/trending', optionalAuthenticateToken, apiRateLimiter, statusController.getTrendingStatuses);

// GET /api/status/search?q=...
router.get('/search', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Status = _getStatusModel();
  if (!Status) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const { q, limit, offset } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ success: false, message: 'Query parameter "q" is required' });
  }

  const statuses = await Status.searchStatuses(q.trim(), {
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return res.json({ success: true, data: statuses });
}));

// GET /api/status/mood/:moodType
router.get('/mood/:moodType', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Status = _getStatusModel();
  if (!Status) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const { moodType } = req.params;
  const { limit, offset } = req.query;
  const statuses = await Status.getMoodStatuses(moodType, {
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return res.json({ success: true, data: statuses });
}));

// POST /api/status/view — record a view (body: { statusId })
router.post('/view', authenticateToken, apiRateLimiter, asyncHandler(async (req, res, next) => {
  req.params.statusId = req.body.statusId;
  return statusController.viewStatus(req, res, next);
}));

// POST /api/status/:statusId/view — record a view via URL param
router.post('/:statusId/view', authenticateToken, apiRateLimiter, statusController.viewStatus);

// ─────────────────────────────────────────────────────────────────────────
// PROTECTED ENDPOINTS (JWT required)
// ─────────────────────────────────────────────────────────────────────────

// POST /api/status/ — create a new status
router.post('/', authenticateToken, apiRateLimiter, statusController.createStatus);

// GET /api/status/my — current user's own statuses
router.get('/my', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  const Status = _getStatusModel();
  if (!Status) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const { activeOnly, type, moodType, limit, offset } = req.query;
  const statuses = await Status.getUserStatuses(userId, {
    activeOnly: activeOnly !== 'false',
    ...(type && { type }),
    ...(moodType && { moodType }),
    includeUser: true,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return res.json({ success: true, data: statuses });
}));

// GET /api/status/friends — statuses from the current user's friends
// This is the endpoint status-api.js's getFriendsStatuses() calls.
router.get('/friends', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  const Status = _getStatusModel();
  const Friend = require('../models').Friend;

  if (!Status || !Friend) {
    return res.status(503).json({ success: false, message: 'Status feature unavailable' });
  }

  const { limit, offset } = req.query;

  const friendRows = await Friend.getUserFriends(userId, 'accepted');
  const friendIds = friendRows.map(f => (f.requesterId === userId ? f.receiverId : f.requesterId));

  if (friendIds.length === 0) {
    return res.json({ success: true, data: [] });
  }

  const statuses = await Status.getFriendsStatuses(userId, friendIds, {
    includeStats: true,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return res.json({ success: true, data: statuses });
}));

// GET /api/status/stats — status statistics for the current user
router.get('/stats', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  const Status = _getStatusModel();
  if (!Status) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const stats = await Status.getStatusStats(userId);
  return res.json({ success: true, data: stats });
}));

// GET /api/status/timeline — feed of friends' (or all-followed) statuses
router.get('/timeline', authenticateToken, apiRateLimiter, statusController.getTimeline);

// GET /api/status/user/:userId — another user's public statuses
router.get('/user/:userId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Status = _getStatusModel();
  if (!Status) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const targetUserId = parseInt(req.params.userId, 10);
  if (!targetUserId) {
    return res.status(400).json({ success: false, message: 'Invalid user ID' });
  }

  const statuses = await Status.getUserStatuses(targetUserId, {
    activeOnly: true,
    includeUser: true,
  });

  return res.json({ success: true, data: statuses.filter(s => s.isPublic !== false) });
}));

// GET /api/status/:statusId — single status (controller handles privacy via canView)
router.get('/:statusId', optionalAuthenticateToken, apiRateLimiter, statusController.getStatusById);

// PUT /api/status/:statusId — update (owner only)
router.put('/:statusId', authenticateToken, apiRateLimiter, statusController.updateStatus);

// DELETE /api/status/:statusId — delete (owner only)
router.delete('/:statusId', authenticateToken, apiRateLimiter, statusController.deleteStatus);

// GET /api/status/:statusId/comments
router.get('/:statusId/comments', optionalAuthenticateToken, apiRateLimiter, statusController.getStatusComments);

// POST /api/status/:statusId/comment
router.post('/:statusId/comment', authenticateToken, apiRateLimiter, statusController.commentOnStatus);

// DELETE /api/status/:statusId/comment/:commentId
router.delete('/:statusId/comment/:commentId', authenticateToken, apiRateLimiter, statusController.deleteComment);

// GET /api/status/:statusId/likes
router.get('/:statusId/likes', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const db = require('../models');
  const StatusLike = db.StatusLike;
  if (!StatusLike) return res.status(503).json({ success: false, message: 'Status feature unavailable' });

  const { statusId } = req.params;
  const Users = db.Users || db.User;
  const likes = await StatusLike.findAll({
    where: { statusId },
    include: Users ? [{ model: Users, as: 'liker', attributes: ['id', 'username', 'avatar'] }] : [],
    order: [['createdAt', 'DESC']],
  });

  return res.json({ success: true, data: likes });
}));

// POST /api/status/:statusId/like
router.post('/:statusId/like', authenticateToken, apiRateLimiter, statusController.likeStatus);

// DELETE /api/status/:statusId/like
router.delete('/:statusId/like', authenticateToken, apiRateLimiter, statusController.unlikeStatus);

// POST /api/status/:statusId/share
router.post('/:statusId/share', authenticateToken, apiRateLimiter, statusController.shareStatus);

// GET /api/status/:statusId/stats — per-status statistics (distinct from /stats above)
router.get('/:statusId/stats', authenticateToken, apiRateLimiter, statusController.getStatusStatistics);

// POST /api/status/:statusId/report
router.post('/:statusId/report', authenticateToken, apiRateLimiter, statusController.reportStatus);

// POST /api/status/:statusId/pin
router.post('/:statusId/pin', authenticateToken, apiRateLimiter, statusController.pinStatus);

// DELETE /api/status/:statusId/pin
router.delete('/:statusId/pin', authenticateToken, apiRateLimiter, statusController.unpinStatus);

// POST /api/status/:statusId/react   { emoji }
router.post('/:statusId/react', authenticateToken, apiRateLimiter, statusController.addReaction);

// DELETE /api/status/:statusId/react
router.delete('/:statusId/react', authenticateToken, apiRateLimiter, statusController.removeReaction);

// POST /api/status/:statusId/reply   { content } — sends a chat message
router.post('/:statusId/reply', authenticateToken, apiRateLimiter, statusController.replyToStatus);

module.exports = router;
