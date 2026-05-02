// groupMembersController.js — v2.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ Requires groupMembersService (now exists — was missing)
//   ✔ Subscribes to memberServiceEvents → pushes 'group:localSync' via socket
//     so the client immediately calls LocalGroupStore.saveMemberLocal()
//   ✔ All mutation responses include _localSync metadata so the HTTP fetch
//     caller can persist locally without waiting for the next socket event
//   ✔ inviteToGroup uses both inviteeId and targetUserId field names
//   ✔ getUserInvitations route correctly placed BEFORE /:groupId routes
// ============================================================

const groupMembersService = require('../services/groupMembersService');
const { memberServiceEvents } = groupMembersService;
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ── LOCAL-FIRST SYNC HOOK ─────────────────────────────────────────────────────
// Every DB mutation in groupMembersService emits 'memberMutation'.
// We forward it to connected sockets so the browser's LocalGroupStore is
// updated immediately — same pattern as groupController.js.
memberServiceEvents.on('memberMutation', ({ action, groupId, member, userId, requestedBy, newOwnerId }) => {
    try {
        const io = global.__socketIO;
        if (!io) return;

        // FIX: Always use prefixed action so group-core_patch.js socket handler matches
        const prefixedAction = action.startsWith('member_') ? action : `member_${action}`;
        const targetUserId = userId || member?.userId || newOwnerId;

        // FIX: Build one consistent payload used for both rooms
        const payload = {
            action  : prefixedAction,
            groupId,
            member  : member || null,
            userId  : targetUserId || null,   // FIX: was undefined for 'remove' action
        };

        if (groupId) {
            io.to(`group:${groupId}`).emit('group:localSync', payload);
        }

        if (targetUserId) {
            io.to(`user:${targetUserId}`).emit('group:localSync', payload);
        }
    } catch (err) {
        logger.warn('[GroupMembersController] localSync push failed:', err.message);
    }
});

// ── RESPONSE HELPERS ──────────────────────────────────────────────────────────
function withLocalSyncMeta(data, action = 'upsert') {
    return { ...data, _localSync: { action, timestamp: Date.now() } };
}

function handleError(error, next, context) {
    logger.error(`${context} error:`, error);
    if (error instanceof AppError) return next(error);

    const msg = error.message || '';
    if (msg.includes('not found') || msg.includes('not a member'))  return next(new AppError(msg, 404));
    if (msg.includes('not authorized') || msg.includes('permission')) return next(new AppError(msg, 403));
    if (msg.includes('already') || msg.includes('already a member')) return next(new AppError(msg, 409));
    if (msg.includes('banned'))                                       return next(new AppError(msg, 403));
    if (msg.includes('maximum') || msg.includes('cannot'))           return next(new AppError(msg, 400));
    if (error.name === 'ValidationError')                             return next(new AppError(msg, 400));
    return next(new AppError(`${context} failed`, 500));
}

class GroupMembersController {

    // ── GET MEMBERS ────────────────────────────────────────────────────────
    async getGroupMembers(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const options = {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                role: req.query.role,
                onlineOnly: req.query.onlineOnly === 'true',
                search: req.query.search,
                sortBy: req.query.sortBy || 'joinedAt',
                sortOrder: req.query.sortOrder || 'desc',
            };
            if (options.page < 1 || options.limit < 1 || options.limit > 100) {
                throw new AppError('Invalid pagination parameters', 400);
            }

            const result = await groupMembersService.getGroupMembers(groupId, userId, options);
            res.status(200).json({ success: true, message: 'Group members retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getGroupMembers'); }
    }

    // ── ADD MEMBER ─────────────────────────────────────────────────────────
    async addMemberToGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { memberId, role = 'member', sendNotification = true } = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!memberId) throw new AppError('Member ID is required', 400);

            const member = await groupMembersService.addMemberToGroup(groupId, userId, memberId, role, sendNotification);

            // FIX: Emit socket event AND include _localSync in HTTP response
            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:member:added', {
                    groupId, memberId, addedBy: userId, role, member,
                    timestamp: new Date(),
                });
                req.io.to(`user:${memberId}`).emit('group:localSync', {
                    action: 'member_add', groupId, member,
                });
            }

            res.status(201).json({
                success: true,
                message: 'Member added to group successfully',
                data: withLocalSyncMeta({ member, groupId }, 'member_add'),
            });
        } catch (error) { handleError(error, next, 'addMemberToGroup'); }
    }

    // ── REMOVE MEMBER ──────────────────────────────────────────────────────
    async removeMemberFromGroup(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            const { reason } = req.body;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const result = await groupMembersService.removeMemberFromGroup(groupId, userId, memberId, reason);

            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:member:removed', {
                    groupId, memberId, removedBy: userId, reason, timestamp: new Date(),
                });
                req.io.to(`user:${memberId}`).emit('group:localSync', {
                    action: 'member_remove', groupId, userId: memberId,
                });
            }

            res.status(200).json({
                success: true,
                message: 'Member removed from group successfully',
                data: withLocalSyncMeta({ ...result, groupId, memberId }, 'member_remove'),
            });
        } catch (error) { handleError(error, next, 'removeMemberFromGroup'); }
    }

    // ── UPDATE ROLE ────────────────────────────────────────────────────────
    async updateMemberRole(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            const { role } = req.body;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);
            if (!role) throw new AppError('Role is required', 400);

            const validRoles = ['member', 'moderator', 'admin', 'owner'];
            if (!validRoles.includes(role)) throw new AppError(`Invalid role. Valid: ${validRoles.join(', ')}`, 400);

            const member = await groupMembersService.updateMemberRole(groupId, userId, memberId, role);

            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:member:role:updated', {
                    groupId, memberId, newRole: role, updatedBy: userId, member, timestamp: new Date(),
                });
                req.io.to(`user:${memberId}`).emit('group:localSync', {
                    action: 'member_role_update', groupId, member,
                });
            }

            res.status(200).json({
                success: true,
                message: 'Member role updated successfully',
                data: withLocalSyncMeta({ member, groupId }, 'member_role_update'),
            });
        } catch (error) { handleError(error, next, 'updateMemberRole'); }
    }

    // ── GET MEMBER DETAILS ─────────────────────────────────────────────────
    async getMemberDetails(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const member = await groupMembersService.getMemberDetails(groupId, memberId, userId);
            res.status(200).json({ success: true, message: 'Member details retrieved successfully', data: { member } });
        } catch (error) { handleError(error, next, 'getMemberDetails'); }
    }

    // ── GET PENDING INVITATIONS ────────────────────────────────────────────
    async getPendingInvitations(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const options = {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                sortBy: req.query.sortBy || 'createdAt',
                sortOrder: req.query.sortOrder || 'desc',
            };
            if (options.page < 1 || options.limit < 1 || options.limit > 100) {
                throw new AppError('Invalid pagination parameters', 400);
            }

            const result = await groupMembersService.getPendingInvitations(groupId, userId, options);
            res.status(200).json({ success: true, message: 'Pending invitations retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getPendingInvitations'); }
    }

    // ── INVITE TO GROUP ────────────────────────────────────────────────────
    async inviteToGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            // FIX: Accept both field name conventions from frontend
            const inviteeId = req.body.inviteeId || req.body.targetUserId;
            const role    = req.body.role    || 'member';
            const message = req.body.message || '';

            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!inviteeId) throw new AppError('Invitee ID is required', 400);

            const result = await groupMembersService.inviteToGroup(groupId, userId, inviteeId, role, message);
            const action = result?.action || 'invite_sent';

            if (req.io) {
                if (action === 'member_added') {
                    req.io.to(`group:${groupId}`).emit('group:member:added', {
                        groupId, memberId: inviteeId, addedBy: userId, role,
                        member: result.member, timestamp: new Date(),
                    });
                    req.io.to(`user:${inviteeId}`).emit('group:localSync', {
                        action: 'member_add', groupId, member: result.member,
                    });
                } else {
                    req.io.to(`user:${inviteeId}`).emit('group:invitation:received', {
                        groupId,
                        invitationId: result?.invitation?.id,
                        invitedBy: userId, role, message,
                        timestamp: new Date(),
                    });
                }
            }

            const statusCode = action === 'member_added' ? 200 : 201;
            const responseMessage = action === 'member_added'
                ? 'Member added to group successfully'
                : action === 'already_member'
                    ? 'User is already a member of this group'
                    : 'Invitation sent successfully';

            res.status(statusCode).json({
                success: true,
                message: responseMessage,
                data: withLocalSyncMeta({ action, ...result }, action === 'member_added' ? 'member_add' : 'invite_sent'),
            });
        } catch (error) { handleError(error, next, 'inviteToGroup'); }
    }

    // ── ACCEPT INVITATION ──────────────────────────────────────────────────
    async acceptInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = req.user.id;
            if (!invitationId) throw new AppError('Invitation ID is required', 400);

            const result = await groupMembersService.acceptInvitation(invitationId, userId);

            if (req.io) {
                // Notify all current group members that someone joined
                req.io.to(`group:${result.groupId}`).emit('group:member:joined', {
                    groupId: result.groupId, memberId: userId, viaInvitation: true, timestamp: new Date(),
                });
                req.io.to(`group:${result.groupId}`).emit('GROUP_MEMBER_ADDED', {
                    groupId: result.groupId, member: result.member, userId, timestamp: new Date(),
                });
                req.io.to(`group:${result.groupId}`).emit('group:localSync', {
                    action: 'member_add', groupId: result.groupId, member: result.member,
                });
                // FIX: Notify the accepted user directly so their group list refreshes
                req.io.to(`user:${userId}`).emit('GROUP_MEMBER_ADDED', {
                    groupId: result.groupId, member: result.member, userId, timestamp: new Date(),
                });
                req.io.to(`user:${userId}`).emit('group:localSync', {
                    action: 'member_add', groupId: result.groupId, member: result.member,
                });
                req.io.to(`user:${userId}`).emit('group:refresh_needed', {
                    reason: 'invitation_accepted', groupId: result.groupId,
                });
                if (result.invitedBy) {
                    req.io.to(`user:${result.invitedBy}`).emit('group:invitation:accepted', {
                        groupId: result.groupId, inviteeId: userId, invitationId, timestamp: new Date(),
                    });
                }
            }

            res.status(200).json({
                success: true,
                message: 'Invitation accepted successfully',
                data: withLocalSyncMeta({ ...result, accepted: true }, 'member_add'),
            });
        } catch (error) { handleError(error, next, 'acceptInvitation'); }
    }

    // ── REJECT INVITATION ──────────────────────────────────────────────────
    async rejectInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = req.user.id;
            const { reason } = req.body;
            if (!invitationId) throw new AppError('Invitation ID is required', 400);

            const result = await groupMembersService.rejectInvitation(invitationId, userId, reason);

            if (req.io && result.invitedBy) {
                req.io.to(`user:${result.invitedBy}`).emit('group:invitation:rejected', {
                    groupId: result.groupId, inviteeId: userId, invitationId, reason, timestamp: new Date(),
                });
            }

            res.status(200).json({
                success: true,
                message: 'Invitation rejected successfully',
                data: { ...result, rejected: true },
            });
        } catch (error) { handleError(error, next, 'rejectInvitation'); }
    }

    // ── CANCEL INVITATION ──────────────────────────────────────────────────
    async cancelInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = req.user.id;
            if (!invitationId) throw new AppError('Invitation ID is required', 400);

            const result = await groupMembersService.cancelInvitation(invitationId, userId);

            if (req.io && result.inviteeId) {
                req.io.to(`user:${result.inviteeId}`).emit('group:invitation:cancelled', {
                    groupId: result.groupId, invitationId, cancelledBy: userId, timestamp: new Date(),
                });
            }

            res.status(200).json({
                success: true,
                message: 'Invitation cancelled successfully',
                data: { ...result, cancelled: true },
            });
        } catch (error) { handleError(error, next, 'cancelInvitation'); }
    }

    // ── LEAVE GROUP ────────────────────────────────────────────────────────
    async leaveGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const result = await groupMembersService.leaveGroup(groupId, userId);

            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:member:left', {
                    groupId, memberId: userId, timestamp: new Date(),
                });
                req.io.to(`user:${userId}`).emit('group:localSync', {
                    action: 'member_leave', groupId, userId,
                });
            }

            res.status(200).json({
                success: true,
                message: 'Successfully left the group',
                data: withLocalSyncMeta({ ...result, left: true }, 'member_leave'),
            });
        } catch (error) { handleError(error, next, 'leaveGroup'); }
    }

    // ── TRANSFER OWNERSHIP ─────────────────────────────────────────────────
    async transferOwnership(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { newOwnerId } = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!newOwnerId) throw new AppError('New owner ID is required', 400);

            const result = await groupMembersService.transferOwnership(groupId, userId, newOwnerId);

            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:ownership:transferred', {
                    groupId, previousOwnerId: userId, newOwnerId, timestamp: new Date(),
                });
                req.io.to(`group:${groupId}`).emit('group:localSync', {
                    action: 'ownership_transfer', groupId, newOwnerId,
                });
            }

            res.status(200).json({
                success: true,
                message: 'Group ownership transferred successfully',
                data: withLocalSyncMeta({ ...result, transferred: true }, 'ownership_transfer'),
            });
        } catch (error) { handleError(error, next, 'transferOwnership'); }
    }

    // ── MEMBER STATISTICS ──────────────────────────────────────────────────
    async getMemberStatistics(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const statistics = await groupMembersService.getMemberStatistics(groupId, userId);
            res.status(200).json({ success: true, message: 'Member statistics retrieved successfully', data: { statistics } });
        } catch (error) { handleError(error, next, 'getMemberStatistics'); }
    }

    // ── SEARCH MEMBERS ─────────────────────────────────────────────────────
    async searchMembers(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { query, page = 1, limit = 20, role, onlineOnly = false, sortBy = 'relevance', sortOrder = 'desc' } = req.query;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!query) throw new AppError('Search query is required', 400);

            const options = { query, page: parseInt(page), limit: parseInt(limit), role, onlineOnly: onlineOnly === 'true', sortBy, sortOrder };
            if (options.page < 1 || options.limit < 1 || options.limit > 50) throw new AppError('Invalid pagination parameters', 400);

            const result = await groupMembersService.searchMembers(groupId, userId, options);
            res.status(200).json({ success: true, message: 'Members search completed successfully', data: result });
        } catch (error) { handleError(error, next, 'searchMembers'); }
    }

    // ── MUTE MEMBER ────────────────────────────────────────────────────────
    async muteMember(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            const { duration, reason } = req.body;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const result = await groupMembersService.muteMember(groupId, userId, memberId, duration, reason);

            if (req.io) {
                req.io.to(`user:${memberId}`).emit('group:member:muted', {
                    groupId, memberId, mutedBy: userId, duration, reason, mutedUntil: result.mutedUntil, timestamp: new Date(),
                });
            }

            res.status(200).json({ success: true, message: 'Member muted successfully', data: result });
        } catch (error) { handleError(error, next, 'muteMember'); }
    }

    // ── UNMUTE MEMBER ──────────────────────────────────────────────────────
    async unmuteMember(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const result = await groupMembersService.unmuteMember(groupId, userId, memberId);

            if (req.io) {
                req.io.to(`user:${memberId}`).emit('group:member:unmuted', {
                    groupId, memberId, unmutedBy: userId, timestamp: new Date(),
                });
            }

            res.status(200).json({ success: true, message: 'Member unmuted successfully', data: result });
        } catch (error) { handleError(error, next, 'unmuteMember'); }
    }

    // ── BAN MEMBER ─────────────────────────────────────────────────────────
    async banMember(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            const { duration, reason } = req.body;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const ban = await groupMembersService.banMember(groupId, userId, memberId, duration, reason);

            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:member:banned', {
                    groupId, memberId, bannedBy: userId, duration, reason, expiresAt: ban.expiresAt, timestamp: new Date(),
                });
                req.io.to(`user:${memberId}`).emit('group:you:banned', {
                    groupId, bannedBy: userId, reason, expiresAt: ban.expiresAt, timestamp: new Date(),
                });
                req.io.to(`group:${groupId}`).emit('group:localSync', {
                    action: 'member_remove', groupId, userId: memberId,
                });
            }

            res.status(200).json({ success: true, message: 'Member banned successfully', data: { ban } });
        } catch (error) { handleError(error, next, 'banMember'); }
    }

    // ── UNBAN MEMBER ───────────────────────────────────────────────────────
    async unbanMember(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const result = await groupMembersService.unbanMember(groupId, userId, memberId);

            if (req.io) {
                req.io.to(`group:${groupId}`).emit('group:member:unbanned', {
                    groupId, memberId, unbannedBy: userId, timestamp: new Date(),
                });
                req.io.to(`user:${memberId}`).emit('group:you:unbanned', {
                    groupId, unbannedBy: userId, timestamp: new Date(),
                });
            }

            res.status(200).json({ success: true, message: 'Member unbanned successfully', data: { ...result, unbanned: true } });
        } catch (error) { handleError(error, next, 'unbanMember'); }
    }

    // ── GET BANNED MEMBERS ─────────────────────────────────────────────────
    async getBannedMembers(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const options = {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                activeOnly: req.query.activeOnly !== 'false',
            };
            if (options.page < 1 || options.limit < 1 || options.limit > 100) throw new AppError('Invalid pagination parameters', 400);

            const result = await groupMembersService.getBannedMembers(groupId, userId, options);
            res.status(200).json({ success: true, message: 'Banned members retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getBannedMembers'); }
    }

    // ── GET ONLINE MEMBERS ─────────────────────────────────────────────────
    async getOnlineMembers(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const options = {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                sortBy: req.query.sortBy || 'lastSeen',
                sortOrder: req.query.sortOrder || 'desc',
            };
            if (options.page < 1 || options.limit < 1 || options.limit > 100) throw new AppError('Invalid pagination parameters', 400);

            const result = await groupMembersService.getOnlineMembers(groupId, userId, options);
            res.status(200).json({ success: true, message: 'Online members retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getOnlineMembers'); }
    }

    // ── GET MEMBER ACTIVITY ────────────────────────────────────────────────
    async getMemberActivity(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            const options = {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                startDate: req.query.startDate ? new Date(req.query.startDate) : null,
                endDate: req.query.endDate ? new Date(req.query.endDate) : null,
                activityType: req.query.activityType,
            };
            if (options.page < 1 || options.limit < 1 || options.limit > 100) throw new AppError('Invalid pagination parameters', 400);

            const result = await groupMembersService.getMemberActivity(groupId, memberId, userId, options);
            res.status(200).json({ success: true, message: 'Member activity retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getMemberActivity'); }
    }

    // ── EXPORT MEMBERS LIST ────────────────────────────────────────────────
    async exportMembersList(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { format = 'json', includeRole = 'true', includeJoinDate = 'true', includeLastSeen = 'true', includeActivity = 'false' } = req.query;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const exportData = await groupMembersService.exportMembersList(groupId, userId, {
                format,
                includeRole: includeRole === 'true',
                includeJoinDate: includeJoinDate === 'true',
                includeLastSeen: includeLastSeen === 'true',
                includeActivity: includeActivity === 'true',
            });

            if (format === 'csv') {
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename=group_${groupId}_members_${new Date().toISOString().split('T')[0]}.csv`);
                return res.send(exportData);
            }

            res.status(200).json({ success: true, message: 'Members list exported successfully', data: exportData });
        } catch (error) { handleError(error, next, 'exportMembersList'); }
    }

    // ── GET USER INVITATIONS (cross-group, received by this user) ──────────
    async getUserInvitations(req, res, next) {
        try {
            const userId = req.user.id;
            const { status = 'pending' } = req.query;
            const result = await groupMembersService.getUserInvitations(userId, status);
            res.status(200).json({ success: true, message: 'User invitations retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getUserInvitations'); }
    }

    // ── GET SENT INVITATIONS ───────────────────────────────────────────────
    async getSentInvitations(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);
            const result = await groupMembersService.getSentInvitations(groupId, userId);
            res.status(200).json({ success: true, message: 'Sent invitations retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getSentInvitations'); }
    }
}

module.exports = new GroupMembersController();