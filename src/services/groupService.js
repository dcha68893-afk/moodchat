// groupService.js — v2.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ addMember() now emits 'groupMutation' with member payload
//     → groupController socket hook fires → client calls saveMemberLocal()
//   ✔ removeMember() now emits 'groupMutation' with member removal payload
//   ✔ updateMemberRole() now emits 'groupMutation'
//   ✔ leaveGroup() now emits 'groupMutation'
//   ✔ formatMember() added — canonical member shape for local store
//   ✔ getUserGroups() correctly joins through GroupMembers with leftAt: null
//   ✔ getGroupMembers() emits sync event so members persist to local store
//   ✔ All withTimeout() calls have consistent 6s limit
// ============================================================

let db, Groups, GroupMembers, Users, Chats;
try {
    db = require('../models');
    const m = db.models || {};
    Groups       = m.Groups       || m.Group       || db.Groups       || db.Group;
    GroupMembers = m.GroupMembers || m.GroupMember || db.GroupMembers || db.GroupMember;
    Users        = m.Users        || m.User        || db.Users        || db.User;
    Chats        = m.Chats        || m.Chat        || db.Chats        || db.Chat;
} catch (e) {
    console.error('[GroupService] ❌ Model load failed:', e.message);
}

const { Op } = require('sequelize');
const EventEmitter = require('events');

// ── Internal event bus ────────────────────────────────────────────────────────
const groupServiceEvents = new EventEmitter();
groupServiceEvents.setMaxListeners(20);

const withTimeout = (promise, ms = 6000) => {
    let tid;
    const t = new Promise((_, reject) => { tid = setTimeout(() => reject(new Error('Timeout')), ms); });
    return Promise.race([promise, t]).finally(() => { if (tid) clearTimeout(tid); });
};

// ── Canonical group shape ─────────────────────────────────────────────────────
const formatGroup = (g, extraFields = {}) => {
    if (!g) return null;
    const d = g.toJSON ? g.toJSON() : g;
    return {
        id: d.id,
        name: d.name || '',
        description: d.description || '',
        avatar: d.avatar || null,
        isPublic: d.isPublic !== undefined ? d.isPublic : true,
        purpose: d.purpose || 'social',
        maxMembers: d.maxMembers || 100,
        tags: d.tags || [],
        rules: d.rules || '',
        location: d.location || '',
        createdBy: d.createdBy,
        chatId: d.chatId || null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        isVerified: d.isVerified || false,
        settings: d.settings || {},
        stats: d.stats || { totalMembers: 0, totalMessages: 0 },
        // LOCAL-FIRST fields
        serverId    : d.id,
        isLocalOnly : false,
        syncState   : 'synced',
        status      : 'active',
        ...extraFields,
    };
};

// FIX: Canonical member shape — matches what LocalGroupStore.saveMemberLocal() expects
const formatMember = (m, extraFields = {}) => {
    if (!m) return null;
    const d = m.toJSON ? m.toJSON() : m;
    const u = d.groupMemberUser || d.user || null;
    return {
        id      : d.id,
        groupId : d.groupId,
        userId  : d.userId,
        role    : d.role     || 'member',
        joinedAt: d.joinedAt || d.createdAt,
        leftAt  : d.leftAt   || null,
        notificationsMuted: d.notificationsMuted || false,
        customSettings    : d.customSettings     || {},
        user: u ? {
            id      : u.id,
            username: u.username || '',
            avatar  : u.avatar   || null,
            status  : u.status   || 'offline',
        } : null,
        // LOCAL-FIRST fields
        isLocalOnly: false,
        syncState  : 'synced',
        ...extraFields,
    };
};

class GroupService {

    // ── CREATE GROUP ──────────────────────────────────────────────────────────
    async createGroup(groupData) {
        if (!Groups) throw new Error('Service unavailable');
        const { name, description = '', creatorId, isPublic = false, purpose = 'social', maxMembers = 100, tags = [], privacy, avatar } = groupData;
        if (!name || !name.trim()) throw new Error('Group name is required');
        if (name.length < 2 || name.length > 100) throw new Error('Group name must be between 2 and 100 characters');
        if (description.length > 500) throw new Error('Description cannot exceed 500 characters');
        if (!creatorId) throw new Error('Creator ID is required');
        try {
            if (!Chats) throw new Error('Chats model unavailable');
            const chat = await Chats.create({
                name: name.trim(), type: 'group', description,
                avatar: avatar || null, createdBy: creatorId,
            });

            const group = await Groups.create({
                name: name.trim(), description, createdBy: creatorId,
                chatId: chat.id, isPublic: privacy === 'public' || isPublic,
                purpose, maxMembers, tags, avatar: avatar || null,
            });

            let membership = null;
            if (GroupMembers) {
                membership = await GroupMembers.create({ groupId: group.id, userId: creatorId, role: 'owner', joinedAt: new Date() });
            }

            let ChatParticipant;
            try {
                const db2 = require('../models');
                ChatParticipant = db2.models?.ChatParticipant || db2.models?.ChatParticipants || db2.ChatParticipants || db2.ChatParticipant;
            } catch (_) {}
            if (ChatParticipant) {
                await ChatParticipant.create({ chatId: chat.id, userId: creatorId }).catch(() => {});
            }

            console.log(`[GroupService] ✅ Group created: "${group.name}" (id: ${group.id})`);
            const formatted = formatGroup(group);
            groupServiceEvents.emit('groupMutation', { action: 'create', group: formatted, userId: creatorId });
            return { group: formatted };
        } catch (e) {
            console.error('[GroupService] ❌ createGroup failed:', e.message);
            if (['required','unavailable','characters'].some(s => e.message.includes(s))) throw e;
            throw new Error('Failed to create group');
        }
    }

    // ── GET GROUP BY ID ───────────────────────────────────────────────────────
    async getGroupById(groupId, userId) {
        if (!Groups) throw new Error('Service unavailable');
        try {
            const group = await withTimeout(Groups.findByPk(groupId, {
                attributes: ['id','name','description','avatar','isPublic','purpose','maxMembers','tags','rules','location','createdBy','chatId','createdAt','updatedAt','isVerified','settings','stats'],
            }));
            if (!group) throw new Error('Group not found');
            const isMember = GroupMembers ? !!(await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } })) : false;
            if (!group.isPublic && !isMember) throw new Error('You do not have permission to view this group');
            return formatGroup(group);
        } catch (e) {
            if (['not found','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ getGroupById failed:', e.message);
            throw new Error('Failed to fetch group details');
        }
    }

    // ── UPDATE GROUP ──────────────────────────────────────────────────────────
    async updateGroup(groupId, userId, updates) {
        if (!Groups) throw new Error('Service unavailable');
        try {
            const group = await Groups.findByPk(groupId);
            if (!group) throw new Error('Group not found');
            let canEdit = String(group.createdBy) === String(userId);
            if (!canEdit && GroupMembers) {
                const m = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
                canEdit = m && ['owner','admin'].includes(m.role);
            }
            if (!canEdit) throw new Error('You do not have permission to update this group');
            const allowed = ['name','description','avatar','isPublic','purpose','maxMembers','tags','rules','location'];
            const fields = {};
            for (const [k, v] of Object.entries(updates)) {
                if (allowed.includes(k)) {
                    if (k === 'name' && (v.length < 2 || v.length > 100)) throw new Error('Group name must be between 2 and 100 characters');
                    if (k === 'description' && v.length > 500) throw new Error('Description cannot exceed 500 characters');
                    fields[k] = v;
                }
            }
            await group.update(fields);
            console.log(`[GroupService] ✅ Group ${groupId} updated`);
            const formatted = formatGroup(group);
            groupServiceEvents.emit('groupMutation', { action: 'update', group: formatted, userId });
            return formatted;
        } catch (e) {
            if (['not found','permission','characters'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ updateGroup failed:', e.message);
            throw new Error('Failed to update group');
        }
    }

    // ── DELETE GROUP ──────────────────────────────────────────────────────────
    async deleteGroup(groupId, userId) {
        if (!Groups) throw new Error('Service unavailable');
        try {
            const group = await Groups.findByPk(groupId);
            if (!group) throw new Error('Group not found');
            if (String(group.createdBy) !== String(userId)) throw new Error('Only the group owner can delete this group');
            await group.destroy();
            console.log(`[GroupService] ✅ Group ${groupId} deleted`);
            groupServiceEvents.emit('groupMutation', { action: 'delete', groupId, userId });
            return true;
        } catch (e) {
            if (['not found','owner'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ deleteGroup failed:', e.message);
            throw new Error('Failed to delete group');
        }
    }

    // ── ADD MEMBER ────────────────────────────────────────────────────────────
    // FIX: Now emits 'groupMutation' with full member payload for local-first persistence
    async addMember(groupId, requestingUserId, memberId, role = 'member') {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const group = await Groups?.findByPk(groupId);
            if (!group) throw new Error('Group not found');
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId, leftAt: null } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('Only group admins can add members');
            const existing = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (existing && !existing.leftAt) throw new Error('User is already a member of this group');
            const count = await GroupMembers.count({ where: { groupId, leftAt: null } });
            if (count >= (group.maxMembers || 100)) throw new Error('Group has reached maximum member limit');

            let membership;
            if (existing) {
                await existing.update({ role, leftAt: null, joinedAt: new Date() });
                membership = existing;
            } else {
                membership = await GroupMembers.create({ groupId, userId: memberId, role, joinedAt: new Date() });
            }

            const formattedMember = formatMember(membership);
            console.log(`[GroupService] ✅ Member ${memberId} added to group ${groupId}`);

            // FIX: Emit with member payload so groupController can push saveMemberLocal to client
            groupServiceEvents.emit('groupMutation', {
                action: 'member_add',
                groupId,
                member: formattedMember,
                userId: memberId,
                requestedBy: requestingUserId,
            });

            return membership;
        } catch (e) {
            if (['not found','already a member','admins can','maximum'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ addMember failed:', e.message);
            throw new Error('Failed to add member');
        }
    }

    // ── REMOVE MEMBER ─────────────────────────────────────────────────────────
    // FIX: Now emits 'groupMutation' with removal payload
    async removeMember(groupId, requestingUserId, memberId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId, leftAt: null } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('Only group admins can remove members');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!membership) throw new Error('Member not found in this group');
            if (membership.role === 'owner') throw new Error('Cannot remove the group owner');
            await membership.update({ leftAt: new Date() });
            console.log(`[GroupService] ✅ Member ${memberId} removed from group ${groupId}`);

            // FIX: Emit with userId payload so client can call deleteMemberLocal
            groupServiceEvents.emit('groupMutation', {
                action: 'member_remove',
                groupId,
                userId: memberId,
                requestedBy: requestingUserId,
            });

            return true;
        } catch (e) {
            if (['not found','admins can','owner'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ removeMember failed:', e.message);
            throw new Error('Failed to remove member');
        }
    }

    // ── UPDATE MEMBER ROLE ────────────────────────────────────────────────────
    // FIX: Now emits 'groupMutation' with updated member
    async updateMemberRole(groupId, requestingUserId, memberId, role) {
        if (!GroupMembers) throw new Error('Service unavailable');
        const validRoles = ['member','moderator','admin','owner'];
        if (!validRoles.includes(role)) throw new Error('Invalid role');
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId, leftAt: null } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('Only group admins can update roles');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!membership) throw new Error('Member not found in this group');
            membership.role = role;
            await membership.save();

            const formattedMember = formatMember(membership);
            console.log(`[GroupService] ✅ Member ${memberId} role → ${role} in group ${groupId}`);

            groupServiceEvents.emit('groupMutation', {
                action: 'member_role_update',
                groupId,
                member: formattedMember,
                userId: memberId,
                requestedBy: requestingUserId,
            });

            return membership;
        } catch (e) {
            if (['Invalid','not found','admins can'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ updateMemberRole failed:', e.message);
            throw new Error('Failed to update member role');
        }
    }

    // ── LEAVE GROUP ───────────────────────────────────────────────────────────
    // FIX: Now emits 'groupMutation' with leave payload
    async leaveGroup(groupId, userId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const membership = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
            if (!membership) throw new Error('You are not a member of this group');
            if (membership.role === 'owner') throw new Error('Group owner cannot leave. Transfer ownership first.');
            await membership.update({ leftAt: new Date() });
            console.log(`[GroupService] ✅ User ${userId} left group ${groupId}`);

            groupServiceEvents.emit('groupMutation', { action: 'member_leave', groupId, userId });
            return true;
        } catch (e) {
            if (['not a member','cannot leave','owner'].some(s => e.message.toLowerCase().includes(s))) throw e;
            console.error('[GroupService] ❌ leaveGroup failed:', e.message);
            throw new Error('Failed to leave group');
        }
    }

    // ── GET USER GROUPS ───────────────────────────────────────────────────────
    async getUserGroups(userId, options = {}) {
        if (!Groups || !GroupMembers) return { groups: [], pagination: { currentPage: 1, totalPages: 0, totalGroups: 0, hasNext: false, hasPrevious: false } };
        const { page = 1, limit = 50 } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;
        try {
            const memberships = await withTimeout(GroupMembers.findAll({
                where: { userId, leftAt: null },
                include: [{
                    model: Groups, as: 'userGroup', required: true,
                    attributes: ['id','name','description','avatar','purpose','isPublic','maxMembers','createdBy','chatId','createdAt','updatedAt','settings','stats'],
                }],
                limit: limitNum, offset,
                order: [['joinedAt', 'DESC']],
            }));

            const groups = memberships.map(m => {
                if (!m.userGroup) return null;
                return formatGroup(m.userGroup, {
                    isAdmin  : ['owner','admin'].includes(m.role),
                    isCreator: m.role === 'owner',
                    role     : m.role,
                });
            }).filter(Boolean);

            const total = await GroupMembers.count({ where: { userId, leftAt: null } });
            const totalPages = Math.ceil(total / limitNum);
            return { groups, pagination: { currentPage: pageNum, totalPages, totalGroups: total, hasNext: pageNum < totalPages, hasPrevious: pageNum > 1 } };
        } catch (e) {
            console.error('[GroupService] ❌ getUserGroups failed:', e.message);
            return { groups: [], pagination: { currentPage: 1, totalPages: 0, totalGroups: 0, hasNext: false, hasPrevious: false } };
        }
    }

    // ── SEARCH GROUPS ─────────────────────────────────────────────────────────
    async searchGroups(userId, options = {}) {
        if (!Groups) return { groups: [], pagination: { currentPage: 1, totalPages: 0, totalGroups: 0 } };
        const { query = '', page = 1, limit = 20 } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;
        try {
            const where = { isPublic: true };
            if (query) {
                where[Op.or] = [
                    { name: { [Op.iLike]: `%${query}%` } },
                    { description: { [Op.iLike]: `%${query}%` } },
                ];
            }
            const { count, rows } = await withTimeout(Groups.findAndCountAll({
                where, limit: limitNum, offset, order: [['createdAt', 'DESC']],
                attributes: ['id','name','description','avatar','purpose','isPublic','maxMembers','createdBy','createdAt'],
            }));
            const totalPages = Math.ceil(count / limitNum);
            return { groups: rows.map(g => formatGroup(g)), pagination: { currentPage: pageNum, totalPages, totalGroups: count, hasNext: pageNum < totalPages, hasPrevious: pageNum > 1 } };
        } catch (e) {
            console.error('[GroupService] ❌ searchGroups failed:', e.message);
            return { groups: [], pagination: { currentPage: 1, totalPages: 0, totalGroups: 0 } };
        }
    }

    // ── GET GROUP MEMBERS ─────────────────────────────────────────────────────
    // FIX: Emits sync event so members list is persisted to local store
    async getGroupMembers(groupId, userId, options = {}) {
        if (!GroupMembers) return { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        const { page = 1, limit = 50, role } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;
        try {
            const where = { groupId, leftAt: null };
            if (role) where.role = role;
            const { count, rows } = await withTimeout(GroupMembers.findAndCountAll({
                where,
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false }],
                limit: limitNum, offset,
                order: [['role','ASC'], ['joinedAt','ASC']],
            }));
            const members = rows.map(m => formatMember(m));
            const totalPages = Math.ceil(count / limitNum);

            // FIX: Emit so client can persist members to IDB
            groupServiceEvents.emit('groupMutation', {
                action: 'members_loaded',
                groupId,
                members,
                userId,
            });

            return { members, pagination: { currentPage: pageNum, totalPages, totalMembers: count } };
        } catch (e) {
            console.error('[GroupService] ❌ getGroupMembers failed:', e.message);
            return { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        }
    }

    // ── UPDATE GROUP SETTINGS ─────────────────────────────────────────────────
    async updateGroupSettings(groupId, userId, settings) {
        if (!Groups) throw new Error('Service unavailable');
        try {
            const group = await Groups.findByPk(groupId);
            if (!group) throw new Error('Group not found');
            let canEdit = String(group.createdBy) === String(userId);
            if (!canEdit && GroupMembers) {
                const m = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
                canEdit = m && ['owner','admin'].includes(m.role);
            }
            if (!canEdit) throw new Error('You do not have permission to update settings');
            const existing = group.settings || {};
            const mod = settings.moderationSettings || {};
            const filtered = {
                allowMedia           : settings.allowMedia           ?? mod.allowMediaSharing   ?? existing.allowMedia           ?? true,
                allowCalls           : settings.allowCalls           ?? existing.allowCalls      ?? true,
                allowReactions       : settings.allowReactions       ?? existing.allowReactions  ?? true,
                allowReplies         : settings.allowReplies         ?? existing.allowReplies    ?? true,
                allowEditing         : settings.allowEditing         ?? existing.allowEditing    ?? true,
                allowDeleting        : settings.allowDeleting        ?? existing.allowDeleting   ?? true,
                slowMode             : settings.slowMode             ?? existing.slowMode        ?? 0,
                requireAdminApproval : settings.requireAdminApproval ?? mod.approveNewMembers    ?? existing.requireAdminApproval ?? false,
                allowInvites         : settings.allowInvites         ?? mod.allowInvites         ?? existing.allowInvites         ?? true,
                onlyAdminsCanPost    : settings.onlyAdminsCanPost    ?? mod.onlyAdminsCanPost    ?? existing.onlyAdminsCanPost    ?? false,
                disappearingMessages : settings.disappearingMessages ?? mod.disappearingMessages  ?? existing.disappearingMessages ?? false,
                archived             : settings.archived             ?? existing.archived        ?? false,
            };
            const updatePayload = { settings: { ...existing, ...filtered } };
            if (settings.privacy !== undefined) updatePayload.isPublic = settings.privacy === 'public';
            await group.update(updatePayload);
            const formatted = formatGroup(group);
            groupServiceEvents.emit('groupMutation', { action: 'update', group: formatted, userId });
            return formatted;
        } catch (e) {
            if (['not found','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ updateGroupSettings failed:', e.message);
            throw new Error('Failed to update settings');
        }
    }

    // ── TRANSFER OWNERSHIP ────────────────────────────────────────────────────
    async transferOwnership(groupId, userId, newOwnerId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const ownerMembership = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
            if (!ownerMembership || ownerMembership.role !== 'owner') throw new Error('Only the group owner can transfer ownership');
            const newOwnerMembership = await GroupMembers.findOne({ where: { groupId, userId: newOwnerId, leftAt: null } });
            if (!newOwnerMembership) throw new Error('New owner must be a group member');
            ownerMembership.role = 'admin';
            await ownerMembership.save();
            newOwnerMembership.role = 'owner';
            await newOwnerMembership.save();
            if (Groups) await Groups.update({ createdBy: newOwnerId }, { where: { id: groupId } });
            console.log(`[GroupService] ✅ Group ${groupId} ownership transferred to ${newOwnerId}`);
            groupServiceEvents.emit('groupMutation', { action: 'update', groupId, userId: newOwnerId });
            return { transferred: true, groupId, newOwnerId };
        } catch (e) {
            if (['owner','must be'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ transferOwnership failed:', e.message);
            throw new Error('Failed to transfer ownership');
        }
    }

    // ── GET GROUP STATISTICS ──────────────────────────────────────────────────
    async getGroupStatistics(groupId, userId) {
        if (!Groups || !GroupMembers) return { totalMembers: 0, totalAdmins: 0 };
        try {
            const group = await Groups.findByPk(groupId);
            if (!group) throw new Error('Group not found');
            const [totalMembers, totalAdmins] = await Promise.all([
                GroupMembers.count({ where: { groupId, leftAt: null } }),
                GroupMembers.count({ where: { groupId, leftAt: null, role: { [Op.in]: ['owner','admin'] } } }),
            ]);
            return { totalMembers, totalAdmins, groupId, groupName: group.name, isPublic: group.isPublic, purpose: group.purpose, createdAt: group.createdAt };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupService] ❌ getGroupStatistics failed:', e.message);
            throw new Error('Failed to get group statistics');
        }
    }

    // ── ARCHIVE GROUP ─────────────────────────────────────────────────────────
    async archiveGroup(groupId, userId, archived = true) {
        if (!Groups) throw new Error('Service unavailable');
        try {
            const group = await Groups.findByPk(groupId);
            if (!group) throw new Error('Group not found');
            if (String(group.createdBy) !== String(userId)) throw new Error('Only the group owner can archive/unarchive');
            const settings = { ...(group.settings || {}), archived };
            await group.update({ settings });
            console.log(`[GroupService] ✅ Group ${groupId} ${archived ? 'archived' : 'unarchived'}`);
            const formatted = formatGroup(group);
            groupServiceEvents.emit('groupMutation', { action: archived ? 'archive' : 'unarchive', group: formatted, userId });
            return formatted;
        } catch (e) {
            if (['not found','owner'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ archiveGroup failed:', e.message);
            throw new Error('Failed to archive group');
        }
    }

    // ── GET GROUP INVITATIONS ─────────────────────────────────────────────────
    async getGroupInvitations(userId, options = {}) {
        let Invites;
        try { const db2 = require('../models'); Invites = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invites) return { invitations: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        const { page = 1, limit = 20, status = 'pending' } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(50, parseInt(limit));
        const offset   = (pageNum - 1) * limitNum;
        try {
            const where = { targetUserId: userId };
            if (status !== 'all') where.status = status;
            const { count, rows } = await withTimeout(Invites.findAndCountAll({
                where,
                include: [{ model: Groups, as: 'userGroup', attributes: ['id','name','avatar','description','purpose'], required: false }],
                limit: limitNum, offset, order: [['createdAt','DESC']],
            }));
            return { invitations: rows, pagination: { currentPage: pageNum, totalPages: Math.ceil(count / limitNum), total: count } };
        } catch (e) {
            console.error('[GroupService] ❌ getGroupInvitations failed:', e.message);
            return { invitations: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        }
    }

    // ── SEND INVITATION ───────────────────────────────────────────────────────
    async sendInvitation(groupId, userId, inviteeId, role = 'member', message = '') {
        let Invites;
        try { const db2 = require('../models'); Invites = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invites) throw new Error('Invite service unavailable');
        try {
            const already = await GroupMembers?.findOne({ where: { groupId, userId: inviteeId, leftAt: null } });
            if (already) throw new Error('User is already a member of this group');
            const existingInvite = await Invites.findOne({ where: { groupId, targetUserId: inviteeId, status: 'pending' } });
            if (existingInvite) throw new Error('User is already invited to this group');
            const invitation = await Invites.create({
                groupId, inviterId: userId, targetUserId: inviteeId, message, status: 'pending',
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            });
            console.log(`[GroupService] ✅ Invitation sent to user ${inviteeId} for group ${groupId}`);
            return invitation;
        } catch (e) {
            if (['already a member','already invited'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupService] ❌ sendInvitation failed:', e.message);
            throw new Error('Failed to send invitation');
        }
    }

    // ── RESPOND TO INVITATION ─────────────────────────────────────────────────
    async respondToInvitation(invitationId, userId, accept) {
        let Invites;
        try { const db2 = require('../models'); Invites = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invitation = await Invites.findOne({ where: { id: invitationId, targetUserId: userId, status: 'pending' } });
            if (!invitation) throw new Error('Invitation not found or already responded');
            if (accept && GroupMembers) {
                const [member] = await GroupMembers.findOrCreate({
                    where: { groupId: invitation.groupId, userId },
                    defaults: { role: 'member', joinedAt: new Date() },
                });
                if (member.leftAt) await member.update({ leftAt: null, joinedAt: new Date() });
            }
            invitation.status = accept ? 'accepted' : 'rejected';
            await invitation.save();
            console.log(`[GroupService] ✅ Invitation ${invitationId} ${accept ? 'accepted' : 'rejected'} by user ${userId}`);
            return { accepted: accept, group: accept ? await Groups?.findByPk(invitation.groupId) : null };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupService] ❌ respondToInvitation failed:', e.message);
            throw new Error('Failed to respond to invitation');
        }
    }

    // ── CANCEL INVITATION ─────────────────────────────────────────────────────
    async cancelInvitation(invitationId, userId) {
        let Invites;
        try { const db2 = require('../models'); Invites = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invitation = await Invites.findOne({ where: { id: invitationId, inviterId: userId } });
            if (!invitation) throw new Error('Invitation not found or you do not have permission to cancel it');
            await invitation.destroy();
            return true;
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupService] ❌ cancelInvitation failed:', e.message);
            throw new Error('Failed to cancel invitation');
        }
    }
}

const groupServiceInstance = new GroupService();

module.exports = groupServiceInstance;
module.exports.groupServiceEvents = groupServiceEvents;