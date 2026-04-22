// groupController.js — v2.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ addMember / removeMember responses now include withLocalSyncMeta()
//     so client calls LocalGroupStore.saveMemberLocal() from HTTP response
//   ✔ addMember / removeMember emit 'group:localSync' via socket
//   ✔ getUserGroups endpoint added (was missing — requestGroupList() in
//     group-core.js calls GET /groups/user which had no handler)
//   ✔ groupMutation socket push correctly emits to group room AND user room
//   ✔ Consistent error handling via shared handleError() helper
// ============================================================

const groupService = require('../services/groupService');
const { groupServiceEvents } = groupService;
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ── LOCAL-FIRST SYNC HOOK ─────────────────────────────────────────────────────
groupServiceEvents.on('groupMutation', ({ action, group, groupId, userId }) => {
    try {
        const io = global.__socketIO;
        if (!io) return;

        const payload = { action, group: group || null, groupId: groupId || group?.id };

        // Push to the affected user
        if (userId) {
            io.to(`user:${userId}`).emit('group:localSync', payload);
        }

        // Push to all group members for group-level events
        const gid = groupId || group?.id;
        if (gid) {
            io.to(`group:${gid}`).emit('group:localSync', payload);
        }
    } catch (err) {
        logger.warn('[GroupController] localSync push failed:', err.message);
    }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function withLocalSyncMeta(data, action = 'upsert') {
    return { ...data, _localSync: { action, timestamp: Date.now() } };
}

function handleError(error, next, context) {
    logger.error(`${context} error:`, error);
    if (error instanceof AppError) return next(error);
    const msg = error.message || '';
    if (error.name === 'ValidationError')                              return next(new AppError(msg, 400));
    if (error.code === 11000)                                          return next(new AppError('Group with this name already exists', 409));
    if (msg.includes('not found'))                                     return next(new AppError(msg, 404));
    if (msg.includes('not authorized') || msg.includes('permission')) return next(new AppError(msg, 403));
    if (msg.includes('already') || msg.includes('already a member')) return next(new AppError(msg, 409));
    if (msg.includes('cannot remove') || msg.includes('creator'))     return next(new AppError(msg, 400));
    return next(new AppError(`${context} failed`, 500));
}

class GroupController {

    // ── CREATE GROUP ───────────────────────────────────────────────────────
    async createGroup(req, res, next) {
        try {
            const userId = req.user.id;
            const { name, description, avatar, members, memberIds, privacy, settings } = req.body;
            if (!name) throw new AppError('Group name is required', 400);

            // Merge members + memberIds, always include creator
            const allMemberIds = [...new Set([
                String(userId),
                ...(members   || []).map(String),
                ...(memberIds || []).map(String)
            ])].filter(Boolean);

            const group = await groupService.createGroup({
                name, description, avatar, creatorId: userId,
                members: allMemberIds, privacy: privacy || 'public', settings: settings || {},
            });

            const io = global.__socketIO;
            if (io && group?.id) {
                const payload = { group, createdBy: userId, timestamp: new Date() };

                // Notify every member via their personal room so they see
                // the new group appear in real-time without a page reload.
                allMemberIds.forEach(uid => {
                    io.to(`user:${uid}`).emit('group:created', payload);
                    io.to(`user:${uid}`).emit('group:localSync', { action: 'create', group, groupId: group.id });
                });

                // Also emit to the group room for any already-subscribed sockets
                io.to(`group:${group.id}`).emit('group:created', payload);
                io.to(`group:${group.id}`).emit('group:localSync', { action: 'create', group, groupId: group.id });

                logger.info(`[GROUP FLOW] WebSocket emitted group:created for group ${group.id} to ${allMemberIds.length} member(s)`);
            }

            // Return flat shape: data.group (not data.group.group)
            res.status(201).json({
                success: true,
                message: 'Group created successfully',
                data: {
                    group,
                    _localSync: { action: 'create', timestamp: Date.now() }
                },
            });
        } catch (error) { handleError(error, next, 'createGroup'); }
    }

    // ── GET GROUP BY ID ────────────────────────────────────────────────────
    async getGroupById(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const group = await groupService.getGroupById(groupId, userId);
            res.status(200).json({ success: true, message: 'Group retrieved successfully', data: { group } });
        } catch (error) { handleError(error, next, 'getGroupById'); }
    }

    // ── GET USER GROUPS (FIX: was missing — group-core calls GET /groups/user) ──
    async getUserGroups(req, res, next) {
        try {
            const userId = req.user.id;
            const options = {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
            };

            const result = await groupService.getUserGroups(userId, options);
            const groups = result.groups || [];

            const myGroups     = groups.filter(g => String(g.createdBy) === String(userId) || g.isCreator);
            const adminGroups  = groups.filter(g => g.isAdmin || g.isCreator);
            const joinedGroups = groups.filter(g => !g.isCreator && !g.isAdmin);

            // Ensure the user's socket is in every group room so they receive
            // group:message events in real-time without a separate join step.
            const io = global.__socketIO;
            if (io && groups.length) {
                const userRoom = io.sockets.adapter.rooms?.get(`user:${userId}`);
                if (userRoom) {
                    userRoom.forEach(socketId => {
                        const socket = io.sockets.sockets?.get(socketId);
                        if (socket) groups.forEach(g => g.id && socket.join(`group:${g.id}`));
                    });
                }
            }

            res.status(200).json({
                success: true,
                message: 'User groups retrieved successfully',
                data: {
                    groups,
                    myGroups,
                    adminGroups,
                    joinedGroups,
                    pagination: result.pagination,
                    _localSync: { action: 'sync', timestamp: Date.now() },
                },
            });
        } catch (error) { handleError(error, next, 'getUserGroups'); }
    }

    // ── UPDATE GROUP ───────────────────────────────────────────────────────
    async updateGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const updateData = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!updateData || typeof updateData !== 'object') throw new AppError('Update data is required', 400);

            const group = await groupService.updateGroup(groupId, userId, updateData);
            res.status(200).json({
                success: true,
                message: 'Group updated successfully',
                data: withLocalSyncMeta({ group }, 'update'),
            });
        } catch (error) { handleError(error, next, 'updateGroup'); }
    }

    // ── DELETE GROUP ───────────────────────────────────────────────────────
    async deleteGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            await groupService.deleteGroup(groupId, userId);
            res.status(200).json({
                success: true,
                message: 'Group deleted successfully',
                data: withLocalSyncMeta({ groupId }, 'delete'),
            });
        } catch (error) { handleError(error, next, 'deleteGroup'); }
    }

    // ── ADD MEMBER ─────────────────────────────────────────────────────────
    // FIX: Now includes withLocalSyncMeta + socket emission for member_add
    async addMember(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { memberId, role = 'member' } = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!memberId) throw new AppError('Member ID is required', 400);

            const membership = await groupService.addMember(groupId, userId, memberId, role);

            const member = {
                id      : membership?.id || `${groupId}_${memberId}`,
                groupId,
                userId  : memberId,
                role    : membership?.role || role,
                joinedAt: membership?.joinedAt || new Date().toISOString(),
            };

            // FIX: Emit socket so browsers call saveMemberLocal immediately
            const io = global.__socketIO;
            if (io) {
                io.to(`group:${groupId}`).emit('group:member:added', {
                    groupId, memberId, addedBy: userId, role, member, timestamp: new Date(),
                });
                io.to(`group:${groupId}`).emit('group:localSync', {
                    action: 'member_add', groupId, member,
                });
                io.to(`user:${memberId}`).emit('group:localSync', {
                    action: 'member_add', groupId, member,
                });
            }

            res.status(200).json({
                success: true,
                message: 'Member added successfully',
                data: withLocalSyncMeta({ member, groupId }, 'member_add'),
            });
        } catch (error) { handleError(error, next, 'addMember'); }
    }

    // ── REMOVE MEMBER ──────────────────────────────────────────────────────
    // FIX: Now includes withLocalSyncMeta + socket emission for member_remove
    async removeMember(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            await groupService.removeMember(groupId, userId, memberId);

            // FIX: Emit socket so browsers call deleteMemberLocal immediately
            const io = global.__socketIO;
            if (io) {
                io.to(`group:${groupId}`).emit('group:member:removed', {
                    groupId, memberId, removedBy: userId, timestamp: new Date(),
                });
                io.to(`group:${groupId}`).emit('group:localSync', {
                    action: 'member_remove', groupId, userId: memberId,
                });
                io.to(`user:${memberId}`).emit('group:localSync', {
                    action: 'member_remove', groupId, userId: memberId,
                });
            }

            res.status(200).json({
                success: true,
                message: 'Member removed successfully',
                data: withLocalSyncMeta({ groupId, memberId, removed: true }, 'member_remove'),
            });
        } catch (error) { handleError(error, next, 'removeMember'); }
    }

    // ── UPDATE MEMBER ROLE ─────────────────────────────────────────────────
    async updateMemberRole(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = req.user.id;
            const { role } = req.body;
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);
            if (!role) throw new AppError('Role is required', 400);

            const membership = await groupService.updateMemberRole(groupId, userId, memberId, role);
            const member = {
                id: membership?.id || `${groupId}_${memberId}`,
                groupId, userId: memberId, role: membership?.role || role,
            };

            const io = global.__socketIO;
            if (io) {
                io.to(`group:${groupId}`).emit('group:member:role:updated', {
                    groupId, memberId, newRole: role, updatedBy: userId, member, timestamp: new Date(),
                });
                io.to(`group:${groupId}`).emit('group:localSync', {
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

    // ── LEAVE GROUP ────────────────────────────────────────────────────────
    async leaveGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            await groupService.leaveGroup(groupId, userId);

            const io = global.__socketIO;
            if (io) {
                io.to(`group:${groupId}`).emit('group:member:left', { groupId, memberId: userId, timestamp: new Date() });
                io.to(`user:${userId}`).emit('group:localSync', { action: 'member_leave', groupId, userId });
            }

            res.status(200).json({
                success: true,
                message: 'Successfully left the group',
                data: withLocalSyncMeta({ left: true, groupId }, 'member_leave'),
            });
        } catch (error) { handleError(error, next, 'leaveGroup'); }
    }

    // ── GET USER GROUPS (paginated) ────────────────────────────────────────
    async getGroups(req, res, next) {
        // Alias so both /groups and /groups/user hit the same handler
        return this.getUserGroups(req, res, next);
    }

    // ── SEARCH GROUPS ──────────────────────────────────────────────────────
    async searchGroups(req, res, next) {
        try {
            const userId = req.user.id;
            const { query = '', page = 1, limit = 20, privacy } = req.query;
            const result = await groupService.searchGroups(userId, { query, page: parseInt(page), limit: parseInt(limit), privacy });
            res.status(200).json({ success: true, message: 'Groups search completed', data: result });
        } catch (error) { handleError(error, next, 'searchGroups'); }
    }

    // ── GET GROUP MEMBERS ──────────────────────────────────────────────────
    async getGroupMembers(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const result = await groupService.getGroupMembers(groupId, userId, req.query);
            res.status(200).json({ success: true, message: 'Group members retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getGroupMembers'); }
    }

    // ── UPDATE GROUP SETTINGS ──────────────────────────────────────────────
    async updateGroupSettings(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const group = await groupService.updateGroupSettings(groupId, userId, req.body);
            res.status(200).json({
                success: true,
                message: 'Group settings updated successfully',
                data: withLocalSyncMeta({ group }, 'update'),
            });
        } catch (error) { handleError(error, next, 'updateGroupSettings'); }
    }

    // ── TRANSFER OWNERSHIP ─────────────────────────────────────────────────
    async transferOwnership(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { newOwnerId } = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!newOwnerId) throw new AppError('New owner ID is required', 400);

            const result = await groupService.transferOwnership(groupId, userId, newOwnerId);
            res.status(200).json({
                success: true,
                message: 'Group ownership transferred successfully',
                data: withLocalSyncMeta({ result }, 'update'),
            });
        } catch (error) { handleError(error, next, 'transferOwnership'); }
    }

    // ── GET GROUP STATISTICS ───────────────────────────────────────────────
    async getGroupStatistics(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const statistics = await groupService.getGroupStatistics(groupId, userId);
            res.status(200).json({ success: true, message: 'Group statistics retrieved successfully', data: { statistics } });
        } catch (error) { handleError(error, next, 'getGroupStatistics'); }
    }

    // ── ARCHIVE GROUP ──────────────────────────────────────────────────────
    async archiveGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { archived = true } = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);

            const group = await groupService.archiveGroup(groupId, userId, archived);
            res.status(200).json({
                success: true,
                message: `Group ${archived ? 'archived' : 'unarchived'} successfully`,
                data: withLocalSyncMeta({ group }, archived ? 'archive' : 'unarchive'),
            });
        } catch (error) { handleError(error, next, 'archiveGroup'); }
    }

    // ── GET GROUP INVITATIONS ──────────────────────────────────────────────
    async getGroupInvitations(req, res, next) {
        try {
            const userId = req.user.id;
            const { page = 1, limit = 20, status = 'pending' } = req.query;
            const options = { page: parseInt(page), limit: parseInt(limit), status };
            if (options.page < 1 || options.limit < 1 || options.limit > 50) throw new AppError('Invalid pagination parameters', 400);

            const result = await groupService.getGroupInvitations(userId, options);
            res.status(200).json({ success: true, message: 'Group invitations retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getGroupInvitations'); }
    }

    // ── SEND INVITATION ────────────────────────────────────────────────────
    async sendInvitation(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = req.user.id;
            const { inviteeId, role = 'member', message } = req.body;
            if (!groupId) throw new AppError('Group ID is required', 400);
            if (!inviteeId) throw new AppError('Invitee ID is required', 400);

            const invitation = await groupService.sendInvitation(groupId, userId, inviteeId, role, message);

            const io = global.__socketIO;
            if (io && inviteeId) {
                io.to(`user:${inviteeId}`).emit('group:invitation:received', {
                    groupId, invitationId: invitation?.id, invitedBy: userId, role, message, timestamp: new Date(),
                });
            }

            res.status(201).json({ success: true, message: 'Invitation sent successfully', data: { invitation } });
        } catch (error) { handleError(error, next, 'sendInvitation'); }
    }

    // ── RESPOND TO INVITATION ──────────────────────────────────────────────
    async respondToInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = req.user.id;
            const { accept } = req.body;
            if (!invitationId) throw new AppError('Invitation ID is required', 400);
            if (typeof accept !== 'boolean') throw new AppError('Accept status is required (true/false)', 400);

            const result = await groupService.respondToInvitation(invitationId, userId, accept);

            if (accept) {
                const io = global.__socketIO;
                if (io && result.group?.id) {
                    io.to(`group:${result.group.id}`).emit('group:member:joined', {
                        groupId: result.group.id, memberId: userId, viaInvitation: true, timestamp: new Date(),
                    });
                }
            }

            res.status(200).json({
                success: true,
                message: `Invitation ${accept ? 'accepted' : 'declined'} successfully`,
                data: { accepted: accept, group: accept ? result.group : null },
            });
        } catch (error) { handleError(error, next, 'respondToInvitation'); }
    }

    // ── CANCEL INVITATION ──────────────────────────────────────────────────
    async cancelInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = req.user.id;
            if (!invitationId) throw new AppError('Invitation ID is required', 400);

            await groupService.cancelInvitation(invitationId, userId);
            res.status(200).json({ success: true, message: 'Invitation cancelled successfully', data: null });
        } catch (error) { handleError(error, next, 'cancelInvitation'); }
    }
}

module.exports = new GroupController();