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
router.post('/friends/request/:userId', friendController.sendFriendRequest);
router.get('/friends/requests', friendController.getFriendRequests);
router.post('/friends/requests/:requestId/accept', friendController.acceptFriendRequest);
router.post('/friends/requests/:requestId/reject', friendController.rejectFriendRequest);

console.log('✅ Invites routes initialized');
console.log('🔒 /api/invites - PROTECTED (JWT required)');

module.exports = router;