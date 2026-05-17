// routes/group.js — v3.0.0  FIXED
// ============================================================
// FIXES IN THIS VERSION:
//   ✔ BUG FIX (CRITICAL): POST / now delegates to the FIXED external
//     groupController (groupController.js) which:
//       - Destructures { group } from groupService.createGroup()
//       - Correctly maps privacy → isPublic
//       - Propagates real DB error messages instead of swallowing them
//   ✔ BUG FIX: The old inline GroupController.createGroup() called
//     Group.create() directly, bypassing groupService entirely and never
//     creating the required Chats record — causing FK/NOT NULL 500s.
//     The fixed external controller always goes through groupService
//     which creates Chat first, then Group, then GroupMember.
//   ✔ BUG FIX: All router.bind() calls now point to the single external
//     groupController so no method is ever undefined at runtime.
//   ✔ PRESERVED: All inline routes (messages, events, moods, invitations,
//     invite-link, socket setup) are kept exactly as-is.
//   ✔ PRESERVED: Public routes (purposes, public groups, search) before
//     authenticateToken middleware.
//   ✔ PRESERVED: setupGroupSocket() exported for server.js usage.
// ============================================================

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// ── Model imports (used by inline route handlers below) ──────────────────────
let db, User, Group, GroupMember, Invite, Chat, Message;
try {
    db = require('../models');
    const m  = db.models || {};
    User        = m.Users        || m.User        || db.Users        || db.User;
    Group       = m.Groups       || m.Group       || db.Groups       || db.Group;
    GroupMember = m.GroupMembers || m.GroupMember || db.GroupMembers || db.GroupMember;
    Invite      = m.Invites      || m.Invite      || db.Invites      || db.Invite || null;
    Chat        = m.Chats        || m.Chat        || db.Chats        || db.Chat;
    Message     = m.Messages     || m.Message     || db.Messages     || db.Message || null;
    console.log('[Groups Route] Models loaded — User:', !!User, 'Group:', !!Group, 'GroupMember:', !!GroupMember);
} catch (error) {
    console.error('[Groups Route] Error loading models:', error.message);
    db = null;
}

const { Op } = require('sequelize');

// ── FIX: import the fixed external controller ────────────────────────────────
// This replaces the old inline GroupController class which had the broken
// createGroup() that called Group.create() directly without creating a Chat.
const groupController = require('../controllers/groupController');
const callController = require('../controllers/callController');

// ── Helpers ───────────────────────────────────────────────────────────────────
const getUserId = (req) => {
    if (!req.user) return null;
    return req.user.id || req.user.userId || null;
};

const formatGroup = (group) => {
    if (!group) return null;
    const d = group.toJSON ? group.toJSON() : group;
    return {
        id         : d.id,
        name       : d.name        || '',
        description: d.description || '',
        avatar     : d.avatar      || null,
        isPublic   : d.isPublic    !== undefined ? d.isPublic : true,
        purpose    : d.purpose     || 'social',
        maxMembers : d.maxMembers  || 100,
        tags       : d.tags        || [],
        rules      : d.rules       || '',
        location   : d.location    || '',
        createdBy  : d.createdBy,
        chatId     : d.chatId      || null,
        createdAt  : d.createdAt,
        updatedAt  : d.updatedAt,
        isVerified : d.isVerified  || false,
        settings   : d.settings    || {},
        stats      : d.stats       || { totalMembers: 0, totalMessages: 0 },
    };
};

const withTimeout = (promise, ms = 10000) => {
    let tid;
    const t = new Promise((_, reject) => { tid = setTimeout(() => reject(new Error(`Query timeout after ${ms}ms`)), ms); });
    return Promise.race([promise, t]).finally(() => { if (tid) clearTimeout(tid); });
};

// ── Helper: format a GroupMessage record for the client ──────────────────────
function _fmtMessage(msg, currentUserId, groupIdOverride = null) {
    const d = msg.toJSON ? msg.toJSON() : msg;
    const metadata = d.metadata || {};
    const attachment = metadata.attachment || null;
    const parent = d.messageParent || d.parentMessage || metadata.replyTo || null;
    return {
        id          : d.id,
        groupId     : groupIdOverride || d.groupId || metadata.groupId || null,
        chatId      : d.chatId || metadata.chatId || null,
        senderId    : d.senderId    || d.userId,
        senderName  : metadata.anonymous
            ? 'Anonymous'
            : (d.messageSender
                ? ([d.messageSender.firstName, d.messageSender.lastName].filter(Boolean).join(' ') || d.messageSender.username || 'User')
                : (metadata.senderName || d.senderName || 'User')),
        senderAvatar: metadata.anonymous ? null : (d.messageSender?.avatar || metadata.senderAvatar || d.senderAvatar || null),
        content     : d.content     || d.text || '',
        type        : d.type        || 'text',
        topic       : metadata.topic || d.topic || null,
        anonymous   : Boolean(metadata.anonymous || d.anonymous),
        readBy      : d.readBy      || metadata.readBy || (d.isRead ? [currentUserId] : []),
        replyTo     : parent ? {
            id: parent.id,
            senderId: parent.senderId || parent.userId || null,
            senderName: parent.messageSender
                ? ([parent.messageSender.firstName, parent.messageSender.lastName].filter(Boolean).join(' ') || parent.messageSender.username || 'User')
                : (parent.senderName || metadata.replyTo?.senderName || 'User'),
            content: parent.content || metadata.replyTo?.content || '',
            type: parent.type || metadata.replyTo?.type || 'text'
        } : null,
        metadata    : metadata,
        attachment  : attachment,
        mediaUrl    : attachment?.url || metadata.mediaUrl || null,
        thumbnailUrl: attachment?.thumbnailUrl || metadata.thumbnailUrl || null,
        fileName    : attachment?.name || metadata.fileName || null,
        mimeType    : attachment?.mimeType || metadata.mimeType || null,
        deliveredAt : d.deliveredAt || metadata.deliveredAt || null,
        isRead      : Boolean(d.isRead || metadata.isRead),
        createdAt   : d.createdAt,
        timestamp   : d.createdAt   || d.timestamp,
    };
}

// ============================================================================
// PUBLIC ROUTES — no auth required
// ============================================================================

router.get('/purposes', groupController.getGroupPurposes.bind(groupController));
router.get('/public',   groupController.getPublicGroups.bind(groupController));
router.get('/search',   groupController.searchGroups.bind(groupController));

// /moods — static list, must be before /:groupId
router.get('/moods', (req, res) => {
    const moods = [
        { id: 'happy',     name: 'Happy',     label: 'Happy',     emoji: '😊', icon: '😊', color: '#FFD700', value: 'happy' },
        { id: 'excited',   name: 'Excited',   label: 'Excited',   emoji: '🤩', icon: '🤩', color: '#FF6B6B', value: 'excited' },
        { id: 'calm',      name: 'Calm',      label: 'Calm',      emoji: '😌', icon: '😌', color: '#4ECDC4', value: 'calm' },
        { id: 'focused',   name: 'Focused',   label: 'Focused',   emoji: '🎯', icon: '🎯', color: '#45B7D1', value: 'focused' },
        { id: 'sad',       name: 'Sad',       label: 'Sad',       emoji: '😢', icon: '😢', color: '#74B9FF', value: 'sad' },
        { id: 'angry',     name: 'Angry',     label: 'Angry',     emoji: '😠', icon: '😠', color: '#FF7675', value: 'angry' },
        { id: 'anxious',   name: 'Anxious',   label: 'Anxious',   emoji: '😰', icon: '😰', color: '#A29BFE', value: 'anxious' },
        { id: 'grateful',  name: 'Grateful',  label: 'Grateful',  emoji: '🙏', icon: '🙏', color: '#FD79A8', value: 'grateful' },
        { id: 'bored',     name: 'Bored',     label: 'Bored',     emoji: '😑', icon: '😑', color: '#B2BEC3', value: 'bored' },
        { id: 'tired',     name: 'Tired',     label: 'Tired',     emoji: '😴', icon: '😴', color: '#636E72', value: 'tired' },
        { id: 'energetic', name: 'Energetic', label: 'Energetic', emoji: '⚡', icon: '⚡', color: '#FDCB6E', value: 'energetic' },
        { id: 'relaxed',   name: 'Relaxed',   label: 'Relaxed',   emoji: '🧘', icon: '🧘', color: '#00CEC9', value: 'relaxed' },
        { id: 'nostalgic', name: 'Nostalgic', label: 'Nostalgic', emoji: '📸', icon: '📸', color: '#A29BFE', value: 'nostalgic' },
        { id: 'romantic',  name: 'Romantic',  label: 'Romantic',  emoji: '💕', icon: '💕', color: '#FF6B6B', value: 'romantic' },
        { id: 'lonely',    name: 'Lonely',    label: 'Lonely',    emoji: '🫂', icon: '🫂', color: '#74B9FF', value: 'lonely' },
        { id: 'confused',  name: 'Confused',  label: 'Confused',  emoji: '🤔', icon: '🤔', color: '#B2BEC3', value: 'confused' },
        { id: 'proud',     name: 'Proud',     label: 'Proud',     emoji: '🦁', icon: '🦁', color: '#FDCB6E', value: 'proud' },
        { id: 'hopeful',   name: 'Hopeful',   label: 'Hopeful',   emoji: '🌈', icon: '🌈', color: '#00CEC9', value: 'hopeful' },
        { id: 'sick',      name: 'Sick',      label: 'Sick',      emoji: '🤒', icon: '🤒', color: '#636E72', value: 'sick' },
        { id: 'neutral',   name: 'Neutral',   label: 'Neutral',   emoji: '😐', icon: '😐', color: '#B2BEC3', value: 'neutral' },
    ];
    res.status(200).json({ success: true, data: moods, status: 'success' });
});

// ============================================================================
// PROTECTED ROUTES — auth required from here down
// ============================================================================
router.use(authenticateToken);

// ── GET /invitations — user's received invitations (must be before /:groupId)
router.get('/invitations', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        const status = req.query.status || 'pending';
        let invitations = [];
        try {
            if (Invite) {
                const raw = await Invite.findAll({
                    where  : { targetUserId: userId, status },
                    include: [
                        { model: Group, as: 'inviteGroup', attributes: ['id','name','description','avatar','purpose','stats'], required: false },
                        { model: User,  as: 'inviter',     attributes: ['id','username','avatar'],                             required: false },
                    ],
                    order: [['createdAt', 'DESC']],
                    limit: 50,
                });
                invitations = raw.map(inv => {
                    const d = inv.toJSON ? inv.toJSON() : inv;
                    return { id: d.id, groupId: d.groupId, group: d.inviteGroup || null, groupName: d.inviteGroup?.name, inviter: d.inviter || null, status: d.status, role: d.role || 'member', message: d.message || '', createdAt: d.createdAt };
                });
            }
        } catch (_) { invitations = []; }

        return res.status(200).json({ success: true, message: 'Invitations retrieved', data: { invitations, total: invitations.length } });
    } catch (error) {
        console.error('[Groups] GET /invitations error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get invitations' });
    }
});

// ── GET /invitations/sent (must be before /:groupId)
router.get('/invitations/sent', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        let invitations = [];
        try {
            if (Invite) {
                const raw = await Invite.findAll({
                    where  : { inviterId: userId },
                    include: [
                        { model: Group, as: 'inviteGroup', attributes: ['id','name','avatar'],     required: false },
                        { model: User,  as: 'targetUser',  attributes: ['id','username','avatar'], required: false },
                    ],
                    order: [['createdAt', 'DESC']],
                    limit: 50,
                });
                invitations = raw.map(inv => {
                    const d = inv.toJSON ? inv.toJSON() : inv;
                    return { id: d.id, groupId: d.groupId, group: d.inviteGroup || null, targetUserId: d.targetUserId, targetUser: d.targetUser || null, status: d.status, role: d.role || 'member', createdAt: d.createdAt };
                });
            }
        } catch (_) { invitations = []; }

        return res.status(200).json({ success: true, data: { invitations, total: invitations.length } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get sent invitations' });
    }
});

// ── GET /events — global events across user's groups (must be before /:groupId)
router.get('/events', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
        return res.status(200).json({ success: true, data: { events: [], total: 0 } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get events' });
    }
});

// ── GET + POST /invites/... (must be before /:groupId) ────────────────────────
router.get('/invites/user',                     groupController.getUserInvites.bind(groupController));
router.get('/invites',                          groupController.getGroupInvites.bind(groupController));
router.post('/invites/:inviteId/accept',        groupController.acceptGroupInvite.bind(groupController));
router.post('/invites/:inviteId/reject',        groupController.rejectGroupInvite.bind(groupController));

// ============================================================================
// GROUP CRUD — delegated to fixed groupController
// ============================================================================

// FIX: POST / now goes through groupController → groupService → creates Chat + Group + GroupMember
router.post('/', [
    body('name').notEmpty().withMessage('Group name is required').isLength({ max: 100 }).withMessage('Name too long'),
    body('description').optional().isLength({ max: 500 }).withMessage('Description too long'),
    body('purpose').optional().isString(),
    body('maxMembers').optional().isInt({ min: 1, max: 1000 }).withMessage('Max members must be between 1 and 1000'),
], groupController.createGroup.bind(groupController));

router.get('/',     groupController.getUserGroups.bind(groupController));
router.get('/user', groupController.getUserGroups.bind(groupController));

// ── Parametric group routes (after all static paths) ─────────────────────────
router.get('/:groupId',    groupController.getGroupById.bind(groupController));
router.put('/:groupId',    groupController.updateGroup.bind(groupController));
router.delete('/:groupId', groupController.deleteGroup.bind(groupController));

// ── Group members ─────────────────────────────────────────────────────────────
router.get('/:groupId/members',                  groupController.getGroupMembers.bind(groupController));
router.post('/:groupId/members/:userId',         groupController.addGroupMember.bind(groupController));
router.delete('/:groupId/members/:userId',       groupController.removeGroupMember.bind(groupController));
router.put('/:groupId/members/:userId/role', [
    body('role').isIn(['member','admin','moderator','owner']).withMessage('Invalid role'),
], groupController.updateMemberRole.bind(groupController));

// ── Group invite management ───────────────────────────────────────────────────
router.post('/:groupId/invite', [
    body('userId').optional().isInt().withMessage('Invalid user ID'),
    body('email').optional().isEmail().withMessage('Invalid email'),
], groupController.inviteToGroup.bind(groupController));

router.post('/:groupId/invite-link',   groupController.generateInviteLink.bind(groupController));
router.delete('/:groupId/invite-link', groupController.revokeInviteLink.bind(groupController));

// ── Group actions ─────────────────────────────────────────────────────────────
router.post('/:groupId/join',  groupController.joinGroup.bind(groupController));
router.post('/:groupId/leave', groupController.leaveGroup.bind(groupController));
router.post('/:groupId/call', async (req, res, next) => {
    try {
        const groupId = parseInt(req.params.groupId, 10);
        const callerId = getUserId(req);
        if (!callerId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (isNaN(groupId)) return res.status(400).json({ success: false, message: 'Invalid group ID' });
        if (GroupMember) {
            const membership = await GroupMember.findOne({ where: { groupId, userId: callerId } });
            if (!membership) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
        }
        
        const group = await Group.findByPk(groupId, { attributes: ['id', 'chatId', 'name'] });
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        
        const members = await GroupMember.findAll({
            where: { groupId },
            attributes: ['userId']
        });
        const participantIds = members
            .map(member => parseInt(member.userId || member.dataValues?.userId, 10))
            .filter(id => id && id !== parseInt(callerId, 10));
        
        req.body = {
            ...req.body,
            participantIds,
            chatId: group.chatId
        };
        return callController.initiateCall(req, res, next);
    } catch (error) {
        return next(error);
    }
});
router.put('/:groupId/settings', groupController.updateGroupSettings.bind(groupController));

// ── Group events (per-group) ──────────────────────────────────────────────────
router.get('/:groupId/events', async (req, res) => {
    try {
        const { groupId } = req.params;
        const { filter = 'upcoming' } = req.query;
        return res.status(200).json({ success: true, data: { events: [], total: 0, groupId, filter } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to get group events' });
    }
});

router.post('/:groupId/events', async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = getUserId(req);
        const { title, description, startDate, endDate, location } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'Event title is required' });
        const newEvent = {
            id: Date.now(), groupId: parseInt(groupId), title: title.trim(),
            description: description || '', startDate: startDate || null,
            endDate: endDate || null, location: location || '',
            createdBy: userId, createdAt: new Date().toISOString(), attendees: [],
        };
        return res.status(201).json({ success: true, message: 'Event created successfully', data: { event: newEvent } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to create event' });
    }
});

// ============================================================================
// GROUP MESSAGES — GET + POST /api/groups/:groupId/messages
// ============================================================================

router.get('/:groupId/messages', async (req, res) => {
    try {
        const userId  = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const limit   = Math.min(parseInt(req.query.limit || 50), 200);
        const before  = req.query.before || null;

        if (!userId)      return res.status(401).json({ success: false, message: 'Authentication required' });
        if (isNaN(groupId)) return res.status(400).json({ success: false, message: 'Invalid group ID' });

        if (GroupMember) {
            const membership = await GroupMember.findOne({ where: { groupId, userId } });
            if (!membership) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
        }

        const group = await Group.findByPk(groupId, { attributes: ['id', 'chatId', 'stats'] });
        if (!group) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }
        if (!Message || !group.chatId) {
            console.warn('[Groups] Messages model or group chatId missing, returning []');
            return res.json({ success: true, data: [], pagination: { limit, hasMore: false } });
        }

        const where = { chatId: group.chatId, isDeleted: false };
        if (before) where.id = { [Op.lt]: parseInt(before) };

        const messages  = await withTimeout(Message.findAll({
            where,
            order  : [['createdAt', 'DESC']],
            limit,
            include: [
                { model: User, as: 'messageSender', attributes: ['id','username','firstName','lastName','avatar'], required: false },
                {
                    model: Message,
                    as: 'messageParent',
                    attributes: ['id', 'content', 'type', 'senderId'],
                    required: false,
                    include: [{ model: User, as: 'messageSender', attributes: ['id','username','firstName','lastName','avatar'], required: false }]
                }
            ],
        }));
        const formatted = messages.reverse().map(m => _fmtMessage(m, userId, groupId));

        return res.json({ success: true, data: formatted, pagination: { limit, hasMore: messages.length === limit } });
    } catch (error) {
        console.error('[Groups] GET messages error:', error.message);
        return res.json({ success: true, data: [], pagination: { limit: 50, hasMore: false } });
    }
});

router.post('/:groupId/messages', async (req, res) => {
    try {
        const userId  = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const { content = '', type = 'text', topic = null, anonymous = false, metadata = {}, replyToId = null } = req.body;

        if (!userId)      return res.status(401).json({ success: false, message: 'Authentication required' });
        if (isNaN(groupId)) return res.status(400).json({ success: false, message: 'Invalid group ID' });
        const trimmedContent = String(content || '').trim();
        const attachment = metadata?.attachment || null;
        if (!trimmedContent && !attachment) return res.status(400).json({ success: false, message: 'Message content is required' });

        if (GroupMember) {
            const membership = await GroupMember.findOne({ where: { groupId, userId } });
            if (!membership) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
        }

        const group = await Group.findByPk(groupId, { attributes: ['id', 'chatId', 'stats'] });
        if (!group) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }
        if (!Message || !group.chatId) {
            return res.status(503).json({ success: false, message: 'Group chat storage is not available' });
        }

        let senderName = 'User', senderAvatar = null;
        if (User) {
            try {
                const u = await User.findByPk(userId, { attributes: ['id','username','firstName','lastName','avatar'] });
                if (u) {
                    const ud   = u.toJSON ? u.toJSON() : u;
                    senderName   = [ud.firstName, ud.lastName].filter(Boolean).join(' ') || ud.username || 'User';
                    senderAvatar = ud.avatar || null;
                }
            } catch (_) {}
        }

        const record = await Message.create({
            chatId: group.chatId,
            senderId: userId,
            content: trimmedContent || '',
            type,
            replyToId: replyToId ? parseInt(replyToId, 10) : null,
            isRead: false,
            reactions: {},
            metadata: {
                ...metadata,
                groupId,
                topic: topic || metadata.topic || null,
                anonymous: !!anonymous,
                senderName: anonymous ? 'Anonymous' : senderName,
                senderAvatar: anonymous ? null : senderAvatar,
                readBy: [userId],
                attachment
            },
            sentAt: new Date(),
            deliveredAt: new Date()
        });

        const savedRecord = await Message.findByPk(record.id, {
            include: [
                { model: User, as: 'messageSender', attributes: ['id','username','firstName','lastName','avatar'], required: false },
                {
                    model: Message,
                    as: 'messageParent',
                    attributes: ['id', 'content', 'type', 'senderId'],
                    required: false,
                    include: [{ model: User, as: 'messageSender', attributes: ['id','username','firstName','lastName','avatar'], required: false }]
                }
            ]
        });
        const savedMessage = _fmtMessage(savedRecord || record, userId, groupId);
        
        try {
            const liveMessageCount = await Message.count({ where: { chatId: group.chatId, isDeleted: false } });
            await group.update({
                stats: {
                    ...(group.stats || {}),
                    totalMessages: liveMessageCount
                }
            });
        } catch (statsErr) {
            console.warn('[Groups] Unable to refresh group message stats:', statsErr.message);
        }

        const io = global.__socketIO;
        if (io) {
            const socketPayload    = { groupId, message: savedMessage, senderId: userId, senderName: anonymous ? 'Anonymous' : senderName, timestamp: new Date() };
            const localSyncPayload = { action: 'message', groupId, message: savedMessage };

            // FIX: Single canonical 'group:message' event — frontend handles via kyn: bridge
            io.to(`group:${groupId}`).emit('group:message', socketPayload);
            io.to(`group:${groupId}`).emit('group:localSync', localSyncPayload);

            // Also emit to every member's user room (fallback for members who haven't joined the group room yet)
            try {
                const GM = db?.models?.GroupMembers || db?.models?.GroupMember || db?.GroupMembers || db?.GroupMember || null;
                if (GM) {
                    const members = await GM.findAll({ where: { groupId }, attributes: ['userId'] });
                    members.forEach(m => {
                        const mid = m.userId || m.dataValues?.userId;
                        if (!mid) return;
                        const userRoom = io.sockets.adapter.rooms?.get(`user:${mid}`);
                        if (userRoom) {
                            userRoom.forEach(socketId => {
                                const sock = io.sockets.sockets?.get(socketId);
                                if (sock) sock.join(`group:${groupId}`);
                            });
                        }
                        // FIX: Single canonical 'group:message' per member
                        io.to(`user:${mid}`).emit('group:message', socketPayload);
                        io.to(`user:${mid}`).emit('group:localSync', localSyncPayload);
                    });
                }
            } catch (emitErr) {
                console.warn('[GROUP FLOW] Per-member emit failed (non-fatal):', emitErr.message);
            }
        } else {
            console.warn('[GROUP FLOW] global.__socketIO not set — real-time not emitted');
        }

        return res.status(201).json({ success: true, message: 'Message sent successfully', data: { message: savedMessage } });
    } catch (error) {
        console.error('[Groups] POST message error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to send message', error: error.message });
    }
});

// ============================================================================
// GROUP MESSAGE DELETE — DELETE /api/groups/:groupId/messages/:messageId
// ============================================================================
router.delete('/:groupId/messages/:messageId', async (req, res) => {
    try {
        const userId    = getUserId(req);
        const groupId   = parseInt(req.params.groupId);
        const messageId = parseInt(req.params.messageId);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (isNaN(groupId) || isNaN(messageId)) return res.status(400).json({ success: false, message: 'Invalid IDs' });

        if (!Message) return res.status(500).json({ success: false, message: 'Message model unavailable' });

        const msg = await Message.findByPk(messageId);
        if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });

        // Only sender or group admin can delete
        if (String(msg.senderId) !== String(userId)) {
            const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
            const isAdmin = membership && (membership.role === 'admin' || membership.role === 'owner');
            if (!isAdmin) return res.status(403).json({ success: false, message: 'Not authorized to delete this message' });
        }

        // Soft-delete
        msg.isDeleted   = true;
        msg.deletedAt   = new Date();
        msg.deletedBy   = userId;
        msg.content     = '';
        await msg.save();

        // Broadcast deletion to all group members
        const io = global.__socketIO;
        if (io) {
            const delPayload = { messageId, groupId, deletedBy: userId, timestamp: new Date().toISOString() };
            io.to(`group:${groupId}`).emit('group:message:deleted', delPayload);
            io.to(`group_${groupId}`).emit('group:message:deleted', delPayload);
            // Also emit to each member's user room
            try {
                const db  = require('../models');
                const GM  = db.models?.GroupMembers || db.models?.GroupMember || db.GroupMembers || db.GroupMember;
                if (GM) {
                    const members = await GM.findAll({ where: { groupId }, attributes: ['userId'] });
                    members.forEach(m => {
                        const mid = m.userId || m.dataValues?.userId;
                        if (mid) {
                            io.to(`user:${mid}`).emit('group:message:deleted', delPayload);
                            io.to(`user_${mid}`).emit('group:message:deleted', delPayload);
                        }
                    });
                }
            } catch(_) {}
        }

        return res.json({ success: true, message: 'Message deleted', data: { messageId, groupId } });
    } catch (error) {
        console.error('[Groups] DELETE message error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to delete message' });
    }
});

// ── Validation error middleware ───────────────────────────────────────────────
router.use((err, req, res, next) => {
    if (err.type === 'validation') {
        return res.status(400).json({ success: false, message: 'Validation error', errors: err.errors || err.message, code: 'VALIDATION_ERROR' });
    }
    next(err);
});

// ============================================================================
// SOCKET SETUP — call once from server.js after io is ready:
//   webSocketService.setupGroupSocket(io); // self-ref removed
// ============================================================================
function setupGroupSocket(io) {
    if (!io) return;
    io.on('connection', (socket) => {
        socket.on('join_group', ({ groupId } = {}) => {
            if (!groupId) return;
            socket.join(`group:${groupId}`);
            console.log(`[GROUP SOCKET] Socket ${socket.id} joined group:${groupId}`);
        });

        socket.on('leave_group', ({ groupId } = {}) => {
            if (!groupId) return;
            socket.leave(`group:${groupId}`);
            console.log(`[GROUP SOCKET] Socket ${socket.id} left group:${groupId}`);
        });

        socket.on('join_group_rooms', ({ groupIds } = {}) => {
            if (!Array.isArray(groupIds)) return;
            groupIds.forEach(gid => { if (gid) socket.join(`group:${gid}`); });
            console.log(`[GROUP SOCKET] Socket ${socket.id} joined ${groupIds.length} group room(s)`);
        });

        socket.on('join', ({ room } = {}) => {
            if (room && typeof room === 'string' && room.startsWith('group:')) {
                socket.join(room);
                console.log(`[GROUP SOCKET] Socket ${socket.id} joined room: ${room}`);
            }
        });

        socket.on('join_user_room', async ({ userId } = {}) => {
            if (!userId) return;
            socket.join(`user:${userId}`);
            try {
                const dbInner = require('../models');
                const GM      = dbInner?.models?.GroupMembers || dbInner?.models?.GroupMember || dbInner?.GroupMembers || dbInner?.GroupMember || null;
                if (GM) {
                    const memberships = await GM.findAll({ where: { userId, leftAt: null }, attributes: ['groupId'] });
                    memberships.forEach(m => {
                        const gid = m.groupId || m.dataValues?.groupId;
                        if (gid) socket.join(`group:${gid}`);
                    });
                    console.log(`[GROUP SOCKET] Auto-joined user ${userId} to ${memberships.length} group room(s)`);
                }
            } catch (_) {}
        });

        socket.on('typing', ({ groupId, userId, userName } = {}) => {
            if (!groupId) return;
            io.to(`group:${groupId}`).emit('typing', { groupId, userId, userName });
            io.to(`group:${groupId}`).emit('group:typing', { groupId, userId, userName, isTyping: true });
        });

        socket.on('stop_typing', ({ groupId, userId, userName } = {}) => {
            if (!groupId) return;
            io.to(`group:${groupId}`).emit('stop_typing', { groupId, userId, userName });
            io.to(`group:${groupId}`).emit('group:typing', { groupId, userId, userName, isTyping: false });
        });
    });
    console.log('[GROUP SOCKET] setupGroupSocket ✅ installed');
}

router.setupGroupSocket = setupGroupSocket;

module.exports = router;
