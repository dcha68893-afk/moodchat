// groupService.js — v4.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ BUG FIX (CRITICAL): createGroup catch block was swallowing ALL
//     real Sequelize/Postgres errors (FK violations, NOT NULL, unique
//     constraint failures, column not found, etc.) into a generic
//     "Failed to create group" message. The catch filter only preserved
//     errors containing 'required','unavailable','characters','not found'
//     — any DB error fell through and was replaced. Now the real error
//     is always logged AND re-thrown so the controller returns it.
//   ✔ BUG FIX: Same swallowing problem fixed in updateGroup, deleteGroup,
//     addMember, removeMember, updateMemberRole, leaveGroup,
//     updateGroupSettings, transferOwnership, archiveGroup.
//   ✔ BUG FIX: createGroup — rollback Chat if Group.create() fails to
//     avoid orphaned Chat records in the database.
//   ✔ BUG FIX: getUserGroups — returns empty gracefully if models not
//     loaded instead of crashing (models may load async on cold start).
//   ✔ BUG FIX: searchGroups — added `purpose` filter support to match
//     what groupController.searchGroups() passes.
//   ✔ BUG FIX: getGroupInvitations — Invites model lookup now tries
//     additional common key names (GroupInvites, Invitation, Invitations).
//   ✔ Event bus exported correctly: module.exports.groupServiceEvents.
// ============================================================

let db, Groups, GroupMembers, Users, Chats, Friends;
try {
    db = require('../models');
    const m = db.models || {};
    Groups       = m.Groups       || m.Group       || db.Groups       || db.Group;
    GroupMembers = m.GroupMembers || m.GroupMember || db.GroupMembers || db.GroupMember;
    Users        = m.Users        || m.User        || db.Users        || db.User;
    Chats        = m.Chats        || m.Chat        || db.Chats        || db.Chat;
    Friends      = m.Friends      || m.Friend       || db.Friends      || db.Friend;
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
    const t = new Promise((_, reject) => { tid = setTimeout(() => reject(new Error('DB query timed out')), ms); });
    return Promise.race([promise, t]).finally(() => { if (tid) clearTimeout(tid); });
};

// ── Canonical group shape ─────────────────────────────────────────────────────
const formatGroup = (g, extraFields = {}) => {
    if (!g) return null;
    const d = g.toJSON ? g.toJSON() : g;
    return {
        id          : d.id,
        name        : d.name        || '',
        description : d.description || '',
        avatar      : d.avatar      || null,
        isPublic    : d.isPublic    !== undefined ? d.isPublic : true,
        purpose     : d.purpose     || 'social',
        maxMembers  : d.maxMembers  || 100,
        tags        : d.tags        || [],
        rules       : d.rules       || '',
        location    : d.location    || '',
        createdBy   : d.createdBy,
        memberCount : d.memberCount || 0,
        chatId      : d.chatId      || null,
        createdAt   : d.createdAt,
        updatedAt   : d.updatedAt,
        isVerified  : d.isVerified  || false,
        settings    : d.settings    || {},
        stats       : d.stats       || { totalMembers: 0, totalMessages: 0 },
        // P1 FIX: Persist critical fields now exposed in API
        slowModeInterval       : d.slowModeInterval       ?? 0,
        postingRule            : d.postingRule             || 'open',
        disappearingTimer      : d.disappearingTimer       ?? 0,
        pinnedMessageIds       : d.pinnedMessageIds        || [],
        inviteLinkMaxUses      : d.inviteLinkMaxUses       ?? 0,
        inviteLinkUseCount     : d.inviteLinkUseCount      ?? 0,
        groupUsername          : d.groupUsername           || null,
        blockedWords           : d.blockedWords            || [],
        scheduledPostingStart  : d.scheduledPostingStart   || null,
        scheduledPostingEnd    : d.scheduledPostingEnd     || null,
        // LOCAL-FIRST fields
        serverId    : d.id,
        isLocalOnly : false,
        syncState   : 'synced',
        status      : 'active',
        ...extraFields,
    };
};

// ── Canonical member shape ─────────────────────────────────────────────────────
const formatMember = (m, extraFields = {}) => {
    if (!m) return null;
    const d = m.toJSON ? m.toJSON() : m;
    const u = d.groupMemberUser || d.user || null;
    return {
        id                : d.id,
        groupId           : d.groupId,
        userId            : d.userId,
        role              : d.role              || 'member',
        joinedAt          : d.joinedAt          || d.createdAt,
        leftAt            : d.leftAt            || null,
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

// ── Helper: look up Invites model under several possible names ─────────────────
function _getInvitesModel() {
    try {
        const db2 = require('../models');
        return db2.models?.Invites
            || db2.models?.Invite
            || db2.models?.GroupInvites
            || db2.models?.GroupInvite
            || db2.models?.Invitation
            || db2.models?.Invitations
            || db2.Invites
            || db2.Invite
            || null;
    } catch (_) { return null; }
}

class GroupService {

    // ── CREATE GROUP ──────────────────────────────────────────────────────────
    async createGroup(groupData) {
        if (!Groups) throw new Error('Groups model unavailable — check DB connection');

        const {
            name,
            description = '',
            creatorId,
            isPublic    = false,
            purpose     = 'social',
            maxMembers  = 100,
            tags        = [],
            privacy,
            avatar,
            discoveryScope = 'world',
        } = groupData;

        if (!name)      throw new Error('Group name is required');
        if (!creatorId) throw new Error('Creator ID is required');

        const sanitizedName = name.toString().trim();
        if (sanitizedName.length < 2 || sanitizedName.length > 100) {
            throw new Error('Group name must be between 2 and 100 characters');
        }

        const sanitizedDescription = description ? description.toString().trim().substring(0, 500) : '';

        if (!Users) throw new Error('Users model unavailable');
        const creator = await Users.findByPk(parseInt(creatorId));
        if (!creator) throw new Error('Creator not found');

        const validPurposes     = ['social', 'work', 'education', 'hobby', 'general', 'study', 'gaming', 'support', 'professional', 'entertainment', 'tech', 'sports', 'health', 'business', 'art', 'travel', 'food', 'music', 'photography', 'writing', 'other'];
        const sanitizedPurpose  = validPurposes.includes(purpose) ? purpose : 'social';
        const sanitizedMax      = Math.min(1000, Math.max(1, parseInt(maxMembers) || 100));
        const sanitizedTags     = Array.isArray(tags) ? tags.slice(0, 10).map(t => t.toString().substring(0, 50)) : [];
        const resolvedIsPublic  = privacy === 'public' || isPublic === true || isPublic === 'true';

        // FIX: wrap DB ops in a try/catch that re-throws the REAL error,
        // not a swallowed generic string. Roll back the Chat record if
        // Group creation subsequently fails.
        let chat = null;
        try {
            if (!Chats) throw new Error('Chats model unavailable');
            chat = await Chats.create({
                name        : sanitizedName,
                type        : 'group',
                description : sanitizedDescription,
                avatar      : avatar ? avatar.toString().substring(0, 500) : null,
                createdBy   : parseInt(creatorId),
            });

            if (!chat || !chat.id) throw new Error('Failed to create chat for group');

            const group = await Groups.create({
                name        : sanitizedName,
                description : sanitizedDescription,
                createdBy   : parseInt(creatorId),
                chatId      : chat.id,
                isPublic    : resolvedIsPublic,
                purpose     : sanitizedPurpose,
                maxMembers  : sanitizedMax,
                tags        : sanitizedTags,
                avatar      : avatar ? avatar.toString().substring(0, 500) : null,
                discoveryScope: ['community', 'region', 'county', 'world'].includes(discoveryScope) ? discoveryScope : 'world',
            });

            if (!group || !group.id) throw new Error('Failed to create group — database returned no ID');

            // Add creator as owner
            if (GroupMembers) {
                const membership = await GroupMembers.create({
                    groupId : group.id,
                    userId  : parseInt(creatorId),
                    role    : 'owner',
                    joinedAt: new Date(),
                });
                if (!membership || !membership.id) {
                    console.warn('[GroupService] ⚠️ Failed to create owner membership');
                }
            }

            // Add creator as ChatParticipant if that model exists
            try {
                const db2 = require('../models');
                const CP  = db2.models?.ChatParticipant || db2.models?.ChatParticipants
                         || db2.ChatParticipants        || db2.ChatParticipant;
                if (CP) await CP.create({ chatId: chat.id, userId: parseInt(creatorId) }).catch(() => {});
            } catch (_) {}

            console.log(`[GroupService] ✅ Group created: "${group.name}" (id: ${group.id}, chatId: ${chat.id})`);
            // FIX: formatGroup's memberCount default reads a non-existent
            // Groups.memberCount column (always 0) — pass the real count
            // (the owner membership just created above) explicitly, matching
            // the pattern already used correctly in getGroupById/getUserGroups.
            const formatted = formatGroup(group, { memberCount: 1, participantCount: 1, stats: { totalMembers: 1, totalMessages: 0 } });
            groupServiceEvents.emit('groupMutation', { action: 'create', group: formatted, userId: parseInt(creatorId) });
            return { group: formatted };

        } catch (e) {
            // FIX: Roll back the Chat record if it was created but Group.create() failed
            if (chat && chat.id && e.message && !e.message.includes('chat for group')) {
                try { await chat.destroy(); } catch (_) {}
                console.warn(`[GroupService] Rolled back orphaned chat ${chat.id} after group creation failure`);
            }
            // FIX: Always re-throw the REAL error (Sequelize error has full context)
            console.error('[GroupService] ❌ createGroup failed:', e.message);
            throw e;
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
            // FIX-PHASE16: Always look up membership so role/isAdmin/isCreator are returned.
            // Previously the return value lacked role data, causing loadUniqueFeaturesPanels
            // to hide all tools panels for members who opened a group from Discover.
            let membership = null;
            const isMember = GroupMembers
                ? !!(membership = await withTimeout(GroupMembers.findOne({ where: { groupId, userId, leftAt: null } })))
                : false;
            if (!group.isPublic && !isMember) throw new Error('You do not have permission to view this group');
            const memberCount = GroupMembers
                ? await withTimeout(GroupMembers.count({ where: { groupId, leftAt: null } }))
                : 0;
            const role = membership ? (membership.role || 'member') : 'member';
            return formatGroup(group, {
                memberCount,
                stats: { ...(group.stats || {}), totalMembers: memberCount },
                role,
                isAdmin   : ['owner', 'admin'].includes(role),
                isCreator : role === 'owner' || String(group.createdBy) === String(userId),
            });
        } catch (e) {
            console.error('[GroupService] ❌ getGroupById failed:', e.message);
            throw e;
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
                canEdit = m && ['owner', 'admin'].includes(m.role);
            }
            if (!canEdit) throw new Error('You do not have permission to update this group');

            const allowed = ['name','description','avatar','isPublic','purpose','maxMembers','tags','rules','location'];
            const fields  = {};
            for (const [k, v] of Object.entries(updates)) {
                if (!allowed.includes(k)) continue;
                if (k === 'name'        && (v.length < 2 || v.length > 100)) throw new Error('Group name must be between 2 and 100 characters');
                if (k === 'description' && v.length > 500)                   throw new Error('Description cannot exceed 500 characters');
                fields[k] = v;
            }
            await group.update(fields);
            console.log(`[GroupService] ✅ Group ${groupId} updated`);
            // FIX: compute the real member count instead of formatGroup's
            // always-0 default (see createGroup fix above for root cause).
            const _mc = GroupMembers ? await GroupMembers.count({ where: { groupId, leftAt: null } }) : 0;
            const formatted = formatGroup(group, { memberCount: _mc, participantCount: _mc, stats: { totalMembers: _mc, totalMessages: 0 } });
            groupServiceEvents.emit('groupMutation', { action: 'update', group: formatted, userId });
            return formatted;
        } catch (e) {
            console.error('[GroupService] ❌ updateGroup failed:', e.message);
            throw e;
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
            console.error('[GroupService] ❌ deleteGroup failed:', e.message);
            throw e;
        }
    }

    // ── ADD MEMBER ────────────────────────────────────────────────────────────
    async addMember(groupId, requestingUserId, memberId, role = 'member') {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const group = await Groups?.findByPk(groupId);
            if (!group) throw new Error('Group not found');

            // If requester is the same as member (self-join on public group), allow it
            const isSelfJoin = String(requestingUserId) === String(memberId);
            if (!isSelfJoin) {
                const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId, leftAt: null } });
                if (!requester || !['owner', 'admin'].includes(requester.role)) {
                    throw new Error('Only group admins can add members');
                }
            } else if (!group.isPublic) {
                throw new Error('This group is private — you need an invitation to join');
            }

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
            // FIX: update stats.totalMembers in real-time so GET /groups/:id returns correct count
            try {
                const liveCount = await GroupMembers.count({ where: { groupId, leftAt: null } });
                await Groups.update({ stats: { ...(group.stats || {}), totalMembers: liveCount } }, { where: { id: groupId } });
            } catch (_) {}
            console.log(`[GroupService] ✅ Member ${memberId} added to group ${groupId} as ${role}`);
            groupServiceEvents.emit('groupMutation', { action: 'member_add', groupId, member: formattedMember, userId: memberId, requestedBy: requestingUserId });
            return membership;
        } catch (e) {
            console.error('[GroupService] ❌ addMember failed:', e.message);
            throw e;
        }
    }

    // ── REMOVE MEMBER ─────────────────────────────────────────────────────────
    async removeMember(groupId, requestingUserId, memberId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId, leftAt: null } });
            if (!requester || !['owner', 'admin'].includes(requester.role)) throw new Error('Only group admins can remove members');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!membership) throw new Error('Member not found in this group');
            if (membership.role === 'owner') throw new Error('Cannot remove the group owner');
            await membership.update({ leftAt: new Date() });
            console.log(`[GroupService] ✅ Member ${memberId} removed from group ${groupId}`);
            groupServiceEvents.emit('groupMutation', { action: 'member_remove', groupId, userId: memberId, requestedBy: requestingUserId });
            return true;
        } catch (e) {
            console.error('[GroupService] ❌ removeMember failed:', e.message);
            throw e;
        }
    }

    // ── UPDATE MEMBER ROLE ────────────────────────────────────────────────────
    async updateMemberRole(groupId, requestingUserId, memberId, role) {
        if (!GroupMembers) throw new Error('Service unavailable');
        const validRoles = ['member', 'moderator', 'admin', 'owner'];
        if (!validRoles.includes(role)) throw new Error(`Invalid role: ${role}`);
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId, leftAt: null } });
            if (!requester || !['owner', 'admin'].includes(requester.role)) throw new Error('Only group admins can update roles');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!membership) throw new Error('Member not found in this group');
            membership.role = role;
            await membership.save();
            const formattedMember = formatMember(membership);
            console.log(`[GroupService] ✅ Member ${memberId} role → ${role} in group ${groupId}`);
            groupServiceEvents.emit('groupMutation', { action: 'member_role_update', groupId, member: formattedMember, userId: memberId, requestedBy: requestingUserId });
            return membership;
        } catch (e) {
            console.error('[GroupService] ❌ updateMemberRole failed:', e.message);
            throw e;
        }
    }

    // ── LEAVE GROUP ───────────────────────────────────────────────────────────
    async leaveGroup(groupId, userId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const membership = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
            if (!membership) throw new Error('You are not a member of this group');
            if (membership.role === 'owner') throw new Error('Group owner cannot leave. Transfer ownership first.');
            await membership.update({ leftAt: new Date() });
            // FIX: update stats.totalMembers so count is always real
            try {
                const liveCount = await GroupMembers.count({ where: { groupId, leftAt: null } });
                const currentGroup = await Groups?.findByPk(groupId);
                await Groups?.update({ stats: { ...(currentGroup?.stats || {}), totalMembers: liveCount } }, { where: { id: groupId } });
            } catch (_) {}
            console.log(`[GroupService] ✅ User ${userId} left group ${groupId}`);
            groupServiceEvents.emit('groupMutation', { action: 'member_leave', groupId, userId });
            return true;
        } catch (e) {
            console.error('[GroupService] ❌ leaveGroup failed:', e.message);
            throw e;
        }
    }

    // ── GET USER GROUPS ───────────────────────────────────────────────────────
    async getUserGroups(userId, options = {}) {
        const empty = { groups: [], pagination: { currentPage: 1, totalPages: 0, totalGroups: 0, hasNext: false, hasPrevious: false } };
        if (!Groups || !GroupMembers) return empty;
        const { page = 1, limit = 50 } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;
        try {
            const memberships = await withTimeout(GroupMembers.findAll({
                where  : { userId, leftAt: null },
                include: [{
                    model     : Groups,
                    as        : 'userGroup',
                    required  : true,
                    attributes: ['id','name','description','avatar','purpose','isPublic','maxMembers','createdBy','chatId','createdAt','updatedAt','settings','stats'],
                }],
                limit : limitNum,
                offset,
                order : [['joinedAt', 'DESC']],
            }));

            // FIX: Fetch real member counts for user's groups
            const groupIds = memberships.map(m => m.userGroup?.id).filter(Boolean);
            let mcMap = {};
            if (groupIds.length > 0) {
                try {
                    const mcRows = await GroupMembers.findAll({
                        where: { groupId: groupIds, leftAt: null },
                        attributes: ['groupId', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'cnt']],
                        group: ['groupId'],
                        raw: true,
                    });
                    mcRows.forEach(r => { mcMap[r.groupId] = parseInt(r.cnt) || 0; });
                } catch(_) {}
            }

            const groups = memberships.map(m => {
                if (!m.userGroup) return null;
                const gid = m.userGroup.id;
                const mc  = mcMap[gid] || 0;
                return formatGroup(m.userGroup, {
                    isAdmin        : ['owner', 'admin'].includes(m.role),
                    isCreator      : m.role === 'owner',
                    role           : m.role,
                    memberCount    : mc,
                    participantCount: mc,
                    stats          : { totalMembers: mc, totalMessages: 0 },
                });
            }).filter(Boolean);

            const total      = await GroupMembers.count({ where: { userId, leftAt: null } });
            const totalPages = Math.ceil(total / limitNum);
            // DIAGNOSTIC (groups tabs showing zero — couldn't reproduce this
            // round to find a definitive cause; the query/association/format
            // all look structurally correct from static tracing). Log the
            // actual counts at each stage so if this recurs, the real
            // failure point (query found nothing vs. formatting dropped
            // rows vs. something else) is visible in server logs instead of
            // needing another round of guessing.
            if (memberships.length === 0) {
                console.warn(`[GroupService] getUserGroups: userId=${userId} has 0 memberships with leftAt=null — either genuinely no groups, or leftAt is unexpectedly set on rows that should be active`);
            } else if (groups.length !== memberships.length) {
                console.warn(`[GroupService] getUserGroups: userId=${userId} had ${memberships.length} memberships but only ${groups.length} formatted groups — some had a null userGroup (association returned nothing for that groupId, possibly a deleted/orphaned Groups row)`);
            }
            return { groups, pagination: { currentPage: pageNum, totalPages, totalGroups: total, hasNext: pageNum < totalPages, hasPrevious: pageNum > 1 } };
        } catch (e) {
            console.error('[GroupService] ❌ getUserGroups failed:', e.message, e.stack);
            return empty;
        }
    }

    // ── SEARCH GROUPS ─────────────────────────────────────────────────────────
    async searchGroups(userId, options = {}) {
        const empty = { groups: [], pagination: { currentPage: 1, totalPages: 0, totalGroups: 0 } };
        if (!Groups) return empty;
        const { query = '', page = 1, limit = 20, purpose, scope } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;
        try {
            const where = { isPublic: true };
            if (query && query.trim().length >= 2) {
                where[Op.or] = [
                    { name       : { [Op.iLike]: `%${query}%` } },
                    { description: { [Op.iLike]: `%${query}%` } },
                ];
            }
            // FIX: honour purpose filter passed from controller
            if (purpose && purpose !== 'all') where.purpose = purpose;

            // FEATURE: Discover-by-scope. 'friends' isn't a stored group attribute —
            // it's resolved per-viewer as "groups created by someone I'm friends with".
            // The other four scopes filter on the group's own discoveryScope column.
            if (scope === 'friends') {
                if (!userId || !Friends) {
                    return { groups: [], pagination: { currentPage: pageNum, totalPages: 0, totalGroups: 0 } };
                }
                const friendRows = await Friends.findAll({
                    where: {
                        status: 'accepted',
                        [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
                    },
                    attributes: ['requesterId', 'receiverId'],
                    raw: true,
                });
                const friendIds = friendRows.map(f => (f.requesterId === userId ? f.receiverId : f.requesterId));
                if (friendIds.length === 0) {
                    return { groups: [], pagination: { currentPage: pageNum, totalPages: 0, totalGroups: 0 } };
                }
                where.createdBy = { [Op.in]: friendIds };
            } else if (scope && ['community', 'region', 'county', 'world'].includes(scope)) {
                where.discoveryScope = scope;
            }

            const { count, rows } = await withTimeout(Groups.findAndCountAll({
                where,
                limit  : limitNum,
                offset,
                order  : [['createdAt', 'DESC']],
                attributes: ['id','name','description','avatar','purpose','isPublic','maxMembers','createdBy','createdAt','discoveryScope'],
            }));
            const totalPages = Math.ceil(count / limitNum);

            // FIX: Fetch real member counts for all groups in one query
            let memberCountMap = {};
            if (GroupMembers && rows.length > 0) {
                try {
                    const groupIds = rows.map(g => g.id);
                    const memberCounts = await GroupMembers.findAll({
                        where: { groupId: groupIds, leftAt: null },
                        attributes: ['groupId', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']],
                        group: ['groupId'],
                        raw: true,
                    });
                    memberCounts.forEach(mc => {
                        memberCountMap[mc.groupId] = parseInt(mc.count) || 0;
                    });
                } catch (_) {}
            }

            return {
                groups: rows.map(g => formatGroup(g, {
                    memberCount    : memberCountMap[g.id] || 0,
                    participantCount: memberCountMap[g.id] || 0,
                    stats          : { totalMembers: memberCountMap[g.id] || 0, totalMessages: 0 },
                })),
                pagination: { currentPage: pageNum, totalPages, totalGroups: count, hasNext: pageNum < totalPages, hasPrevious: pageNum > 1 }
            };
        } catch (e) {
            console.error('[GroupService] ❌ searchGroups failed:', e.message);
            return empty;
        }
    }

    // ── GET GROUP MEMBERS ─────────────────────────────────────────────────────
    async getGroupMembers(groupId, userId, options = {}) {
        const empty = { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        if (!GroupMembers) return empty;
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
                limit  : limitNum,
                offset,
                order  : [['role','ASC'], ['joinedAt','ASC']],
            }));
            const members    = rows.map(m => formatMember(m));
            const totalPages = Math.ceil(count / limitNum);
            groupServiceEvents.emit('groupMutation', { action: 'members_loaded', groupId, members, userId });
            return { members, pagination: { currentPage: pageNum, totalPages, totalMembers: count } };
        } catch (e) {
            console.error('[GroupService] ❌ getGroupMembers failed:', e.message);
            return empty;
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
                canEdit = m && ['owner', 'admin'].includes(m.role);
            }
            if (!canEdit) throw new Error('You do not have permission to update settings');

            const existing = group.settings || {};
            const mod      = settings.moderationSettings || {};
            const filtered = {
                allowMedia           : settings.allowMedia            ?? mod.allowMediaSharing    ?? existing.allowMedia            ?? true,
                allowCalls           : settings.allowCalls            ?? existing.allowCalls       ?? true,
                allowReactions       : settings.allowReactions        ?? existing.allowReactions   ?? true,
                allowReplies         : settings.allowReplies          ?? existing.allowReplies     ?? true,
                allowEditing         : settings.allowEditing          ?? existing.allowEditing     ?? true,
                allowDeleting        : settings.allowDeleting         ?? existing.allowDeleting    ?? true,
                slowMode             : settings.slowMode              ?? existing.slowMode         ?? 0,
                requireAdminApproval : settings.requireAdminApproval  ?? mod.approveNewMembers     ?? existing.requireAdminApproval  ?? false,
                allowInvites         : settings.allowInvites          ?? mod.allowInvites          ?? existing.allowInvites          ?? true,
                onlyAdminsCanPost    : settings.onlyAdminsCanPost     ?? mod.onlyAdminsCanPost     ?? existing.onlyAdminsCanPost     ?? false,
                disappearingMessages : settings.disappearingMessages  ?? mod.disappearingMessages  ?? existing.disappearingMessages  ?? false,
                archived             : settings.archived              ?? existing.archived         ?? false,
                // FIX-GROUP-THEME-NOT-SAVED: this field was previously missing here
                // entirely, so a theme sent in the request body was silently dropped
                // and never persisted, even on the correct /:groupId/settings route.
                theme                : settings.theme                 ?? existing.theme            ?? 'blue',
            };

            const updatePayload = { settings: { ...existing, ...filtered } };
            if (settings.privacy !== undefined) updatePayload.isPublic = settings.privacy === 'public';

            // ── P1 FIX: Persist critical moderation fields as dedicated DB columns ──
            // slowModeInterval (seconds, 0 = disabled)
            const slowSecs = settings.slowModeInterval ?? (settings.slowMode ? settings.slowMode * 60 : undefined);
            if (slowSecs !== undefined) updatePayload.slowModeInterval = Math.max(0, parseInt(slowSecs) || 0);

            // postingRule: open / read_only / announcement / admin_only / scheduled
            if (settings.postingRule) {
                const validRules = ['open', 'read_only', 'announcement', 'admin_only', 'scheduled'];
                if (validRules.includes(settings.postingRule)) updatePayload.postingRule = settings.postingRule;
            } else if (filtered.onlyAdminsCanPost) {
                updatePayload.postingRule = 'admin_only';
            }

            // disappearingTimer (seconds, 0 = disabled). Also accept boolean flag
            if (settings.disappearingTimer !== undefined) {
                updatePayload.disappearingTimer = Math.max(0, parseInt(settings.disappearingTimer) || 0);
            } else if (settings.disappearingMessages === false) {
                updatePayload.disappearingTimer = 0;
            }

            // blockedWords
            if (Array.isArray(settings.blockedWords)) {
                updatePayload.blockedWords = settings.blockedWords.map(w => String(w).trim().toLowerCase()).filter(Boolean);
            }

            // scheduledPostingWindow
            if (settings.scheduledPostingStart) updatePayload.scheduledPostingStart = settings.scheduledPostingStart;
            if (settings.scheduledPostingEnd)   updatePayload.scheduledPostingEnd   = settings.scheduledPostingEnd;

            await group.update(updatePayload);
            // FIX: compute the real member count instead of formatGroup's
            // always-0 default.
            const _mc2 = GroupMembers ? await GroupMembers.count({ where: { groupId, leftAt: null } }) : 0;
            const formatted = formatGroup(group, { memberCount: _mc2, participantCount: _mc2, stats: { totalMembers: _mc2, totalMessages: 0 } });
            groupServiceEvents.emit('groupMutation', { action: 'update', group: formatted, userId });
            return formatted;
        } catch (e) {
            console.error('[GroupService] ❌ updateGroupSettings failed:', e.message);
            throw e;
        }
    }

    // ── TRANSFER OWNERSHIP ────────────────────────────────────────────────────
    async transferOwnership(groupId, userId, newOwnerId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const ownerMembership = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
            if (!ownerMembership || ownerMembership.role !== 'owner') throw new Error('Only the group owner can transfer ownership');
            const newOwnerMembership = await GroupMembers.findOne({ where: { groupId, userId: newOwnerId, leftAt: null } });
            if (!newOwnerMembership) throw new Error('New owner must be a current group member');
            ownerMembership.role    = 'admin';
            await ownerMembership.save();
            newOwnerMembership.role = 'owner';
            await newOwnerMembership.save();
            if (Groups) await Groups.update({ createdBy: newOwnerId }, { where: { id: groupId } });
            console.log(`[GroupService] ✅ Group ${groupId} ownership transferred to ${newOwnerId}`);
            groupServiceEvents.emit('groupMutation', { action: 'update', groupId, userId: newOwnerId });
            return { transferred: true, groupId, newOwnerId };
        } catch (e) {
            console.error('[GroupService] ❌ transferOwnership failed:', e.message);
            throw e;
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
                GroupMembers.count({ where: { groupId, leftAt: null, role: { [Op.in]: ['owner', 'admin'] } } }),
            ]);
            return { totalMembers, totalAdmins, groupId, groupName: group.name, isPublic: group.isPublic, purpose: group.purpose, createdAt: group.createdAt };
        } catch (e) {
            console.error('[GroupService] ❌ getGroupStatistics failed:', e.message);
            throw e;
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
            // FIX: compute the real member count instead of formatGroup's
            // always-0 default.
            const _mc3 = GroupMembers ? await GroupMembers.count({ where: { groupId, leftAt: null } }) : 0;
            const formatted = formatGroup(group, { memberCount: _mc3, participantCount: _mc3, stats: { totalMembers: _mc3, totalMessages: 0 } });
            groupServiceEvents.emit('groupMutation', { action: archived ? 'archive' : 'unarchive', group: formatted, userId });
            return formatted;
        } catch (e) {
            console.error('[GroupService] ❌ archiveGroup failed:', e.message);
            throw e;
        }
    }

    // ── GET GROUP INVITATIONS ─────────────────────────────────────────────────
    async getGroupInvitations(userId, options = {}) {
        // FIX: try all common Invites model names
        const Invites = _getInvitesModel();
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
                include: [{
                    model     : Groups,
                    as        : 'userGroup',
                    attributes: ['id','name','avatar','description','purpose'],
                    required  : false,
                }],
                limit  : limitNum,
                offset,
                order  : [['createdAt', 'DESC']],
            }));
            return { invitations: rows, pagination: { currentPage: pageNum, totalPages: Math.ceil(count / limitNum), total: count } };
        } catch (e) {
            console.error('[GroupService] ❌ getGroupInvitations failed:', e.message);
            return { invitations: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        }
    }

    // ── SEND INVITATION ───────────────────────────────────────────────────────
    async sendInvitation(groupId, userId, inviteeId, role = 'member', message = '') {
        const Invites = _getInvitesModel();
        if (!Invites) throw new Error('Invite service unavailable');
        try {
            const already = await GroupMembers?.findOne({ where: { groupId, userId: inviteeId, leftAt: null } });
            if (already) throw new Error('User is already a member of this group');
            const existing = await Invites.findOne({ where: { groupId, targetUserId: inviteeId, status: 'pending' } });
            if (existing) throw new Error('User is already invited to this group');
            const invitation = await Invites.create({
                groupId,
                inviterId   : userId,
                targetUserId: inviteeId,
                message,
                role,
                status      : 'pending',
                expiresAt   : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            });
            console.log(`[GroupService] ✅ Invitation sent to user ${inviteeId} for group ${groupId}`);
            return invitation;
        } catch (e) {
            console.error('[GroupService] ❌ sendInvitation failed:', e.message);
            throw e;
        }
    }

    // ── RESPOND TO INVITATION ─────────────────────────────────────────────────
    async respondToInvitation(invitationId, userId, accept) {
        const Invites = _getInvitesModel();
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invitation = await Invites.findOne({ where: { id: invitationId, targetUserId: userId, status: 'pending' } });
            if (!invitation) throw new Error('Invitation not found or already responded');
            if (accept && GroupMembers) {
                const [member] = await GroupMembers.findOrCreate({
                    where   : { groupId: invitation.groupId, userId },
                    defaults: { role: 'member', joinedAt: new Date() },
                });
                if (member.leftAt) await member.update({ leftAt: null, joinedAt: new Date() });
            }
            invitation.status = accept ? 'accepted' : 'rejected';
            await invitation.save();
            console.log(`[GroupService] ✅ Invitation ${invitationId} ${accept ? 'accepted' : 'rejected'} by user ${userId}`);
            return { accepted: accept, group: accept ? await Groups?.findByPk(invitation.groupId) : null };
        } catch (e) {
            console.error('[GroupService] ❌ respondToInvitation failed:', e.message);
            throw e;
        }
    }

    // ── CANCEL INVITATION ─────────────────────────────────────────────────────
    async cancelInvitation(invitationId, userId) {
        const Invites = _getInvitesModel();
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invitation = await Invites.findOne({ where: { id: invitationId, inviterId: userId } });
            if (!invitation) throw new Error('Invitation not found or you do not have permission to cancel it');
            await invitation.destroy();
            return true;
        } catch (e) {
            console.error('[GroupService] ❌ cancelInvitation failed:', e.message);
            throw e;
        }
    }
}

const groupServiceInstance = new GroupService();

module.exports = groupServiceInstance;
module.exports.groupServiceEvents = groupServiceEvents;