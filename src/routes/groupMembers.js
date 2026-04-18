// routes/groupMembers.js — v2.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ Requires groupMembersController (now uses the fixed controller that
//     requires the new groupMembersService — was crashing at boot)
//   ✔ Route ordering fixed: /invitations BEFORE /:groupId to prevent
//     Express treating "invitations" as a groupId param
//   ✔ Added GET /invitations/sent route (was registered in controller but missing here)
//   ✔ Added PATCH /:groupId/members/:memberId/role alias (some clients send PATCH)
//   ✔ All routes protected by authenticateToken middleware
//   ✔ io injected via middleware so controllers can emit socket events
// ============================================================

const path = require('path');
const express = require('express');
const router = express.Router();
const groupMembersController = require('../controllers/groupMembersController');
const { authenticateToken } = require(path.join(__dirname, '../middleware/auth'));
const { apiRateLimiter } = require('../middleware/rateLimiter');

// ── Inject socket.io into req so controllers can emit events ─────────────────
router.use((req, res, next) => {
    req.io = global.__socketIO || null;
    next();
});

// ── Authentication: ALL routes require a valid token ─────────────────────────
router.use(authenticateToken);

console.log('✅ Group Members routes initialized (v2.0.0 FIXED)');

// ============================================================================
// ── USER-LEVEL INVITATION ROUTES ─────────────────────────────────────────────
// CRITICAL: These MUST come BEFORE /:groupId routes.
// Express matches routes in order; if /:groupId comes first, the string
// "invitations" is treated as a groupId and the wrong handler fires.
// ============================================================================

// GET /api/group-members/invitations?status=pending  — received invites for the current user
router.get('/invitations', apiRateLimiter, groupMembersController.getUserInvitations);

// FIX: Added missing /invitations/:invitationId routes before /:groupId
// Accept an invitation (invitee accepts)
router.post('/invitations/:invitationId/accept', apiRateLimiter, groupMembersController.acceptInvitation);

// Reject an invitation (invitee rejects)
router.post('/invitations/:invitationId/reject', apiRateLimiter, groupMembersController.rejectInvitation);

// Cancel an invitation (inviter or admin cancels)
router.delete('/invitations/:invitationId', apiRateLimiter, groupMembersController.cancelInvitation);

// ============================================================================
// ── GROUP-SCOPED ROUTES ───────────────────────────────────────────────────────
// ============================================================================

// ── Members ──────────────────────────────────────────────────────────────────

// Get group members (with pagination, filtering, search)
router.get('/:groupId/members', apiRateLimiter, groupMembersController.getGroupMembers);

// Add a member directly (admin only, bypasses invitation for non-approval groups)
router.post('/:groupId/members', apiRateLimiter, groupMembersController.addMemberToGroup);

// Remove a member
router.delete('/:groupId/members/:memberId', apiRateLimiter, groupMembersController.removeMemberFromGroup);

// Update member role (PUT and PATCH both accepted)
router.put('/:groupId/members/:memberId/role',   apiRateLimiter, groupMembersController.updateMemberRole);
router.patch('/:groupId/members/:memberId/role', apiRateLimiter, groupMembersController.updateMemberRole);

// Get member details
router.get('/:groupId/members/:memberId', apiRateLimiter, groupMembersController.getMemberDetails);

// ── Moderation ────────────────────────────────────────────────────────────────

// Mute member
router.post('/:groupId/members/:memberId/mute', apiRateLimiter, groupMembersController.muteMember);

// Unmute member
router.delete('/:groupId/members/:memberId/mute', apiRateLimiter, groupMembersController.unmuteMember);

// Ban member
router.post('/:groupId/members/:memberId/ban', apiRateLimiter, groupMembersController.banMember);

// Unban member
router.delete('/:groupId/members/:memberId/ban', apiRateLimiter, groupMembersController.unbanMember);

// ── Analytics & utilities ────────────────────────────────────────────────────

// Get member statistics (admin only)
router.get('/:groupId/statistics', apiRateLimiter, groupMembersController.getMemberStatistics);

// Search members
router.get('/:groupId/members/search', apiRateLimiter, groupMembersController.searchMembers);

// Get member activity
router.get('/:groupId/members/:memberId/activity', apiRateLimiter, groupMembersController.getMemberActivity);

// Export members list (admin only)
router.get('/:groupId/members/export', apiRateLimiter, groupMembersController.exportMembersList);

// ── Group-scoped invitation routes ────────────────────────────────────────────

// Get pending invitations for a group (admin view)
router.get('/:groupId/invitations', apiRateLimiter, groupMembersController.getPendingInvitations);

// Invite a user to the group (sends invite or adds directly)
router.post('/:groupId/invitations', apiRateLimiter, groupMembersController.inviteToGroup);

// FIX: Added sent invitations route (was in controller, missing from routes)
router.get('/:groupId/invitations/sent', apiRateLimiter, groupMembersController.getSentInvitations);

// ── Membership actions ────────────────────────────────────────────────────────

// Leave group
router.post('/:groupId/leave', apiRateLimiter, groupMembersController.leaveGroup);

// Transfer group ownership
router.post('/:groupId/transfer', apiRateLimiter, groupMembersController.transferOwnership);

// ── Additional member queries ─────────────────────────────────────────────────

// Get banned members
router.get('/:groupId/banned', apiRateLimiter, groupMembersController.getBannedMembers);

// Get online members
router.get('/:groupId/online', apiRateLimiter, groupMembersController.getOnlineMembers);

module.exports = router;