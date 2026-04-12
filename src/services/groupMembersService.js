// groupMembersService.js
// FIXED: Rewritten from Mongoose to Sequelize to match actual database stack.
// The original used mongoose.startSession(), Group.findById(), group.admins etc.
// which are MongoDB APIs incompatible with the Sequelize/PostgreSQL models.

let db, Groups, GroupMembers, Users;
try {
    db = require('../models');
    const m = db.models || {};
    Groups      = m.Groups      || m.Group      || db.Groups      || db.Group;
    GroupMembers = m.GroupMembers || m.GroupMember || db.GroupMembers || db.GroupMember;
    Users       = m.Users       || m.User       || db.Users       || db.User;
} catch (e) {
    console.error('[GroupMembersService] ❌ Model load failed:', e.message);
}

const { Op } = require('sequelize');

const withTimeout = (promise, ms = 5000) => {
    let tid;
    const t = new Promise((_, reject) => { tid = setTimeout(() => reject(new Error(`Timeout`)), ms); });
    return Promise.race([promise, t]).finally(() => { if (tid) clearTimeout(tid); });
};

class GroupMembersService {

    // ===== Get group members with user details =====
    async getGroupMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers) return { members: [], total: 0 };
        const { limit = 50, offset = 0, role } = options;
        try {
            const where = { groupId };
            if (role) where.role = role;
            const { count, rows } = await withTimeout(GroupMembers.findAndCountAll({
                where,
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false }],
                limit: Math.min(limit, 100),
                offset,
                order: [['role', 'ASC'], ['joinedAt', 'ASC']],
            }));
            const members = rows.map(m => ({
                id: m.id,
                userId: m.userId,
                role: m.role,
                joinedAt: m.joinedAt,
                notificationsMuted: m.notificationsMuted,
                user: m.groupMemberUser ? {
                    id: m.groupMemberUser.id,
                    username: m.groupMemberUser.username,
                    avatar: m.groupMemberUser.avatar || null,
                    displayName: [m.groupMemberUser.firstName, m.groupMemberUser.lastName].filter(Boolean).join(' ') || m.groupMemberUser.username,
                    status: m.groupMemberUser.status || 'offline',
                    lastSeen: m.groupMemberUser.lastSeen || null,
                } : null,
            }));
            console.log(`[GroupMembersService] ✅ getGroupMembers — ${members.length} members for group ${groupId}`);
            return { members, total: count };
        } catch (e) {
            console.error('[GroupMembersService] ❌ getGroupMembers failed:', e.message);
            return { members: [], total: 0 };
        }
    }

    // ===== Add member to group =====
    async addMemberToGroup(groupId, requestingUserId, memberId, role = 'member') {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const existing = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (existing) throw new Error('User is already a member of this group');
            const membership = await GroupMembers.create({ groupId, userId: memberId, role, joinedAt: new Date() });
            console.log(`[GroupMembersService] ✅ Member ${memberId} added to group ${groupId}`);
            return { id: membership.id, groupId, userId: memberId, role, joinedAt: membership.joinedAt };
        } catch (e) {
            if (e.message.includes('already a member')) throw e;
            console.error('[GroupMembersService] ❌ addMemberToGroup failed:', e.message);
            throw new Error('Failed to add member');
        }
    }

    // ===== Remove member from group =====
    async removeMemberFromGroup(groupId, requestingUserId, memberId, reason) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            // Only owners/admins can remove others; anyone can remove themselves
            if (String(requestingUserId) !== String(memberId)) {
                const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId } });
                if (!requester || !['owner','admin','moderator'].includes(requester.role)) {
                    throw new Error('You do not have permission to remove members');
                }
            }
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!membership) throw new Error('Member not found in this group');
            if (membership.role === 'owner') throw new Error('Cannot remove group owner');
            await membership.destroy();
            console.log(`[GroupMembersService] ✅ Member ${memberId} removed from group ${groupId}`);
            return { removed: true, groupId, memberId };
        } catch (e) {
            if (['not found','permission','Cannot remove owner'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] ❌ removeMemberFromGroup failed:', e.message);
            throw new Error('Failed to remove member');
        }
    }

    // ===== Update member role =====
    async updateMemberRole(groupId, requestingUserId, memberId, newRole) {
        if (!GroupMembers) throw new Error('Service unavailable');
        const validRoles = ['member','moderator','admin','owner'];
        if (!validRoles.includes(newRole)) throw new Error('Invalid role');
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('You do not have permission to update member roles');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!membership) throw new Error('Member not found in this group');
            membership.role = newRole;
            await membership.save();
            console.log(`[GroupMembersService] ✅ Member ${memberId} role → ${newRole} in group ${groupId}`);
            return { groupId, userId: memberId, role: newRole };
        } catch (e) {
            if (['permission','not found','Invalid role'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] ❌ updateMemberRole failed:', e.message);
            throw new Error('Failed to update role');
        }
    }

    // ===== Get member details =====
    async getMemberDetails(groupId, memberId, requestingUserId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const membership = await GroupMembers.findOne({
                where: { groupId, userId: memberId },
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false }],
            });
            if (!membership) throw new Error('Member not found in this group');
            return {
                id: membership.id,
                userId: membership.userId,
                role: membership.role,
                joinedAt: membership.joinedAt,
                notificationsMuted: membership.notificationsMuted,
                user: membership.groupMemberUser ? {
                    id: membership.groupMemberUser.id,
                    username: membership.groupMemberUser.username,
                    avatar: membership.groupMemberUser.avatar || null,
                    status: membership.groupMemberUser.status || 'offline',
                    lastSeen: membership.groupMemberUser.lastSeen || null,
                } : null,
            };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupMembersService] ❌ getMemberDetails failed:', e.message);
            throw new Error('Failed to get member details');
        }
    }

    // ===== Get pending invitations =====
    async getPendingInvitations(groupId, requestingUserId, options = {}) {
        // Delegate to Invite model if available
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invite) return { invitations: [], total: 0 };
        try {
            const { count, rows } = await withTimeout(Invite.findAndCountAll({
                where: { groupId, status: 'pending' },
                include: [{ model: Users, as: 'inviter', attributes: ['id','username','avatar'], required: false }],
                limit: options.limit || 50,
                offset: options.offset || 0,
                order: [['createdAt', 'DESC']],
            }));
            return { invitations: rows, total: count };
        } catch (e) {
            console.error('[GroupMembersService] ❌ getPendingInvitations failed:', e.message);
            return { invitations: [], total: 0 };
        }
    }

    // ===== Invite to group =====
    async inviteToGroup(groupId, inviterId, inviteeId, role = 'member', message = '') {
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invite) throw new Error('Invite service unavailable');
        try {
            const already = await GroupMembers?.findOne({ where: { groupId, userId: inviteeId } });
            if (already) throw new Error('User is already a member of this group');
            const invite = await Invite.create({ groupId, inviterId, targetUserId: inviteeId, message, status: 'pending', expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
            console.log(`[GroupMembersService] ✅ Invite sent to ${inviteeId} for group ${groupId}`);
            return invite;
        } catch (e) {
            if (e.message.includes('already a member')) throw e;
            console.error('[GroupMembersService] ❌ inviteToGroup failed:', e.message);
            throw new Error('Failed to send invite');
        }
    }

    // ===== Accept invitation =====
    async acceptInvitation(invitationId, userId) {
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invite || !GroupMembers) throw new Error('Service unavailable');
        try {
            const invite = await Invite.findOne({ where: { id: invitationId, targetUserId: userId, status: 'pending' } });
            if (!invite) throw new Error('Invitation not found or already processed');
            await GroupMembers.create({ groupId: invite.groupId, userId, role: 'member', joinedAt: new Date() });
            invite.status = 'accepted';
            await invite.save();
            console.log(`[GroupMembersService] ✅ Invitation ${invitationId} accepted by user ${userId}`);
            return { groupId: invite.groupId, invitedBy: invite.inviterId, accepted: true };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupMembersService] ❌ acceptInvitation failed:', e.message);
            throw new Error('Failed to accept invitation');
        }
    }

    // ===== Reject invitation =====
    async rejectInvitation(invitationId, userId, reason) {
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invite) throw new Error('Service unavailable');
        try {
            const invite = await Invite.findOne({ where: { id: invitationId, targetUserId: userId, status: 'pending' } });
            if (!invite) throw new Error('Invitation not found or already processed');
            invite.status = 'rejected';
            await invite.save();
            return { groupId: invite.groupId, invitedBy: invite.inviterId, rejected: true };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupMembersService] ❌ rejectInvitation failed:', e.message);
            throw new Error('Failed to reject invitation');
        }
    }

    // ===== Cancel invitation =====
    async cancelInvitation(invitationId, userId) {
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites; } catch (_) {}
        if (!Invite) throw new Error('Service unavailable');
        try {
            const invite = await Invite.findOne({ where: { id: invitationId, inviterId: userId, status: 'pending' } });
            if (!invite) throw new Error('Invitation not found or already processed');
            await invite.destroy();
            return { groupId: invite.groupId, inviteeId: invite.targetUserId, cancelled: true };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupMembersService] ❌ cancelInvitation failed:', e.message);
            throw new Error('Failed to cancel invitation');
        }
    }

    // ===== Leave group =====
    async leaveGroup(groupId, userId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const membership = await GroupMembers.findOne({ where: { groupId, userId } });
            if (!membership) throw new Error('You are not a member of this group');
            if (membership.role === 'owner') throw new Error('Group owner cannot leave. Transfer ownership first.');
            await membership.destroy();
            console.log(`[GroupMembersService] ✅ User ${userId} left group ${groupId}`);
            return { left: true, groupId, userId };
        } catch (e) {
            if (['not a member','cannot leave','owner'].some(s => e.message.toLowerCase().includes(s))) throw e;
            console.error('[GroupMembersService] ❌ leaveGroup failed:', e.message);
            throw new Error('Failed to leave group');
        }
    }

    // ===== Transfer ownership =====
    async transferOwnership(groupId, currentOwnerId, newOwnerId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const ownerMembership = await GroupMembers.findOne({ where: { groupId, userId: currentOwnerId } });
            if (!ownerMembership || ownerMembership.role !== 'owner') throw new Error('Only the group owner can transfer ownership');
            const newOwnerMembership = await GroupMembers.findOne({ where: { groupId, userId: newOwnerId } });
            if (!newOwnerMembership) throw new Error('New owner must be a group member');
            // Demote current owner → admin, promote new owner → owner
            ownerMembership.role = 'admin';
            await ownerMembership.save();
            newOwnerMembership.role = 'owner';
            await newOwnerMembership.save();
            console.log(`[GroupMembersService] ✅ Ownership of group ${groupId} transferred from ${currentOwnerId} to ${newOwnerId}`);
            return { transferred: true, groupId, previousOwnerId: currentOwnerId, newOwnerId };
        } catch (e) {
            if (['permission','must be','owner'].some(s => e.message.toLowerCase().includes(s))) throw e;
            console.error('[GroupMembersService] ❌ transferOwnership failed:', e.message);
            throw new Error('Failed to transfer ownership');
        }
    }

    // ===== Get member statistics =====
    async getMemberStatistics(groupId, requestingUserId) {
        if (!GroupMembers) return { totalMembers: 0, totalAdmins: 0, joinStats: {} };
        try {
            // Verify requester is admin/owner
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('Only group admins can view statistics');

            const [totalMembers, totalAdmins, recentJoins] = await Promise.all([
                GroupMembers.count({ where: { groupId } }),
                GroupMembers.count({ where: { groupId, role: { [Op.in]: ['owner','admin'] } } }),
                GroupMembers.count({ where: { groupId, joinedAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
            ]);

            return { totalMembers, totalAdmins, joinStats: { last7Days: recentJoins, total: totalMembers }, adminToMemberRatio: totalMembers > 0 ? (totalAdmins / totalMembers).toFixed(2) : 0 };
        } catch (e) {
            if (e.message.includes('admin')) throw e;
            console.error('[GroupMembersService] ❌ getMemberStatistics failed:', e.message);
            throw new Error('Failed to get member statistics');
        }
    }

    // ===== Search members =====
    async searchMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers || !Users) return { members: [], total: 0 };
        const { query = '', limit = 20, offset = 0 } = options;
        try {
            const userIds = (await Users.findAll({
                where: { [Op.or]: [{ username: { [Op.iLike]: `%${query}%` } }, { firstName: { [Op.iLike]: `%${query}%` } }, { lastName: { [Op.iLike]: `%${query}%` } }] },
                attributes: ['id'],
            })).map(u => u.id);

            const { count, rows } = await withTimeout(GroupMembers.findAndCountAll({
                where: { groupId, userId: { [Op.in]: userIds } },
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar','firstName','lastName','status'], required: false }],
                limit: Math.min(limit, 50),
                offset,
            }));
            return { members: rows.map(m => ({ userId: m.userId, role: m.role, user: m.groupMemberUser })), total: count };
        } catch (e) {
            console.error('[GroupMembersService] ❌ searchMembers failed:', e.message);
            return { members: [], total: 0 };
        }
    }

    // ===== Mute member =====
    async muteMember(groupId, requestingUserId, memberId, duration, reason) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId } });
            if (!requester || !['owner','admin','moderator'].includes(requester.role)) throw new Error('You do not have permission to mute members');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!membership) throw new Error('Member not found in this group');
            if (membership.notificationsMuted) throw new Error('Member is already muted');
            membership.notificationsMuted = true;
            await membership.save();
            const expiresAt = duration ? new Date(Date.now() + duration * 60 * 1000) : null;
            console.log(`[GroupMembersService] ✅ Member ${memberId} muted in group ${groupId}`);
            return { muted: true, groupId, memberId, expiresAt };
        } catch (e) {
            if (['permission','not found','already muted'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] ❌ muteMember failed:', e.message);
            throw new Error('Failed to mute member');
        }
    }

    // ===== Unmute member =====
    async unmuteMember(groupId, requestingUserId, memberId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!membership) throw new Error('Member not found in this group');
            membership.notificationsMuted = false;
            await membership.save();
            return { unmuted: true, groupId, memberId };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupMembersService] ❌ unmuteMember failed:', e.message);
            throw new Error('Failed to unmute member');
        }
    }

    // ===== Ban member (marks leftAt, removes from group) =====
    async banMember(groupId, requestingUserId, memberId, duration, reason) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('You do not have permission to ban members');
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!membership) throw new Error('Member not found in this group');
            const expiresAt = duration ? new Date(Date.now() + duration * 60 * 1000) : null;
            membership.leftAt = new Date();
            await membership.save();
            console.log(`[GroupMembersService] ✅ Member ${memberId} banned from group ${groupId}`);
            return { banned: true, groupId, memberId, expiresAt };
        } catch (e) {
            if (['permission','not found'].some(s => e.message.includes(s))) throw e;
            console.error('[GroupMembersService] ❌ banMember failed:', e.message);
            throw new Error('Failed to ban member');
        }
    }

    // ===== Unban member =====
    async unbanMember(groupId, requestingUserId, memberId) {
        if (!GroupMembers) throw new Error('Service unavailable');
        try {
            const membership = await GroupMembers.findOne({ where: { groupId, userId: memberId } });
            if (!membership) throw new Error('Member ban record not found');
            membership.leftAt = null;
            await membership.save();
            return { unbanned: true, groupId, memberId };
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.error('[GroupMembersService] ❌ unbanMember failed:', e.message);
            throw new Error('Failed to unban member');
        }
    }

    // ===== Get banned members =====
    async getBannedMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers) return { members: [], total: 0 };
        try {
            const { count, rows } = await withTimeout(GroupMembers.findAndCountAll({
                where: { groupId, leftAt: { [Op.ne]: null } },
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar'], required: false }],
                limit: options.limit || 50,
                offset: options.offset || 0,
            }));
            return { members: rows, total: count };
        } catch (e) {
            console.error('[GroupMembersService] ❌ getBannedMembers failed:', e.message);
            return { members: [], total: 0 };
        }
    }

    // ===== Get online members =====
    async getOnlineMembers(groupId, requestingUserId, options = {}) {
        if (!GroupMembers || !Users) return { members: [], total: 0 };
        try {
            const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
            const members = await withTimeout(GroupMembers.findAll({
                where: { groupId, leftAt: null },
                include: [{
                    model: Users,
                    as: 'groupMemberUser',
                    attributes: ['id','username','avatar','status','lastSeen'],
                    where: { [Op.or]: [{ status: 'online' }, { lastSeen: { [Op.gte]: fifteenMinAgo } }] },
                    required: true,
                }],
                limit: options.limit || 50,
            }));
            return { members: members.map(m => ({ userId: m.userId, role: m.role, user: m.groupMemberUser })), total: members.length };
        } catch (e) {
            console.error('[GroupMembersService] ❌ getOnlineMembers failed:', e.message);
            return { members: [], total: 0 };
        }
    }

    // ===== Get member activity (stub — requires activity log table) =====
    async getMemberActivity(groupId, memberId, requestingUserId, options = {}) {
        return { activities: [], total: 0, message: 'Activity log not yet implemented' };
    }

    // ===== Export members list =====
    async exportMembersList(groupId, requestingUserId, options = {}) {
        if (!GroupMembers) return [];
        try {
            const requester = await GroupMembers.findOne({ where: { groupId, userId: requestingUserId } });
            if (!requester || !['owner','admin'].includes(requester.role)) throw new Error('Only group admins can export members list');
            const rows = await withTimeout(GroupMembers.findAll({
                where: { groupId },
                include: [{ model: Users, as: 'groupMemberUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false }],
                order: [['role', 'ASC'], ['joinedAt', 'ASC']],
            }));
            const data = rows.map(m => ({
                userId: m.userId,
                username: m.groupMemberUser?.username || 'Unknown',
                displayName: [m.groupMemberUser?.firstName, m.groupMemberUser?.lastName].filter(Boolean).join(' ') || m.groupMemberUser?.username || 'Unknown',
                role: m.role,
                joinedAt: m.joinedAt,
                status: m.groupMemberUser?.status || 'offline',
                lastSeen: m.groupMemberUser?.lastSeen || null,
            }));
            if (options.format === 'csv') {
                const header = 'userId,username,displayName,role,joinedAt,status,lastSeen';
                const lines = data.map(d => `${d.userId},${d.username},"${d.displayName}",${d.role},${d.joinedAt},${d.status},${d.lastSeen || ''}`);
                return [header, ...lines].join('\n');
            }
            return data;
        } catch (e) {
            if (e.message.includes('admin')) throw e;
            console.error('[GroupMembersService] ❌ exportMembersList failed:', e.message);
            throw new Error('Failed to export members list');
        }
    }

    /**
     * Get all invitations received by a user across all groups
     * Used by: GET /api/group-members/invitations (invitation panel)
     */
    async getUserInvitations(userId, status = 'pending') {
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites || db2.models?.Invite || db2.Invite; } catch (_) {}
        if (!Invite) return { invitations: [], total: 0 };
        try {
            const where = { targetUserId: userId };
            if (status && status !== 'all') where.status = status;
            const rows = await Invite.findAll({
                where,
                include: [
                    { model: Groups, as: 'group', attributes: ['id','name','description','avatar','purpose'], required: false },
                    { model: Users,  as: 'inviter', attributes: ['id','username','avatar'], required: false },
                ],
                order: [['createdAt', 'DESC']],
                limit: 50,
            });
            const invitations = rows.map(inv => {
                const d = inv.toJSON ? inv.toJSON() : inv;
                return {
                    id: d.id,
                    groupId: d.groupId,
                    group: d.group || null,
                    groupName: d.group?.name,
                    inviter: d.inviter || null,
                    inviterName: d.inviter?.username,
                    status: d.status,
                    role: d.role || 'member',
                    message: d.message || '',
                    createdAt: d.createdAt,
                };
            });
            return { invitations, total: invitations.length };
        } catch (e) {
            return { invitations: [], total: 0 };
        }
    }

    /**
     * Get sent invitations for a group
     */
    async getSentInvitations(groupId, senderId) {
        let Invite;
        try { const db2 = require('../models'); Invite = db2.models?.Invites || db2.Invites || db2.models?.Invite || db2.Invite; } catch (_) {}
        if (!Invite) return { invitations: [], total: 0 };
        try {
            const rows = await Invite.findAll({
                where: { groupId, inviterId: senderId },
                include: [
                    { model: Users, as: 'targetUser', attributes: ['id','username','avatar'], required: false },
                ],
                order: [['createdAt', 'DESC']],
                limit: 50,
            });
            const invitations = rows.map(inv => {
                const d = inv.toJSON ? inv.toJSON() : inv;
                return {
                    id: d.id,
                    groupId: d.groupId,
                    targetUserId: d.targetUserId,
                    targetUser: d.targetUser || null,
                    status: d.status,
                    role: d.role || 'member',
                    createdAt: d.createdAt,
                };
            });
            return { invitations, total: invitations.length };
        } catch (e) {
            return { invitations: [], total: 0 };
        }
    }

}

module.exports = new GroupMembersService();