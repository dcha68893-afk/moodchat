const express = require('express');
const router = express.Router();
const groupMembersController = require('../controllers/groupMembersController');
// FIXED: Import the unified authentication middleware
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// FIXED: Use the unified authentication middleware
router.use(authenticateToken);

console.log('✅ Group Members routes initialized');

// Get group members
router.get('/:groupId/members', apiRateLimiter, groupMembersController.getGroupMembers);

// Add member to group
router.post('/:groupId/members', apiRateLimiter, groupMembersController.addMemberToGroup);

// Remove member from group
router.delete('/:groupId/members/:memberId', apiRateLimiter, groupMembersController.removeMemberFromGroup);

// Update member role
router.put('/:groupId/members/:memberId/role', apiRateLimiter, groupMembersController.updateMemberRole);

// Get member details
router.get('/:groupId/members/:memberId', apiRateLimiter, groupMembersController.getMemberDetails);

// Get pending invitations
router.get('/:groupId/invitations', apiRateLimiter, groupMembersController.getPendingInvitations);

// Invite user to group
router.post('/:groupId/invitations', apiRateLimiter, groupMembersController.inviteToGroup);

// Accept group invitation
router.post('/invitations/:invitationId/accept', apiRateLimiter, groupMembersController.acceptInvitation);

// Reject group invitation
router.post('/invitations/:invitationId/reject', apiRateLimiter, groupMembersController.rejectInvitation);

// Cancel invitation
router.delete('/invitations/:invitationId', apiRateLimiter, groupMembersController.cancelInvitation);

// Leave group
router.post('/:groupId/leave', apiRateLimiter, groupMembersController.leaveGroup);

// Transfer group ownership
router.post('/:groupId/transfer', apiRateLimiter, groupMembersController.transferOwnership);

// Get member statistics
router.get('/:groupId/statistics', apiRateLimiter, groupMembersController.getMemberStatistics);

// Search members
router.get('/:groupId/members/search', apiRateLimiter, groupMembersController.searchMembers);

// Mute member
router.post('/:groupId/members/:memberId/mute', apiRateLimiter, groupMembersController.muteMember);

// Unmute member
router.delete('/:groupId/members/:memberId/mute', apiRateLimiter, groupMembersController.unmuteMember);

// Ban member
router.post('/:groupId/members/:memberId/ban', apiRateLimiter, groupMembersController.banMember);

// Unban member
router.delete('/:groupId/members/:memberId/ban', apiRateLimiter, groupMembersController.unbanMember);

// Get banned members
router.get('/:groupId/banned', apiRateLimiter, groupMembersController.getBannedMembers);

// Get online members
router.get('/:groupId/online', apiRateLimiter, groupMembersController.getOnlineMembers);

// Get member activity
router.get('/:groupId/members/:memberId/activity', apiRateLimiter, groupMembersController.getMemberActivity);

// Export members list
router.get('/:groupId/members/export', apiRateLimiter, groupMembersController.exportMembersList);

module.exports = router;