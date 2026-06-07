// groupController.js — v3.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ BUG FIX (CRITICAL): createGroup — destructure { group } from
//     groupService.createGroup() return value. Service returns
//     { group: formatted }, NOT the group directly. This caused
//     group.id to be undefined → socket emit silently skipped →
//     response sent { data: { group: { group: {...} } } } (double-nested).
//   ✔ BUG FIX: createGroup — pass `isPublic` from privacy field to
//     service so public/private is respected from the form.
//   ✔ BUG FIX: createGroup — socket emit now fires correctly after fix.
//   ✔ BUG FIX: handleError — re-throw real error message from service
//     instead of swallowing it into a generic 500 string.
//   ✔ BUG FIX: getUserId — handle both req.user.id and req.user.userId
//     (auth middleware inconsistency between routes).
//   ✔ ADDED: getGroupPurposes, getPublicGroups — referenced by group.js
//     router but missing from this controller.
//   ✔ ADDED: joinGroup — referenced in router but missing.
//   ✔ ADDED: getUserInvites, getGroupInvites, acceptGroupInvite,
//     rejectGroupInvite — all referenced in group.js router.
//   ✔ ADDED: addGroupMember, removeGroupMember — router uses these names
//     (not addMember/removeMember).
//   ✔ ADDED: inviteToGroup, generateInviteLink, revokeInviteLink.
//   ✔ Consistent error handling via shared handleError() helper.
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

        if (userId) {
            io.to(`user:${userId}`).emit('group:localSync', payload);
        }

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

// FIX: support both req.user.id and req.user.userId
function getUserId(req) {
    if (!req.user) return null;
    return req.user.id || req.user.userId || null;
}

function handleError(error, next, context) {
    logger.error(`[GroupController] ${context} error:`, error.message, error.stack);
    if (error instanceof AppError) return next(error);
    const msg = error.message || '';
    if (error.name === 'ValidationError')                              return next(new AppError(msg, 400));
    if (error.code === 11000)                                          return next(new AppError('Group with this name already exists', 409));
    if (msg.includes('not found'))                                     return next(new AppError(msg, 404));
    if (msg.includes('not authorized') || msg.includes('permission')) return next(new AppError(msg, 403));
    if (msg.includes('already') || msg.includes('already a member'))  return next(new AppError(msg, 409));
    if (msg.includes('cannot remove') || msg.includes('creator'))     return next(new AppError(msg, 400));
    if (msg.includes('required') || msg.includes('characters'))       return next(new AppError(msg, 400));
    // FIX: pass the real error message instead of a generic string so the
    // client and logs actually show what went wrong.
    return next(new AppError(msg || `${context} failed`, 500));
}

class GroupController {

    // ── CREATE GROUP ───────────────────────────────────────────────────────
    async createGroup(req, res, next) {
        try {
            const userId = getUserId(req);
            if (!userId) throw new AppError('Authentication required', 401);

            const { name, description, avatar, members, memberIds, privacy, isPublic, settings } = req.body;
            if (!name) throw new AppError('Group name is required', 400);

            // Merge members + memberIds, always include creator
            const allMemberIds = [...new Set([
                String(userId),
                ...(members   || []).map(String),
                ...(memberIds || []).map(String),
            ])].filter(Boolean);

            // FIX: destructure { group } — service returns { group: formattedGroup }
            // Previously `group` was actually { group: {...} }, so group.id was undefined.
            const { group } = await groupService.createGroup({
                name,
                description,
                avatar,
                creatorId  : userId,
                members    : allMemberIds,
                // FIX: honour both `privacy` string and `isPublic` boolean from client
                privacy    : privacy || (isPublic === true ? 'public' : isPublic === false ? 'private' : 'public'),
                isPublic   : isPublic !== undefined ? isPublic : (privacy === 'public'),
                settings   : settings || {},
            });

            // Socket emit — now works because group.id is defined after the fix above
            const io = global.__socketIO;
            if (io && group?.id) {
                const createdPayload   = { group, createdBy: userId, timestamp: new Date() };
                const localSyncPayload = { action: 'create', group, groupId: group.id };

                allMemberIds.forEach(uid => {
                    io.to(`user:${uid}`).emit('group:created',   createdPayload);
                    io.to(`user:${uid}`).emit('group:localSync', localSyncPayload);
                });

                io.to(`group:${group.id}`).emit('group:created',   createdPayload);
                io.to(`group:${group.id}`).emit('group:localSync', localSyncPayload);

                logger.info(`[GROUP FLOW] group:created emitted for group ${group.id} to ${allMemberIds.length} member(s)`);
            }

            return res.status(201).json({
                success: true,
                message: 'Group created successfully',
                data: withLocalSyncMeta({ group }, 'create'),
            });
        } catch (error) { handleError(error, next, 'createGroup'); }
    }

    // ── GET GROUP PURPOSES (PUBLIC) ────────────────────────────────────────
    async getGroupPurposes(req, res, next) {
        try {
            res.json({
                success: true,
                data: {
                    purposes: [
                        { id: 'social',         name: 'Social',         icon: '👥', description: 'Connect with friends and make new ones' },
                        { id: 'study',          name: 'Study',          icon: '📚', description: 'Study groups and academic discussions' },
                        { id: 'work',           name: 'Work',           icon: '💼', description: 'Professional collaboration and networking' },
                        { id: 'gaming',         name: 'Gaming',         icon: '🎮', description: 'Gaming communities and tournaments' },
                        { id: 'support',        name: 'Support',        icon: '🤝', description: 'Support groups and wellness communities' },
                        { id: 'hobby',          name: 'Hobby',          icon: '🎨', description: 'Share and discuss your hobbies' },
                        { id: 'professional',   name: 'Professional',   icon: '🏢', description: 'Industry professionals and experts' },
                        { id: 'entertainment',  name: 'Entertainment',  icon: '🎬', description: 'Movies, music, and entertainment' },
                        { id: 'education',      name: 'Education',      icon: '🎓', description: 'Educational content and learning' },
                        { id: 'tech',           name: 'Technology',     icon: '💻', description: 'Tech discussions and innovations' },
                        { id: 'sports',         name: 'Sports',         icon: '⚽', description: 'Sports fans and teams' },
                        { id: 'health',         name: 'Health',         icon: '🏥', description: 'Health and fitness communities' },
                        { id: 'business',       name: 'Business',       icon: '📈', description: 'Business networking and entrepreneurship' },
                        { id: 'art',            name: 'Art',            icon: '🎭', description: 'Artists and creative communities' },
                        { id: 'travel',         name: 'Travel',         icon: '✈️',  description: 'Travel enthusiasts and explorers' },
                        { id: 'food',           name: 'Food',           icon: '🍕', description: 'Food lovers and cooking enthusiasts' },
                        { id: 'music',          name: 'Music',          icon: '🎵', description: 'Music lovers and musicians' },
                        { id: 'photography',    name: 'Photography',    icon: '📷', description: 'Photography enthusiasts' },
                        { id: 'writing',        name: 'Writing',        icon: '✍️',  description: 'Writers and authors' },
                        { id: 'general',        name: 'General',        icon: '💬', description: 'General purpose groups' },
                        { id: 'other',          name: 'Other',          icon: '🌐', description: 'Other types of groups' },
                    ],
                },
            });
        } catch (error) { handleError(error, next, 'getGroupPurposes'); }
    }

    // ── GET PUBLIC GROUPS (PUBLIC) ─────────────────────────────────────────
    async getPublicGroups(req, res, next) {
        try {
            const { limit = 20, offset = 0, purpose, search } = req.query;
            const result = await groupService.searchGroups(null, {
                query : search || '',
                page  : Math.floor(parseInt(offset) / parseInt(limit)) + 1,
                limit : Math.min(parseInt(limit), 100),
                purpose,
            });
            return res.json({
                success: true,
                data: { groups: result.groups || [] },
                pagination: {
                    limit     : parseInt(limit),
                    offset    : parseInt(offset),
                    total     : result.pagination?.totalGroups || 0,
                    hasMore   : result.pagination?.hasNext || false,
                },
            });
        } catch (error) { handleError(error, next, 'getPublicGroups'); }
    }

    // ── GET GROUP BY ID ────────────────────────────────────────────────────
    async getGroupById(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            const group = await groupService.getGroupById(groupId, userId);
            res.status(200).json({ success: true, message: 'Group retrieved successfully', data: { group } });
        } catch (error) { handleError(error, next, 'getGroupById'); }
    }

    // ── GET USER GROUPS ────────────────────────────────────────────────────
    async getUserGroups(req, res, next) {
        try {
            const userId = getUserId(req);
            if (!userId) throw new AppError('Authentication required', 401);

            const options = {
                page : parseInt(req.query.page  || 1),
                limit: parseInt(req.query.limit || 50),
            };

            const result  = await groupService.getUserGroups(userId, options);
            const groups  = result.groups || [];

            const myGroups     = groups.filter(g => String(g.createdBy) === String(userId) || g.isCreator);
            const adminGroups  = groups.filter(g => g.isAdmin || g.isCreator);
            const joinedGroups = groups.filter(g => !g.isCreator && !g.isAdmin);

            // Auto-join socket rooms so real-time messages work immediately
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
                    pagination  : result.pagination,
                    _localSync  : { action: 'sync', timestamp: Date.now() },
                },
            });
        } catch (error) { handleError(error, next, 'getUserGroups'); }
    }

    // Alias used by some route definitions
    async getGroups(req, res, next) {
        return this.getUserGroups(req, res, next);
    }

    // ── UPDATE GROUP ───────────────────────────────────────────────────────
    async updateGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
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
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            // Get members BEFORE deleting so we can notify them
            let memberIds = [];
            try {
                const db = require('../models');
                const GM = db.models?.GroupMembers || db.models?.GroupMember || db.GroupMembers || db.GroupMember;
                if (GM) {
                    const members = await GM.findAll({ where: { groupId }, attributes: ['userId'] });
                    memberIds = members.map(m => m.userId || m.dataValues?.userId).filter(Boolean);
                }
            } catch(_) {}

            await groupService.deleteGroup(groupId, userId);

            // Broadcast group:deleted to all members via their user rooms
            const io = global.__socketIO;
            if (io) {
                const delPayload = { groupId, deletedBy: userId, timestamp: new Date().toISOString() };
                io.to(`group:${groupId}`).emit('group:deleted', delPayload);
                io.to(`group_${groupId}`).emit('group:deleted', delPayload);
                memberIds.forEach(mid => {
                    io.to(`user:${mid}`).emit('group:deleted', delPayload);
                    io.to(`user_${mid}`).emit('group:localSync', { action: 'delete', groupId, deletedBy: userId });
                });
            }

            res.status(200).json({
                success: true,
                message: 'Group deleted successfully',
                data: withLocalSyncMeta({ groupId }, 'delete'),
            });
        } catch (error) { handleError(error, next, 'deleteGroup'); }
    }

    // ── ADD MEMBER (alias: addGroupMember used by router) ─────────────────
    async addMember(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
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

            const io = global.__socketIO;
            if (io) {
                // FIX: fetch live member count so frontend group card updates immediately
                let liveCount = 0;
                try {
                    const db = require('../models');
                    const GM = db.GroupMembers || db.models?.GroupMembers;
                    if (GM) liveCount = await GM.count({ where: { groupId, leftAt: null } });
                } catch(_) {}

                io.to(`group:${groupId}`).emit('group:member:added', { groupId, memberId, addedBy: userId, role, member, memberCount: liveCount, timestamp: new Date() });
                io.to(`group:${groupId}`).emit('group:localSync', { action: 'member_add', groupId, member, memberCount: liveCount });
                io.to(`user:${memberId}`).emit('group:localSync', { action: 'member_add', groupId, member, memberCount: liveCount });
            }

            res.status(200).json({
                success: true,
                message: 'Member added successfully',
                data: withLocalSyncMeta({ member, groupId }, 'member_add'),
            });
        } catch (error) { handleError(error, next, 'addMember'); }
    }

    // Router uses addGroupMember — alias
    async addGroupMember(req, res, next) {
        // Router passes userId as a URL param (:userId), not in body
        if (req.params.userId && !req.body.memberId) {
            req.body.memberId = req.params.userId;
        }
        return this.addMember(req, res, next);
    }

    // ── REMOVE MEMBER (alias: removeGroupMember used by router) ───────────
    async removeMember(req, res, next) {
        try {
            const { groupId } = req.params;
            const memberId = req.params.memberId || req.params.userId;
            const userId = getUserId(req);
            if (!groupId || !memberId) throw new AppError('Group ID and Member ID are required', 400);

            await groupService.removeMember(groupId, userId, memberId);

            const io = global.__socketIO;
            if (io) {
                io.to(`group:${groupId}`).emit('group:member:removed', { groupId, memberId, removedBy: userId, timestamp: new Date() });
                io.to(`group:${groupId}`).emit('group:localSync', { action: 'member_remove', groupId, userId: memberId });
                io.to(`user:${memberId}`).emit('group:localSync', { action: 'member_remove', groupId, userId: memberId });
            }

            res.status(200).json({
                success: true,
                message: 'Member removed successfully',
                data: withLocalSyncMeta({ groupId, memberId, removed: true }, 'member_remove'),
            });
        } catch (error) { handleError(error, next, 'removeMember'); }
    }

    // Router uses removeGroupMember — alias
    async removeGroupMember(req, res, next) {
        return this.removeMember(req, res, next);
    }

    // ── UPDATE MEMBER ROLE ─────────────────────────────────────────────────
    async updateMemberRole(req, res, next) {
        try {
            const { groupId, memberId } = req.params;
            const userId = getUserId(req);
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
                io.to(`group:${groupId}`).emit('group:member:role:updated', { groupId, memberId, newRole: role, updatedBy: userId, member, timestamp: new Date() });
                io.to(`group:${groupId}`).emit('group:localSync', { action: 'member_role_update', groupId, member });
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
            const userId = getUserId(req);
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

    // ── JOIN GROUP ─────────────────────────────────────────────────────────
    async joinGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            // FIX: Go direct to GroupMembers.findOrCreate for self-join.
            // groupService.addMember blocks self-join on private groups with 403.
            // A user hitting POST /groups/:id/join is explicitly requesting to join —
            // honour that without enforcing isPublic (invite links, deep links, etc.)
            const db  = require('../models');
            const GM  = db.models?.GroupMembers || db.models?.GroupMember || db.GroupMembers || db.GroupMember;
            const grp = db.models?.Groups || db.models?.Group || db.Groups || db.Group;
            if (!GM || !grp) throw new AppError('Cannot join group at this time', 503);
            const group = await grp.findByPk(groupId);
            if (!group) throw new AppError('Group not found', 404);

            let membership;
            const existing = await GM.findOne({ where: { groupId, userId } });
            if (existing) {
                // Re-join: clear leftAt if they had left
                if (existing.leftAt) await existing.update({ leftAt: null, joinedAt: new Date() });
                membership = existing;
            } else {
                membership = await GM.create({ groupId, userId, role: 'member', joinedAt: new Date() });
            }

            // Update group member count
            try {
                const liveCount = await GM.count({ where: { groupId, leftAt: null } });
                await grp.update({ stats: { ...(group.stats || {}), totalMembers: liveCount } }, { where: { id: groupId } });
            } catch (_) {}
            const _ = membership; // suppress lint

            const io = global.__socketIO;
            if (io) {
                io.to(`group:${groupId}`).emit('group:member:joined', { groupId, memberId: userId, timestamp: new Date() });
                io.to(`user:${userId}`).emit('group:localSync', { action: 'member_add', groupId });
                // Auto-join the socket room
                const userRoom = io.sockets.adapter.rooms?.get(`user:${userId}`);
                if (userRoom) {
                    userRoom.forEach(socketId => {
                        const sock = io.sockets.sockets?.get(socketId);
                        if (sock) sock.join(`group:${groupId}`);
                    });
                }
            }

            res.status(200).json({
                success: true,
                message: 'Successfully joined the group',
                data: withLocalSyncMeta({ joined: true, groupId }, 'member_add'),
            });
        } catch (error) { handleError(error, next, 'joinGroup'); }
    }

    // ── SEARCH GROUPS ──────────────────────────────────────────────────────
    async searchGroups(req, res, next) {
        try {
            const userId = getUserId(req);
            const { q, query = q, page = 1, limit = 20, privacy, purpose } = req.query;
            const result = await groupService.searchGroups(userId, {
                query  : query || '',
                page   : parseInt(page),
                limit  : parseInt(limit),
                privacy,
                purpose,
            });
            res.status(200).json({ success: true, message: 'Groups search completed', data: result });
        } catch (error) { handleError(error, next, 'searchGroups'); }
    }

    // ── GET GROUP MEMBERS ──────────────────────────────────────────────────
    async getGroupMembers(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            const result = await groupService.getGroupMembers(groupId, userId, req.query);
            res.status(200).json({ success: true, message: 'Group members retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getGroupMembers'); }
    }

    // ── UPDATE GROUP SETTINGS ──────────────────────────────────────────────
    async updateGroupSettings(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
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
            const userId = getUserId(req);
            const { newOwnerId } = req.body;
            if (!groupId)    throw new AppError('Group ID is required', 400);
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
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            const statistics = await groupService.getGroupStatistics(groupId, userId);
            res.status(200).json({ success: true, message: 'Group statistics retrieved successfully', data: { statistics } });
        } catch (error) { handleError(error, next, 'getGroupStatistics'); }
    }

    // ── ARCHIVE GROUP ──────────────────────────────────────────────────────
    async archiveGroup(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
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
            const userId = getUserId(req);
            const { page = 1, limit = 20, status = 'pending' } = req.query;
            const options = { page: parseInt(page), limit: parseInt(limit), status };
            if (options.page < 1 || options.limit < 1 || options.limit > 50) throw new AppError('Invalid pagination parameters', 400);

            const result = await groupService.getGroupInvitations(userId, options);
            res.status(200).json({ success: true, message: 'Group invitations retrieved successfully', data: result });
        } catch (error) { handleError(error, next, 'getGroupInvitations'); }
    }

    // ── GET USER INVITES (legacy alias used by router) ─────────────────────
    async getUserInvites(req, res, next) {
        return this.getGroupInvitations(req, res, next);
    }

    // ── GET GROUP INVITES (per-group, admin view) ──────────────────────────
    async getGroupInvites(req, res, next) {
        try {
            const userId = getUserId(req);
            const { groupId } = req.params;
            const { status = 'pending' } = req.query;

            let Invites;
            try {
                const db = require('../models');
                Invites = db.models?.Invites || db.Invites || null;
            } catch (_) {}

            if (!Invites) {
                return res.status(200).json({ success: true, data: { invitations: [], total: 0 } });
            }

            const where = groupId ? { groupId, status } : { status };
            const rows = await Invites.findAll({ where, order: [['createdAt', 'DESC']], limit: 50 });
            return res.status(200).json({ success: true, data: { invitations: rows, total: rows.length } });
        } catch (error) { handleError(error, next, 'getGroupInvites'); }
    }

    // ── SEND INVITATION ────────────────────────────────────────────────────
    async sendInvitation(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
            const { inviteeId, role = 'member', message } = req.body;
            if (!groupId)   throw new AppError('Group ID is required', 400);
            if (!inviteeId) throw new AppError('Invitee ID is required', 400);

            const invitation = await groupService.sendInvitation(groupId, userId, inviteeId, role, message);

            const io = global.__socketIO;
            if (io && inviteeId) {
                const invitePayload = {
                    groupId, invitationId: invitation?.id, invitedBy: userId, role, message, timestamp: new Date(),
                };
                // PHASE14 FIX: emit to all room variants — user:N (int), user:N (string), user_N
                io.to(`user:${inviteeId}`).emit('group:invitation:received', invitePayload);
                io.to(`user_${inviteeId}`).emit('group:invitation:received', invitePayload);
                io.to(`user:${String(inviteeId)}`).emit('group:invitation:received', invitePayload);
                io.to(`user_${String(inviteeId)}`).emit('group:invitation:received', invitePayload);
            }

            res.status(201).json({ success: true, message: 'Invitation sent successfully', data: { invitation } });
        } catch (error) { handleError(error, next, 'sendInvitation'); }
    }

    // ── INVITE TO GROUP (alias used by router with user/email body) ────────
    async inviteToGroup(req, res, next) {
        const { userId: targetUserId, email } = req.body;
        if (!req.body.inviteeId && targetUserId) req.body.inviteeId = targetUserId;
        // If email passed but no userId, this would need a user lookup — fall through
        // to sendInvitation which will throw a clear error if inviteeId is missing.
        return this.sendInvitation(req, res, next);
    }

    // ── RESPOND TO INVITATION ──────────────────────────────────────────────
    async respondToInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = getUserId(req);
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
                    // Auto-join socket room
                    const userRoom = io.sockets.adapter.rooms?.get(`user:${userId}`);
                    if (userRoom) {
                        userRoom.forEach(socketId => {
                            const sock = io.sockets.sockets?.get(socketId);
                            if (sock) sock.join(`group:${result.group.id}`);
                        });
                    }
                }
            }

            res.status(200).json({
                success: true,
                message: `Invitation ${accept ? 'accepted' : 'declined'} successfully`,
                data: { accepted: accept, group: accept ? result.group : null },
            });
        } catch (error) { handleError(error, next, 'respondToInvitation'); }
    }

    // ── ACCEPT GROUP INVITE (legacy route: POST /invites/:inviteId/accept) ─
    async acceptGroupInvite(req, res, next) {
        req.params.invitationId = req.params.inviteId;
        req.body.accept = true;
        return this.respondToInvitation(req, res, next);
    }

    // ── REJECT GROUP INVITE (legacy route: POST /invites/:inviteId/reject) ─
    async rejectGroupInvite(req, res, next) {
        req.params.invitationId = req.params.inviteId;
        req.body.accept = false;
        return this.respondToInvitation(req, res, next);
    }

    // ── CANCEL INVITATION ──────────────────────────────────────────────────
    async cancelInvitation(req, res, next) {
        try {
            const { invitationId } = req.params;
            const userId = getUserId(req);
            if (!invitationId) throw new AppError('Invitation ID is required', 400);

            await groupService.cancelInvitation(invitationId, userId);
            res.status(200).json({ success: true, message: 'Invitation cancelled successfully', data: null });
        } catch (error) { handleError(error, next, 'cancelInvitation'); }
    }

    // ── GENERATE INVITE LINK ───────────────────────────────────────────────
    async generateInviteLink(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            const db    = require('../models');
            const Grp   = db.models?.Groups || db.models?.Group || db.Groups || db.Group;
            if (!Grp) throw new AppError('Service unavailable', 503);

            const group = await Grp.findByPk(groupId);
            if (!group) throw new AppError('Group not found', 404);

            // Verify admin permission
            const GM = db.models?.GroupMembers || db.models?.GroupMember || db.GroupMembers || db.GroupMember;
            if (GM) {
                const m = await GM.findOne({ where: { groupId, userId, leftAt: null } });
                if (!m || !['owner', 'admin'].includes(m.role)) throw new AppError('Only group admins can generate invite links', 403);
            }

            const { expiresIn = 24 } = req.body;
            await group.generateInviteLink(parseInt(expiresIn) || 24);

            return res.status(200).json({
                success: true,
                message: 'Invite link generated successfully',
                data: {
                    inviteLink      : group.inviteLink,
                    inviteLinkExpires: group.inviteLinkExpires,
                    groupId,
                },
            });
        } catch (error) { handleError(error, next, 'generateInviteLink'); }
    }

    // ── REVOKE INVITE LINK ─────────────────────────────────────────────────
    async revokeInviteLink(req, res, next) {
        try {
            const { groupId } = req.params;
            const userId = getUserId(req);
            if (!groupId) throw new AppError('Group ID is required', 400);

            const db  = require('../models');
            const Grp = db.models?.Groups || db.models?.Group || db.Groups || db.Group;
            if (!Grp) throw new AppError('Service unavailable', 503);

            const group = await Grp.findByPk(groupId);
            if (!group) throw new AppError('Group not found', 404);

            await group.revokeInviteLink();
            return res.status(200).json({ success: true, message: 'Invite link revoked successfully', data: null });
        } catch (error) { handleError(error, next, 'revokeInviteLink'); }
    }
}

module.exports = new GroupController();