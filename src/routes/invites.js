// routes/invites.js - Invite management routes
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

// Import controllers
const groupController = require('../controllers/groupController');
const friendController = require('../controllers/friendController');

// All invite routes require authentication
router.use(authenticateToken);

// Group invites
router.post('/groups/:groupId/invite', groupController.inviteToGroup);
router.get('/groups/invites', groupController.getGroupInvites);
router.post('/groups/invites/:inviteId/accept', groupController.acceptGroupInvite);
router.post('/groups/invites/:inviteId/reject', groupController.rejectGroupInvite);

// Friend invites (friend requests)
// FIX: getFriendRequests / acceptFriendRequest / rejectFriendRequest never
// existed on friendController (only sendFriendRequest, getPendingRequests,
// and a combined respondToFriendRequest(action) do) — router.get()/post()
// received `undefined` and threw at require-time, so this whole router
// (including the working group-invite routes above) never mounted.
router.post('/friends/request/:userId', friendController.sendFriendRequest);
router.get('/friends/requests', friendController.getPendingRequests);
router.post('/friends/requests/:requestId/accept', (req, res, next) => {
  req.body = { ...req.body, requestId: req.params.requestId, action: 'accept' };
  return friendController.respondToFriendRequest(req, res, next);
});
router.post('/friends/requests/:requestId/reject', (req, res, next) => {
  req.body = { ...req.body, requestId: req.params.requestId, action: 'reject' };
  return friendController.respondToFriendRequest(req, res, next);
});

console.log('✅ Invites routes initialized');
console.log('🔒 /api/invites - PROTECTED (JWT required)');

module.exports = router;