// groupMembersService.js
// ============================================================
// FIXED: This file was completely missing, causing groupMembersController.js
// to crash on require('../services/groupMembersService') — a hard boot error
// that brought down ALL group-member routes (members, invites, ban, mute, etc.)
//
// This service owns all member-scoped operations:
//   getGroupMembers, addMemberToGroup, removeMemberFromGroup, updateMemberRole,
//   getMemberDetails, getPendingInvitations, inviteToGroup, acceptInvitation,
//   rejectInvitation, cancelInvitation, leaveGroup, transferOwnership,
//   getMemberStatistics, searchMembers, muteMember, unmuteMember,
//   banMember, unbanMember, getBannedMembers, getOnlineMembers,
//   getMemberActivity, exportMembersList, getUserInvitations, getSentInvitations
//
// LOCAL-FIRST: Every write emits a 'memberMutation' event so groupMembersController
// can push to sockets → client calls LocalGroupStore.saveMemberLocal() immediately.
// ============================================================

const EventEmitter = require('events');
const { Op } = require('sequelize');

// ── Model resolution ──────────────────────────────────────────────────────────
let db, Groups, GroupMembers, Users, Invites, Chats, ChatParticipant;
try {
    db = require('../models');
    const m = db.models || {};
    Groups          = m.Groups          || m.Group          || db.Groups          || db.Group;
    GroupMembers    = m.GroupMembers    || m.GroupMember    || db.GroupMembers    || db.GroupMember;
    Users           = m.Users           || m.User           || db.Users           || db.User;
    Invites         = m.Invites         || m.Invite         || db.Invites         || db.Invite;
    Chats           = m.Chats           || m.Chat           || db.Chats           || db.Chat;
    ChatParticipant = m.ChatParticipants || m.ChatParticipant || db.ChatParticipants || db.ChatParticipant;
} catch (e) {
    console.error('[GroupMembersService] ❌ Model load failed:', e.message);
}

// ── Internal event bus ────────────────────────────────────────────────────────
// groupMembersController subscribes so every DB write gets pushed to sockets.
const memberServiceEvents = new EventEmitter();
memberServiceEvents.setMaxListeners(20);

// ── Helpers ───────────────────────────────────────────────────────────────────
const withTimeout = (promise, ms = 6000) => {
    let tid;
    const t = new Promise((_, reject) => {
        tid = setTimeout(() => reject(new Error('Query timeout')), ms);
    });
    return Promise.race([promise, t]).finally(() => clearTimeout(tid));
};

function safeArray(v) { return Array.isArray(v) ? v : []; }
function nowIso() { return new Date().toISOString(); }

// Canonical member shape consumed by LocalGroupStore.saveMemberLocal()
function formatMember(m, userRecord = null) {
    if (!m) return null;
    const d = m.toJSON ? m.toJSON() : m;
    const u = userRecord || d.groupMemberUser || d.user || null;
    return {
        id      : d.id,
        groupId : d.groupId,
        userId  : d.userId,
        role    : d.role     || 'member',
        joinedAt: d.joinedAt || d.createdAt,
        leftAt  : d.leftAt   || null,
        notificationsMuted: d.notificationsMuted || false,
        customSettings    : d.customSettings     || {},
        // Embedded user snapshot (for offline UI)
        user: u ? {
            id      : u.id,
            username: u.username || '',
            avatar  : u.avatar   || null,
            status  : u.status   || 'offline',
            firstName: u.firstName || '',
            lastName : u.lastName  || '',
        } : null,
    };
}

// ── Permission helpers ────────────────────────────────────────────────────────
async function requireMembership(groupId, userId, minRole = 'member') {
    if (!GroupMembers) throw new Error('Service unavailable');
    const m = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
    if (!m) throw new Error('You are not a member of this group');
    const hierarchy = ['member', 'moderator', 'admin', 'owner'];
    if (hierarchy.indexOf(m.role) < hierarchy.indexOf(minRole)) {
        throw new Error('You do not have permission for this action');
    }
    return m;
}

async function resolveGroup(groupId) {
    if (!Groups) throw new Error('Service unavailable');
    const g = await Groups.findByPk(groupId);
    if (!g) throw new Error('Group not found');
    return g;
}

// ── Service class ─────────────────────────────────────────────────────────────
class GroupMembersService {

    // ── GET MEMBERS ──────────────────────────────────────────────────────────
    async getGroupMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers) return { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        const { page = 1, limit = 50, role, onlineOnly = false, search, sortBy = 'joinedAt', sortOrder = 'desc' } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;

        try {
            // Caller must be a member to see the list
            await requireMembership(groupId, requestingUserId);

            const where = { groupId, leftAt: null };
            if (role) where.role = role;

            const userWhere = {};
            if (search) {
                userWhere[Op.or] = [
                    { username: { [Op.iLike]: `%${search}%` } },
                    { firstName: { [Op.iLike]: `%${search}%` } },
                    { lastName:  { [Op.iLike]: `%${search}%` } },
                ];
            }
            if (onlineOnly) userWhere.status = 'online';

            const order = sortBy === 'role'
                ? [['role', sortOrder === 'desc' ? 'DESC' : 'ASC'], ['joinedAt', 'ASC']]
                : [['joinedAt', sortOrder === 'desc' ? 'DESC' : 'ASC']];

            const { count, rows } = await withTimeout(GroupMembers.findAndCountAll({
                where,
                include: [{
                    model: Users, as: 'groupMemberUser',
                    attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'],
                    required: !!search || onlineOnly,
                    where: Object.keys(userWhere).length ? userWhere : undefined,
                }],
                limit: limitNum, offset, order,
            }));

            const members = rows.map(r => formatMember(r));
            const totalPages = Math.ceil(count / limitNum);
            return { members, pagination: { currentPage: pageNum, totalPages, totalMembers: count, hasNext: pageNum < totalPages, hasPrevious: pageNum > 1 } };
        } catch (e) {
            if (['not a member','permission','not found'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] getGroupMembers error:', e.message);
            return { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        }
    }

    // ── ADD MEMBER (direct, bypasses invitation flow) ────────────────────────
    async addMemberToGroup(groupId, requestingUserId, memberId, role = 'member', sendNotification = true) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const group = await resolveGroup(groupId);
            await requireMembership(groupId, requestingUserId, 'admin');

            // Check ban
            const existing = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (existing?.customSettings?.bannedAt && !existing.leftAt) throw new Error('User is banned from this group');
            if (existing && !existing.leftAt) throw new Error('User is already a member of this group');

            // Check capacity
            const count = await GroupMembers.count({ where: { groupId, leftAt: null } });
            if (count >= (group.maxMembers || 100)) throw new Error('Group has reached maximum members limit');

            let member;
            if (existing) {
                // Re-joining after leaving
                await existing.update({ role, leftAt: null, joinedAt: new Date() });
                member = existing;
            } else {
                member = await GroupMembers.create({ groupId, userId: memberId, role, joinedAt: new Date() });
            }

            // Add to chat participants if applicable
            if (ChatParticipant && group.chatId) {
                await ChatParticipant.findOrCreate({ where: { chatId: group.chatId, userId: memberId } }).catch(() => {});
            }

            const formatted = formatMember(member);
            console.log(`[GroupMembersService] ✅ Member ${memberId} added to group ${groupId}`);
            memberServiceEvents.emit('memberMutation', { action: 'add', groupId, member: formatted, requestedBy: requestingUserId });
            return formatted;
        } catch (e) {
            if (['not found','banned','already a member','admins','maximum','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] addMemberToGroup error:', e.message);
            throw new Error('Failed to add member');
        }
    }

    // ── REMOVE MEMBER ────────────────────────────────────────────────────────
    async removeMemberFromGroup(groupId, requestingUserId, memberId, reason = '') {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const requester = await requireMembership(groupId, requestingUserId, 'admin');
            const target = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!target) throw new Error('Member not found in this group');
            if (target.role === 'owner') throw new Error('Cannot remove the group owner');
            // Admins cannot remove other admins unless they are owner
            if (target.role === 'admin' && requester.role !== 'owner') throw new Error('Only the owner can remove admins');

            await target.update({ leftAt: new Date() });

            console.log(`[GroupMembersService] ✅ Member ${memberId} removed from group ${groupId}`);
            memberServiceEvents.emit('memberMutation', { action: 'remove', groupId, userId: memberId, requestedBy: requestingUserId, reason });
            return { removed: true, groupId, userId: memberId };
        } catch (e) {
            if (['not found','owner','admin','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] removeMemberFromGroup error:', e.message);
            throw new Error('Failed to remove member');
        }
    }

    // ── UPDATE ROLE ──────────────────────────────────────────────────────────
    async updateMemberRole(groupId, requestingUserId, memberId, role) {
        if (!GroupMembers) throw new Error('Service unavailable');
        const validRoles = ['member', 'moderator', 'admin', 'owner'];
        if (!validRoles.includes(role)) throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
        try {
            const requester = await requireMembership(groupId, requestingUserId, 'admin');
            const target = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!target) throw new Error('Member not found in this group');
            if (role === 'owner' && requester.role !== 'owner') throw new Error('Only the current owner can transfer ownership');

            await target.update({ role });
            const formatted = formatMember(target);
            console.log(`[GroupMembersService] ✅ Role updated: member ${memberId} → ${role} in group ${groupId}`);
            memberServiceEvents.emit('memberMutation', { action: 'role_update', groupId, member: formatted, requestedBy: requestingUserId });
            return formatted;
        } catch (e) {
            if (['Invalid','not found','owner','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] updateMemberRole error:', e.message);
            throw new Error('Failed to update member role');
        }
    }

    // ── GET MEMBER DETAILS ───────────────────────────────────────────────────
    async getMemberDetails(groupId, memberId, requestingUserId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            await requireMembership(groupId, requestingUserId);
            const member = await withTimeout(GroupMembers.findOne({
                where: { groupId, userId: memberId },
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen','bio'], required: false }],
            }));
            if (!member) throw new Error('Member not found in this group');
            return formatMember(member);
        } catch (e) {
            if (['not found','permission'].some(s => e.message.includes(s))) throw e;
            throw new Error('Failed to get member details');
        }
    }

    // ── INVITATIONS: GET PENDING ──────────────────────────────────────────────
    async getPendingInvitations(groupId, requestingUserId, options = {}) {
        if (!Invites) return { invitations: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        const { page = 1, limit = 50, sortBy = 'createdAt', sortOrder = 'desc' } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, parseInt(limit));
        const offset   = (pageNum - 1) * limitNum;
        try {
            await requireMembership(groupId, requestingUserId, 'admin');
            const { count, rows } = await withTimeout(Invites.findAndCountAll({
                where: { groupId, status: 'pending' },
                include: [
                    { model: Users, as: 'inviter',     attributes: ['id','username','avatar'], foreignKey: 'inviterId',     required: false },
                    { model: Users, as: 'invitee',     attributes: ['id','username','avatar'], foreignKey: 'targetUserId',  required: false },
                ],
                limit: limitNum, offset,
                order: [[sortBy, sortOrder === 'desc' ? 'DESC' : 'ASC']],
            }));
            return { invitations: rows, pagination: { currentPage: pageNum, totalPages: Math.ceil(count / limitNum), total: count } };
        } catch (e) {
            if (['permission','not found'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] getPendingInvitations error:', e.message);
            return { invitations: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        }
    }

    // ── INVITATIONS: SEND / INVITE ────────────────────────────────────────────
    // Smart routing:
    //   1. Group requireAdminApproval=true   → always invite (create invite record)
    //   2. Invitee privacy whoCanAddMe=nobody → always invite (respect user restriction)
    //   3. Invitee privacy whoCanAddMe=contacts and inviter not a contact → invite
    //   4. Otherwise → add directly as member
    async inviteToGroup(groupId, inviterId, inviteeId, role = 'member', message = '') {
        try {
            const group = await resolveGroup(groupId);
            await requireMembership(groupId, inviterId, 'member'); // FIX: any member can invite friends, not just admins;

            // ── Check if invitee is banned ─────────────────────────────────────
            const inviteeMember = await GroupMembers?.findOne({ where: { groupId, userId: inviteeId } });
            if (inviteeMember?.customSettings?.bannedAt && !inviteeMember.leftAt) {
                throw new Error('This user is banned from the group');
            }
            if (inviteeMember && !inviteeMember.leftAt) {
                return { action: 'already_member', member: formatMember(inviteeMember) };
            }

            // ── Resolve invitee privacy settings ──────────────────────────────
            // whoCanAddMe values: 'everyone' | 'contacts' | 'nobody'
            // Stored in Users.privacySettings.whoCanAddMe  OR  Users.settings.whoCanAddMe
            let inviteePrivacy = 'everyone'; // safe default — direct add allowed
            if (Users) {
                try {
                    const inviteeUser = await Users.findByPk(inviteeId, {
                        attributes: ['id', 'privacySettings', 'settings'],
                    });
                    if (inviteeUser) {
                        const ps = inviteeUser.privacySettings || inviteeUser.settings?.privacy || {};
                        inviteePrivacy = ps.whoCanAddMe || ps.groupAddPolicy || ps.allowGroupAdds || 'everyone';
                        // Normalize boolean legacy field: allowGroupAdds=false → 'nobody'
                        if (inviteePrivacy === false) inviteePrivacy = 'nobody';
                        if (inviteePrivacy === true)  inviteePrivacy = 'everyone';
                    }
                } catch (privacyErr) {
                    // Privacy lookup failed — default to safe (allow direct add)
                    console.warn('[GroupMembersService] Privacy lookup failed, defaulting to everyone:', privacyErr.message);
                }
            }

            // ── Determine add vs invite ────────────────────────────────────────
            const requiresApproval = group.settings?.requireAdminApproval ?? false;

            // 'nobody' — invitee has blocked all direct adds; must use invite
            const userBlocksDirectAdd = inviteePrivacy === 'nobody' || inviteePrivacy === 'invite_required';

            // 'contacts' — only direct-add if inviter is a contact of invitee
            let inviterIsContact = true; // optimistic default
            if (inviteePrivacy === 'contacts' && Users) {
                try {
                    // Check Contacts/Friends table if it exists
                    const ContactModel = db?.models?.Contacts || db?.models?.Friends || db?.Contacts || db?.Friends;
                    if (ContactModel) {
                        const contact = await ContactModel.findOne({
                            where: {
                                userId: inviteeId,
                                contactId: inviterId,
                                status: 'accepted',
                            }
                        });
                        inviterIsContact = !!contact;
                    }
                } catch (_) {
                    // Contacts table may not exist — keep optimistic true
                }
            }

            const mustSendInvite = requiresApproval || userBlocksDirectAdd || (inviteePrivacy === 'contacts' && !inviterIsContact);

            if (!mustSendInvite) {
                // ── DIRECT ADD ──────────────────────────────────────────────
                const member = await this.addMemberToGroup(groupId, inviterId, inviteeId, role, true);
                return { action: 'member_added', member };
            }

            // ── SEND INVITATION RECORD ────────────────────────────────────────
            if (!Invites) throw new Error('Invite service unavailable');
            const existingInvite = await Invites.findOne({ where: { groupId, targetUserId: inviteeId, status: 'pending' } });
            if (existingInvite) throw new Error('User is already invited to this group');

            const invitation = await Invites.create({
                groupId,
                inviterId,
                targetUserId: inviteeId,
                message,
                status: 'pending',
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            });

            const reason = userBlocksDirectAdd ? 'user_privacy' : requiresApproval ? 'group_approval' : 'not_contact';
            console.log(`[GroupMembersService] ✅ Invitation sent (reason=${reason}): user ${inviteeId} → group ${groupId}`);
            return { action: 'invite_sent', invitation, reason };
        } catch (e) {
            if (['not found','banned','already','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] inviteToGroup error:', e.message);
            throw new Error('Failed to send invitation');
        }
    }

    // ── INVITATIONS: ACCEPT ───────────────────────────────────────────────────
    async acceptInvitation(invitationId, userId) {
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invite = await Invites.findOne({ where: { id: invitationId, targetUserId: userId, status: 'pending' } });
            if (!invite) throw new Error('Invitation not found or already responded to');
            if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) throw new Error('Invitation has expired');

            const group = await resolveGroup(invite.groupId);

            // Check capacity
            const count = await GroupMembers?.count({ where: { groupId: invite.groupId, leftAt: null } }) || 0;
            if (count >= (group.maxMembers || 100)) throw new Error('Group is full');

            // Upsert membership
            const [member] = await GroupMembers.findOrCreate({
                where: { groupId: invite.groupId, userId },
                defaults: { role: 'member', joinedAt: new Date() },
            });
            if (member.leftAt) await member.update({ leftAt: null, joinedAt: new Date() });

            // Add to chat participants
            if (ChatParticipant && group.chatId) {
                await ChatParticipant.findOrCreate({ where: { chatId: group.chatId, userId } }).catch(() => {});
            }

            await invite.update({ status: 'accepted' });
            const formatted = formatMember(member);
            console.log(`[GroupMembersService] ✅ Invitation ${invitationId} accepted by user ${userId}`);
            memberServiceEvents.emit('memberMutation', { action: 'add', groupId: invite.groupId, member: formatted, requestedBy: userId });
            return { accepted: true, groupId: invite.groupId, invitedBy: invite.inviterId, member: formatted };
        } catch (e) {
            if (['not found','responded','expired','full'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] acceptInvitation error:', e.message);
            throw new Error('Failed to accept invitation');
        }
    }

    // ── INVITATIONS: REJECT ───────────────────────────────────────────────────
    async rejectInvitation(invitationId, userId, reason = '') {
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invite = await Invites.findOne({ where: { id: invitationId, targetUserId: userId, status: 'pending' } });
            if (!invite) throw new Error('Invitation not found or already responded to');
            await invite.update({ status: 'rejected' });
            console.log(`[GroupMembersService] ✅ Invitation ${invitationId} rejected`);
            return { rejected: true, groupId: invite.groupId, invitedBy: invite.inviterId };
        } catch (e) {
            if (['not found','responded'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] rejectInvitation error:', e.message);
            throw new Error('Failed to reject invitation');
        }
    }

    // ── INVITATIONS: CANCEL ───────────────────────────────────────────────────
    async cancelInvitation(invitationId, requestingUserId) {
        if (!Invites) throw new Error('Service unavailable');
        try {
            const invite = await Invites.findOne({ where: { id: invitationId } });
            if (!invite) throw new Error('Invitation not found');
            // Only inviter or group admin can cancel
            const isInviter = String(invite.inviterId) === String(requestingUserId);
            let isAdmin = false;
            if (!isInviter && GroupMembers) {
                const m = await GroupMembers.findOne({ where: { groupId: invite.groupId, userId: requestingUserId, leftAt: null } });
                isAdmin = m && ['admin','owner'].includes(m.role);
            }
            if (!isInviter && !isAdmin) throw new Error('You do not have permission to cancel this invitation');
            const inviteeId = invite.targetUserId;
            const groupId   = invite.groupId;
            await invite.destroy();
            console.log(`[GroupMembersService] ✅ Invitation ${invitationId} cancelled`);
            return { cancelled: true, groupId, inviteeId };
        } catch (e) {
            if (['not found','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] cancelInvitation error:', e.message);
            throw new Error('Failed to cancel invitation');
        }
    }

    // ── LEAVE GROUP ───────────────────────────────────────────────────────────
    async leaveGroup(groupId, userId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const m = await GroupMembers.findOne({ where: { groupId, userId, leftAt: null } });
            if (!m) throw new Error('You are not a member of this group');
            if (m.role === 'owner') throw new Error('Group owner cannot leave. Transfer ownership first.');
            await m.update({ leftAt: new Date() });
            console.log(`[GroupMembersService] ✅ User ${userId} left group ${groupId}`);
            memberServiceEvents.emit('memberMutation', { action: 'leave', groupId, userId });
            return { left: true, groupId };
        } catch (e) {
            if (['not a member','cannot leave','owner'].some(s => e.message.toLowerCase().includes(s))) throw e;
            console.error('[GroupMembersService] leaveGroup error:', e.message);
            throw new Error('Failed to leave group');
        }
    }

    // ── TRANSFER OWNERSHIP ────────────────────────────────────────────────────
    async transferOwnership(groupId, currentOwnerId, newOwnerId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const owner = await GroupMembers.findOne({ where: { groupId, userId: currentOwnerId, leftAt: null } });
            if (!owner || owner.role !== 'owner') throw new Error('Only the group owner can transfer ownership');
            const newOwner = await GroupMembers.findOne({ where: { groupId, userId: newOwnerId, leftAt: null } });
            if (!newOwner) throw new Error('New owner must be a current group member');

            await owner.update({ role: 'admin' });
            await newOwner.update({ role: 'owner' });
            if (Groups) await Groups.update({ createdBy: newOwnerId }, { where: { id: groupId } });

            console.log(`[GroupMembersService] ✅ Ownership of group ${groupId} transferred to ${newOwnerId}`);
            memberServiceEvents.emit('memberMutation', { action: 'ownership_transfer', groupId, newOwnerId, previousOwnerId: currentOwnerId });
            return { transferred: true, groupId, newOwnerId, previousOwnerId: currentOwnerId };
        } catch (e) {
            if (['owner','must be'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] transferOwnership error:', e.message);
            throw new Error('Failed to transfer ownership');
        }
    }

    // ── STATISTICS ────────────────────────────────────────────────────────────
    async getMemberStatistics(groupId, requestingUserId) {
        if (!GroupMembers) return { totalMembers: 0, totalAdmins: 0, totalModerators: 0 };
        try {
            await requireMembership(groupId, requestingUserId, 'admin');
            const [total, admins, moderators, owners] = await Promise.all([
                GroupMembers.count({ where: { groupId, leftAt: null } }),
                GroupMembers.count({ where: { groupId, leftAt: null, role: 'admin' } }),
                GroupMembers.count({ where: { groupId, leftAt: null, role: 'moderator' } }),
                GroupMembers.count({ where: { groupId, leftAt: null, role: 'owner' } }),
            ]);
            return { totalMembers: total, totalAdmins: admins + owners, totalModerators: moderators, totalOwners: owners };
        } catch (e) {
            if (e.message.includes('permission')) throw e;
            console.error('[GroupMembersService] getMemberStatistics error:', e.message);
            throw new Error('Failed to get member statistics');
        }
    }

    // ── SEARCH MEMBERS ────────────────────────────────────────────────────────
    async searchMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers) return { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        const { query, page = 1, limit = 20, role, onlineOnly } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(50, parseInt(limit));
        const offset   = (pageNum - 1) * limitNum;
        try {
            await requireMembership(groupId, requestingUserId);
            const memberWhere = { groupId, leftAt: null };
            if (role) memberWhere.role = role;

            const userWhere = {};
            if (query) {
                userWhere[Op.or] = [
                    { username: { [Op.iLike]: `%${query}%` } },
                    { firstName: { [Op.iLike]: `%${query}%` } },
                    { lastName:  { [Op.iLike]: `%${query}%` } },
                ];
            }
            if (onlineOnly) userWhere.status = 'online';

            const { count, rows } = await withTimeout(GroupMembers.findAndCountAll({
                where: memberWhere,
                include: [{
                    model: Users, as: 'groupMemberUser',
                    attributes: ['id','username','avatar','firstName','lastName','status'],
                    required: true,
                    where: Object.keys(userWhere).length ? userWhere : undefined,
                }],
                limit: limitNum, offset,
                order: [['joinedAt', 'DESC']],
            }));
            return { members: rows.map(r => formatMember(r)), pagination: { currentPage: pageNum, totalPages: Math.ceil(count / limitNum), totalMembers: count } };
        } catch (e) {
            if (e.message.includes('permission')) throw e;
            console.error('[GroupMembersService] searchMembers error:', e.message);
            return { members: [], pagination: { currentPage: 1, totalPages: 0, totalMembers: 0 } };
        }
    }

    // ── MUTE MEMBER ───────────────────────────────────────────────────────────
    async muteMember(groupId, requestingUserId, memberId, duration = null, reason = '') {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            await requireMembership(groupId, requestingUserId, 'moderator');
            const target = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!target) throw new Error('Member not found in this group');
            const mutedUntil = duration ? new Date(Date.now() + duration * 60 * 1000) : null;
            const settings = { ...target.customSettings, mutedAt: nowIso(), mutedUntil, muteReason: reason };
            await target.update({ notificationsMuted: true, customSettings: settings });
            console.log(`[GroupMembersService] ✅ Member ${memberId} muted in group ${groupId}`);
            return { muted: true, mutedUntil, userId: memberId, groupId };
        } catch (e) {
            if (['not found','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] muteMember error:', e.message);
            throw new Error('Failed to mute member');
        }
    }

    // ── UNMUTE MEMBER ─────────────────────────────────────────────────────────
    async unmuteMember(groupId, requestingUserId, memberId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            await requireMembership(groupId, requestingUserId, 'moderator');
            const target = await GroupMembers.findOne({ where: { groupId, userId: memberId, leftAt: null } });
            if (!target) throw new Error('Member not found in this group');
            const settings = { ...target.customSettings, mutedAt: null, mutedUntil: null, muteReason: null };
            await target.update({ notificationsMuted: false, customSettings: settings });
            console.log(`[GroupMembersService] ✅ Member ${memberId} unmuted in group ${groupId}`);
            return { unmuted: true, userId: memberId, groupId };
        } catch (e) {
            if (['not found','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] unmuteMember error:', e.message);
            throw new Error('Failed to unmute member');
        }
    }

    // ── BAN MEMBER ────────────────────────────────────────────────────────────
    async banMember(groupId, requestingUserId, memberId, duration = null, reason = '') {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            await requireMembership(groupId, requestingUserId, 'admin');
            const target = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (target?.role === 'owner') throw new Error('Cannot ban the group owner');
            if (target?.customSettings?.bannedAt && !target.leftAt) throw new Error('Member is already banned');

            const banExpiry = duration ? new Date(Date.now() + duration * 60 * 60 * 1000) : null;
            const settings = { bannedAt: nowIso(), banReason: reason, banExpiry };

            if (target) {
                await target.update({ leftAt: new Date(), customSettings: settings });
            } else {
                await GroupMembers.create({ groupId, userId: memberId, role: 'member', joinedAt: new Date(), leftAt: new Date(), customSettings: settings });
            }

            console.log(`[GroupMembersService] ✅ Member ${memberId} banned from group ${groupId}`);
            memberServiceEvents.emit('memberMutation', { action: 'ban', groupId, userId: memberId, requestedBy: requestingUserId, reason, banExpiry });
            return { banned: true, userId: memberId, groupId, expiresAt: banExpiry };
        } catch (e) {
            if (['owner','already banned','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] banMember error:', e.message);
            throw new Error('Failed to ban member');
        }
    }

    // ── UNBAN MEMBER ──────────────────────────────────────────────────────────
    async unbanMember(groupId, requestingUserId, memberId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            await requireMembership(groupId, requestingUserId, 'admin');
            const target = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!target?.customSettings?.bannedAt) throw new Error('Member is not banned');
            const settings = { ...target.customSettings, bannedAt: null, banReason: null, banExpiry: null };
            await target.update({ customSettings: settings });
            console.log(`[GroupMembersService] ✅ Member ${memberId} unbanned from group ${groupId}`);
            return { unbanned: true, userId: memberId, groupId };
        } catch (e) {
            if (['not banned','permission'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] unbanMember error:', e.message);
            throw new Error('Failed to unban member');
        }
    }

    // ── GET BANNED MEMBERS ────────────────────────────────────────────────────
    async getBannedMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers) return { members: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        const { page = 1, limit = 50, activeOnly = true } = options;
        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, parseInt(limit));
        const offset   = (pageNum - 1) * limitNum;
        try {
            await requireMembership(groupId, requestingUserId, 'admin');
            // Use raw query for JSONB field since Sequelize JSONB operators vary by version
            const all = await withTimeout(GroupMembers.findAll({
                where: { groupId },
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar'], required: false }],
            }));
            let banned = all.filter(m => m.customSettings?.bannedAt);
            if (activeOnly) {
                banned = banned.filter(m => !m.customSettings?.banExpiry || new Date(m.customSettings.banExpiry) > new Date());
            }
            const total = banned.length;
            const page_ = banned.slice(offset, offset + limitNum);
            return { members: page_.map(m => formatMember(m)), pagination: { currentPage: pageNum, totalPages: Math.ceil(total / limitNum), total } };
        } catch (e) {
            if (e.message.includes('permission')) throw e;
            console.error('[GroupMembersService] getBannedMembers error:', e.message);
            return { members: [], pagination: { currentPage: 1, totalPages: 0, total: 0 } };
        }
    }

    // ── GET ONLINE MEMBERS ────────────────────────────────────────────────────
    async getOnlineMembers(groupId, requestingUserId, options = {}) {
        return this.getGroupMembers(groupId, requestingUserId, { ...options, onlineOnly: true });
    }

    // ── GET MEMBER ACTIVITY ───────────────────────────────────────────────────
    async getMemberActivity(groupId, memberId, requestingUserId, options = {}) {
        // Activity log — lightweight implementation using group messages/events
        // A full implementation would query an ActivityLog table; this returns a safe stub
        // that won't throw. Replace with real ActivityLog.findAll() when table exists.
        try {
            await requireMembership(groupId, requestingUserId);
            return {
                activities: [],
                pagination: { currentPage: 1, totalPages: 0, total: 0 },
                note: 'Activity log table not yet implemented — stub response',
            };
        } catch (e) {
            if (e.message.includes('permission')) throw e;
            throw new Error('Failed to get member activity');
        }
    }

    // ── EXPORT MEMBERS LIST ───────────────────────────────────────────────────
    async exportMembersList(groupId, requestingUserId, options = {}) {
        const { format = 'json', includeRole = true, includeJoinDate = true, includeLastSeen = true } = options;
        try {
            await requireMembership(groupId, requestingUserId, 'admin');
            const { members } = await this.getGroupMembers(groupId, requestingUserId, { limit: 1000 });

            if (format === 'csv') {
                const headers = ['userId', 'username'];
                if (includeRole)     headers.push('role');
                if (includeJoinDate) headers.push('joinedAt');
                if (includeLastSeen) headers.push('lastSeen');
                const rows = members.map(m => {
                    const cols = [m.userId, m.user?.username || ''];
                    if (includeRole)     cols.push(m.role);
                    if (includeJoinDate) cols.push(m.joinedAt || '');
                    if (includeLastSeen) cols.push(m.user?.lastSeen || '');
                    return cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',');
                });
                return [headers.join(','), ...rows].join('\n');
            }

            return { members, exportedAt: nowIso(), groupId };
        } catch (e) {
            if (e.message.includes('permission')) throw e;
            console.error('[GroupMembersService] exportMembersList error:', e.message);
            throw new Error('Failed to export members list');
        }
    }

    // ── USER INVITATIONS (across all groups, received by this user) ───────────
    async getUserInvitations(userId, status = 'pending') {
        if (!Invites) return { invitations: [], total: 0 };
        try {
            const where = { targetUserId: userId };
            if (status !== 'all') where.status = status;
            const rows = await withTimeout(Invites.findAll({
                where,
                include: [
                    { model: Groups, as: 'userGroup', attributes: ['id','name','avatar','description'], required: false },
                    { model: Users,  as: 'inviter',   attributes: ['id','username','avatar'],           foreignKey: 'inviterId', required: false },
                ],
                order: [['createdAt', 'DESC']],
                limit: 100,
            }));
            return { invitations: rows, total: rows.length };
        } catch (e) {
            console.error('[GroupMembersService] getUserInvitations error:', e.message);
            return { invitations: [], total: 0 };
        }
    }

    // ── SENT INVITATIONS (sent by this user for a specific group) ─────────────
    async getSentInvitations(groupId, requestingUserId) {
        if (!Invites) return { invitations: [], total: 0 };
        try {
            await requireMembership(groupId, requestingUserId, 'member'); // FIX: sender only needs to be a member
            const rows = await withTimeout(Invites.findAll({
                where: { inviterId: requestingUserId },  // FIX: return all sent invites, not scoped to one group
                include: [{ model: Users, as: 'invitee', attributes: ['id','username','avatar'], foreignKey: 'targetUserId', required: false }],
                order: [['createdAt', 'DESC']],
            }));
            return { invitations: rows, total: rows.length };
        } catch (e) {
            if (e.message.includes('permission')) throw e;
            console.error('[GroupMembersService] getSentInvitations error:', e.message);
            return { invitations: [], total: 0 };
        }
    }
}

const groupMembersServiceInstance = new GroupMembersService();

module.exports = groupMembersServiceInstance;
module.exports.memberServiceEvents = memberServiceEvents;