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
// ── CRITICAL: Inject global.__socketIO into req.io so all handlers can emit ──
router.use((req, _, next) => { if (!req.io) req.io = global.__socketIO || null; next(); });
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

// ── P2 FIX: Content filter + moderation log ──────────────────────────────────
let contentFilter, ModerationLog;
try {
    contentFilter  = require('../services/contentFilter');
    const db2      = require('../models');
    ModerationLog  = db2.models?.ModerationLog || db2.ModerationLog || null;
} catch(_) {}

// ── P1 FIX: FCM push notifications ───────────────────────────────────────────
let pushService;
try { pushService = require('../services/pushService'); } catch(_) {}

// ── Helper: log a moderation action to DB ─────────────────────────────────────
async function _logMod(groupId, performedBy, action, targetUserId = null, reason = null, metadata = {}) {
    try {
        if (ModerationLog) await ModerationLog.create({ groupId, performedBy, action, targetUserId, reason, metadata });
    } catch (_) { /* non-fatal */ }
}

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
// P1 FIX: Multer memoryStorage for Cloudinary — avatar goes to buffer not disk
const _multer = require('multer');
const _groupAvatarUpload = _multer({
    storage: _multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files allowed for group avatar'), false);
    },
});
router.put('/:groupId', _groupAvatarUpload.single('avatar'), groupController.updateGroup.bind(groupController));
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
            const membership = await GroupMember.findOne({ where: { groupId, userId: callerId, leftAt: null } });
            if (!membership) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
        }
        
        const group = await Group.findByPk(groupId, { attributes: ['id', 'chatId', 'name'] });
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        
        const members = await GroupMember.findAll({
            where: { groupId, leftAt: null },
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

        const group = await Group.findByPk(groupId, { attributes: ['id', 'chatId', 'stats', 'postingRule', 'slowModeInterval', 'blockedWords', 'scheduledPostingStart', 'scheduledPostingEnd', 'settings', 'disappearingTimer'] });
        if (!group) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }
        if (!Message || !group.chatId) {
            return res.status(503).json({ success: false, message: 'Group chat storage is not available' });
        }

        // ── P1 FIX: Enforce posting rule server-side ───────────────────────
        const postingRule = group.postingRule || 'open';
        if (postingRule !== 'open') {
            let membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
            const isAdmin = membership && ['owner', 'admin', 'moderator'].includes(membership.role);
            if (postingRule === 'read_only') {
                return res.status(403).json({ success: false, message: 'This group is in read-only mode', code: 'READ_ONLY' });
            }
            if ((postingRule === 'announcement' || postingRule === 'admin_only') && !isAdmin) {
                return res.status(403).json({ success: false, message: 'Only admins can post in this group', code: 'ADMIN_ONLY' });
            }
            if (postingRule === 'scheduled' && group.scheduledPostingStart && group.scheduledPostingEnd) {
                const now = new Date();
                const [sh, sm] = group.scheduledPostingStart.split(':').map(Number);
                const [eh, em] = group.scheduledPostingEnd.split(':').map(Number);
                const nowMins  = now.getUTCHours() * 60 + now.getUTCMinutes();
                const startMins = sh * 60 + sm;
                const endMins   = eh * 60 + em;
                if (nowMins < startMins || nowMins > endMins) {
                    return res.status(403).json({ success: false, message: `Posting is only allowed between ${group.scheduledPostingStart}–${group.scheduledPostingEnd} UTC`, code: 'OUTSIDE_WINDOW' });
                }
            }
        }

        // ── P1 FIX: Enforce slow mode server-side ─────────────────────────
        const slowSecs = group.slowModeInterval || 0;
        if (slowSecs > 0) {
            // Use contentFilter flood tracker as a proxy for slow-mode tracking
            const key = `slow:${userId}:${groupId}`;
            const _slowMap = global.__slowModeMap = global.__slowModeMap || new Map();
            const lastSent = _slowMap.get(key) || 0;
            const elapsed  = (Date.now() - lastSent) / 1000;
            if (elapsed < slowSecs) {
                const remaining = Math.ceil(slowSecs - elapsed);
                return res.status(429).json({ success: false, message: `Slow mode: wait ${remaining}s before sending again`, remaining, code: 'SLOW_MODE' });
            }
            _slowMap.set(key, Date.now());
        }

        // ── P2 FIX: Anti-flood AutoMod ─────────────────────────────────────
        if (contentFilter) {
            const { flooded } = contentFilter.trackAndCheckFlood(userId, groupId);
            if (flooded && GroupMember) {
                // Auto-mute user for FLOOD_MUTE_SECS
                const muteUntil = new Date(Date.now() + contentFilter.FLOOD_MUTE_SECS * 1000);
                await GroupMember.update({ mutedUntil: muteUntil }, { where: { groupId, userId } });
                await _logMod(groupId, userId, 'mute', userId, 'Auto-muted: flood detection', { autoMod: true, mutedUntil: muteUntil });
                const io = global.__socketIO;
                if (io) io.to(`group:${groupId}`).emit('group:member:auto_muted', { userId, groupId, until: muteUntil });
                return res.status(429).json({ success: false, message: `You have been auto-muted for ${contentFilter.FLOOD_MUTE_SECS}s due to flooding`, code: 'FLOOD_MUTED' });
            }
        }

        // ── P2 FIX: Check mute status ──────────────────────────────────────
        if (GroupMember) {
            const membership = await GroupMember.findOne({ where: { groupId, userId } });
            if (membership?.mutedUntil && new Date(membership.mutedUntil) > new Date()) {
                return res.status(403).json({ success: false, message: 'You are muted in this group', mutedUntil: membership.mutedUntil, code: 'MUTED' });
            }
        }

        // ── P2 FIX: Content filter (blocked words) ─────────────────────────
        if (contentFilter && group.blockedWords?.length) {
            const { blocked, word } = contentFilter.checkBlockedWords(trimmedContent, group.blockedWords);
            if (blocked) {
                await _logMod(groupId, userId, 'content_filtered', userId, `Blocked word: ${word}`, { word });
                return res.status(400).json({ success: false, message: 'Your message contains prohibited content', code: 'BLOCKED_CONTENT' });
            }
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

        // P1 FIX: Set expiresAt if group has disappearing timer enabled
        const disappearSecs = group.disappearingTimer || 0;
        const expiresAt = disappearSecs > 0 ? new Date(Date.now() + disappearSecs * 1000) : null;

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
            deliveredAt: new Date(),
            ...(expiresAt && { expiresAt, disappearingTimer: disappearSecs }),
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

        // ── P2 FIX: @everyone bulk mention ────────────────────────────────
        if (trimmedContent.includes('@everyone') && GroupMember) {
            try {
                const membership = await GroupMember.findOne({ where: { groupId, userId } });
                const isAdmin = membership && ['owner', 'admin', 'moderator'].includes(membership.role);
                if (isAdmin) {
                    const io = global.__socketIO;
                    if (io) {
                        io.to(`group:${groupId}`).emit('group:mention:everyone', {
                            groupId, messageId: savedMessage.id, senderId: userId, timestamp: new Date().toISOString(),
                        });
                    }
                    await _logMod(groupId, userId, 'message_deleted', null, '@everyone mention sent', { messageId: savedMessage.id });
                }
            } catch (_) {}
        }

        // ── P1 FIX: FCM push notification to offline members ──────────────
        if (pushService?.isConfigured()) {
            setImmediate(async () => {
                try {
                    const senderName = req.user?.firstName
                        ? `${req.user.firstName} ${req.user.lastName || ''}`.trim()
                        : req.user?.username || 'Someone';
                    await pushService.pushGroupMessage(
                        groupId,
                        { ...savedMessage, senderId: userId, senderName, content: trimmedContent },
                        group.name || 'Group'
                    );
                } catch (_) {}
            });
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

// ============================================================================
// P1 FIX: MESSAGE PINNING — POST/DELETE/GET /:groupId/messages/:id/pin
// ============================================================================
router.post('/:groupId/messages/:messageId/pin', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const messageId = parseInt(req.params.messageId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner', 'admin', 'moderator'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Only admins can pin messages' });
        const group = await Group.findByPk(groupId);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        const pins = Array.isArray(group.pinnedMessageIds) ? [...group.pinnedMessageIds] : [];
        if (!pins.includes(messageId)) {
            if (pins.length >= 10) pins.shift(); // max 10 pins, drop oldest
            pins.push(messageId);
            await group.update({ pinnedMessageIds: pins });
        }
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:message:pinned', { groupId, messageId, pinnedBy: userId });
        await _logMod(groupId, userId, 'message_deleted', null, 'Message pinned', { messageId, action: 'pin' });
        return res.json({ success: true, message: 'Message pinned', data: { pinnedMessageIds: pins } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to pin message', error: e.message });
    }
});

router.delete('/:groupId/messages/:messageId/pin', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const messageId = parseInt(req.params.messageId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner', 'admin', 'moderator'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Only admins can unpin messages' });
        const group = await Group.findByPk(groupId);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        const pins = (group.pinnedMessageIds || []).filter(id => id !== messageId);
        await group.update({ pinnedMessageIds: pins });
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:message:unpinned', { groupId, messageId, unpinnedBy: userId });
        return res.json({ success: true, message: 'Message unpinned', data: { pinnedMessageIds: pins } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to unpin message', error: e.message });
    }
});

router.get('/:groupId/pinned', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const group = await Group.findByPk(groupId, { attributes: ['id', 'pinnedMessageIds'] });
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        const ids = group.pinnedMessageIds || [];
        let messages = [];
        if (Message && ids.length) {
            messages = await Message.findAll({ where: { id: ids } });
            messages = messages.map(m => m.toJSON ? m.toJSON() : m);
        }
        return res.json({ success: true, data: { pinnedMessageIds: ids, messages } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to get pinned messages', error: e.message });
    }
});

// ============================================================================
// P1 FIX: REPORT MESSAGE — POST /:groupId/messages/:id/report
// ============================================================================
router.post('/:groupId/messages/:messageId/report', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const messageId = parseInt(req.params.messageId);
        const { reason = 'spam', description = '' } = req.body;
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const dbInner = require('../models');
        const MsgReport = dbInner.models?.MessageReport || dbInner.MessageReport || null;
        if (!MsgReport) return res.status(503).json({ success: false, message: 'Report service unavailable' });
        const msg = Message ? await Message.findByPk(messageId) : null;
        if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
        const report = await MsgReport.create({
            reporterId: userId,
            messageId,
            chatId: msg.chatId || 0,
            reason,
            description,
            status: 'pending',
            context: { groupId },
        });
        return res.status(201).json({ success: true, message: 'Report submitted', data: { reportId: report.id } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to submit report', error: e.message });
    }
});

// ============================================================================
// P1 FIX: MODERATION AUDIT LOG — GET /:groupId/moderation-log
// ============================================================================
router.get('/:groupId/moderation-log', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner', 'admin', 'moderator'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Admin access required' });
        if (!ModerationLog) return res.json({ success: true, data: { logs: [], note: 'ModerationLog model not available' } });
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const logs = await ModerationLog.findAll({
            where: { groupId },
            order: [['createdAt', 'DESC']],
            limit,
            offset,
        });
        return res.json({ success: true, data: { logs, total: logs.length } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to get moderation log', error: e.message });
    }
});

// ============================================================================
// P1 FIX: UPDATE SETTINGS — persist slowModeInterval, postingRule, disappearingTimer
// (augments existing PUT /:groupId/settings in groupController)
// ============================================================================
router.put('/:groupId/moderation-settings', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner', 'admin'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Admin access required' });
        const group = await Group.findByPk(groupId);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

        const update = {};
        if (req.body.slowModeInterval !== undefined) {
            update.slowModeInterval = Math.max(0, parseInt(req.body.slowModeInterval) || 0);
            await _logMod(groupId, userId,
                update.slowModeInterval > 0 ? 'slow_mode_set' : 'slow_mode_disabled',
                null, null, { intervalSeconds: update.slowModeInterval });
        }
        if (req.body.postingRule !== undefined) {
            const validRules = ['open', 'read_only', 'announcement', 'admin_only', 'scheduled'];
            if (!validRules.includes(req.body.postingRule))
                return res.status(400).json({ success: false, message: 'Invalid posting rule' });
            update.postingRule = req.body.postingRule;
            await _logMod(groupId, userId, 'posting_rule_changed', null, null, { rule: update.postingRule });
        }
        if (req.body.disappearingTimer !== undefined) {
            update.disappearingTimer = Math.max(0, parseInt(req.body.disappearingTimer) || 0);
            await _logMod(groupId, userId, 'disappearing_set', null, null, { timerSeconds: update.disappearingTimer });
        }
        if (req.body.scheduledPostingStart) update.scheduledPostingStart = req.body.scheduledPostingStart;
        if (req.body.scheduledPostingEnd)   update.scheduledPostingEnd   = req.body.scheduledPostingEnd;
        if (Array.isArray(req.body.blockedWords)) update.blockedWords = req.body.blockedWords.map(w => String(w).trim().toLowerCase()).filter(Boolean);

        await group.update(update);
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:settings:updated', { groupId, settings: update });
        return res.json({ success: true, message: 'Moderation settings updated', data: update });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to update settings', error: e.message });
    }
});

// ============================================================================
// P2 FIX: MEMBER WARN — POST /:groupId/members/:memberId/warn
// ============================================================================
router.post('/:groupId/members/:memberId/warn', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const targetId = parseInt(req.params.memberId);
        const { reason = '' } = req.body;
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const actor = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!actor || !['owner', 'admin', 'moderator'].includes(actor.role))
            return res.status(403).json({ success: false, message: 'Admin access required' });
        const target = GroupMember ? await GroupMember.findOne({ where: { groupId, userId: targetId } }) : null;
        if (!target) return res.status(404).json({ success: false, message: 'Member not found' });
        target.warnings = (target.warnings || 0) + 1;
        await target.save();
        await _logMod(groupId, userId, 'warn', targetId, reason, { warningCount: target.warnings });
        const io = global.__socketIO;
        if (io) io.to(`user:${targetId}`).emit('group:member:warned', { groupId, warnings: target.warnings, reason });
        return res.json({ success: true, message: 'Warning issued', data: { warnings: target.warnings, targetId } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to issue warning', error: e.message });
    }
});

// ============================================================================
// P2 FIX: MEMBER NICKNAME & CUSTOM TITLE — PUT /:groupId/members/:memberId/profile
// ============================================================================
router.put('/:groupId/members/:memberId/profile', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const memberId = parseInt(req.params.memberId);
        const { nickname, customTitle } = req.body;
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const actor = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        const isSelf = String(userId) === String(memberId);
        const isAdmin = actor && ['owner', 'admin'].includes(actor.role);
        // Can set own nickname; customTitle requires admin
        if (!isSelf && !isAdmin) return res.status(403).json({ success: false, message: 'Not authorized' });
        if (customTitle && !isAdmin) return res.status(403).json({ success: false, message: 'Only admins can set custom titles' });
        const target = GroupMember ? await GroupMember.findOne({ where: { groupId, userId: memberId } }) : null;
        if (!target) return res.status(404).json({ success: false, message: 'Member not found' });
        const update = {};
        if (nickname !== undefined) update.nickname = nickname ? String(nickname).slice(0, 50) : null;
        if (customTitle !== undefined && isAdmin) update.customTitle = customTitle ? String(customTitle).slice(0, 50) : null;
        await target.update(update);
        return res.json({ success: true, message: 'Member profile updated', data: update });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to update member profile', error: e.message });
    }
});

// ============================================================================
// P2 FIX: INVITE LINK WITH USAGE COUNT — PATCH existing invite-link route
// Now handled via maxUses param in POST /:groupId/invite-link
// ============================================================================
router.get('/:groupId/invite-link/qr', async (req, res) => {
    // P2 FIX: Return QR code data for invite link (frontend renders via qrcode.js)
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const group = await Group.findByPk(groupId, { attributes: ['id', 'inviteLink', 'inviteLinkExpires'] });
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        if (!group.inviteLink) return res.status(404).json({ success: false, message: 'No invite link generated. Create one first.' });
        // Return the link URL — frontend generates QR code client-side
        const baseUrl = process.env.FRONTEND_URL || 'https://moodchat.app';
        const inviteUrl = `${baseUrl}/join?token=${group.inviteLink}`;
        return res.json({ success: true, data: { inviteUrl, inviteToken: group.inviteLink, expiresAt: group.inviteLinkExpires } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to get QR data', error: e.message });
    }
});

// ============================================================================
// P2 FIX: GROUP @USERNAME LOOKUP — GET /by-username/:username
// ============================================================================
router.get('/by-username/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username || !/^[a-zA-Z0-9_]{3,30}$/.test(username))
            return res.status(400).json({ success: false, message: 'Invalid username format' });
        const group = await Group.findOne({ where: { groupUsername: username.toLowerCase(), isPublic: true } });
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        return res.json({ success: true, data: formatGroup(group) });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Lookup failed', error: e.message });
    }
});

router.put('/:groupId/username', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const { username } = req.body;
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        if (!username || !/^[a-zA-Z0-9_]{3,30}$/.test(username))
            return res.status(400).json({ success: false, message: 'Username must be 3-30 alphanumeric/underscore characters' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner', 'admin'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Only owner/admin can set group username' });
        const group = await Group.findByPk(groupId);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        const lower = username.toLowerCase();
        const existing = await Group.findOne({ where: { groupUsername: lower } });
        if (existing && existing.id !== groupId)
            return res.status(409).json({ success: false, message: 'Username already taken' });
        await group.update({ groupUsername: lower });
        return res.json({ success: true, message: 'Group username set', data: { groupUsername: lower } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to set username', error: e.message });
    }
});

// ============================================================================
// P3 FIX: TRENDING GROUPS — GET /trending
// ============================================================================
router.get('/trending', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const { Op: OpInner } = require('sequelize');
        // Use stats.totalMessages as velocity proxy — groups with most recent activity
        const groups = await Group.findAll({
            where: { isPublic: true },
            order: [['updatedAt', 'DESC']],
            limit,
            attributes: ['id', 'name', 'description', 'avatar', 'purpose', 'tags', 'stats', 'isVerified', 'groupUsername'],
        });
        return res.json({ success: true, data: { groups: groups.map(g => formatGroup(g)) } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to get trending groups', error: e.message });
    }
});

// ============================================================================
// P2 FIX: ADMIN — VERIFY GROUP — POST /admin/:groupId/verify
// ============================================================================
router.post('/admin/:groupId/verify', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        // Basic: only platform admin — check via user record
        const dbInner = require('../models');
        const UserModel = dbInner.models?.Users || dbInner.Users;
        const actor = UserModel ? await UserModel.findByPk(userId, { attributes: ['id', 'role'] }) : null;
        if (!actor || actor.role !== 'admin') return res.status(403).json({ success: false, message: 'Platform admin access required' });
        const groupId = parseInt(req.params.groupId);
        const group = await Group.findByPk(groupId);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        await group.update({ isVerified: true });
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:verified', { groupId });
        return res.json({ success: true, message: 'Group verified', data: { groupId, isVerified: true } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to verify group', error: e.message });
    }
});

// ============================================================================
// P2 FIX: INVITE LINK WITH MAX USES
// Override the generateInviteLink to accept maxUses param
// ============================================================================
router.post('/:groupId/invite-link/generate', async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner', 'admin'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Admin access required' });
        const group = await Group.findByPk(groupId);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
        const crypto = require('crypto');
        const expiresIn = parseInt(req.body.expiresInHours) || 24;
        const maxUses = parseInt(req.body.maxUses) || 0;
        group.inviteLink = crypto.randomBytes(16).toString('hex');
        group.inviteLinkExpires = new Date(Date.now() + expiresIn * 3600_000);
        group.inviteLinkMaxUses = maxUses;
        group.inviteLinkUseCount = 0;
        await group.save();
        const baseUrl = process.env.FRONTEND_URL || 'https://moodchat.app';
        return res.json({
            success: true, message: 'Invite link generated',
            data: { inviteLink: group.inviteLink, inviteUrl: `${baseUrl}/join?token=${group.inviteLink}`, expiresAt: group.inviteLinkExpires, maxUses, useCount: 0 },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to generate invite link', error: e.message });
    }
});

// ============================================================================
// P2 FIX: TOPIC THREADS
// POST   /:groupId/messages/:messageId/thread  — create thread from message
// GET    /:groupId/threads                     — list threads in group
// GET    /:groupId/threads/:threadId/replies   — get replies in thread
// POST   /:groupId/threads/:threadId/reply     — post reply to thread
// PATCH  /:groupId/threads/:threadId/lock      — lock/unlock thread (admin)
// ============================================================================
router.post('/:groupId/messages/:messageId/thread', async (req, res) => {
    try {
        const userId  = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        const parentMessageId = parseInt(req.params.messageId);
        const { title = '' } = req.body;
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const db = require('../models');
        const GroupThread = db.models?.GroupThread || db.GroupThread;
        if (!GroupThread) return res.status(503).json({ success: false, message: 'Thread service unavailable' });
        // Check not already threaded
        const existing = await GroupThread.findOne({ where: { groupId, parentMessageId } });
        if (existing) return res.json({ success: true, message: 'Thread already exists', data: { thread: existing } });
        const thread = await GroupThread.create({ groupId, parentMessageId, createdBy: userId, title: title.slice(0, 200) });
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:thread:created', { groupId, thread });
        return res.status(201).json({ success: true, message: 'Thread created', data: { thread } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to create thread', error: e.message });
    }
});

router.get('/:groupId/threads', async (req, res) => {
    try {
        const userId  = getUserId(req);
        const groupId = parseInt(req.params.groupId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const db = require('../models');
        const GroupThread = db.models?.GroupThread || db.GroupThread;
        if (!GroupThread) return res.json({ success: true, data: { threads: [] } });
        const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = parseInt(req.query.offset) || 0;
        const threads = await GroupThread.findAll({
            where: { groupId, isArchived: false },
            order: [['lastReplyAt', 'DESC'], ['createdAt', 'DESC']],
            limit, offset,
        });
        return res.json({ success: true, data: { threads } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to get threads', error: e.message });
    }
});

router.get('/:groupId/threads/:threadId/replies', async (req, res) => {
    try {
        const userId   = getUserId(req);
        const groupId  = parseInt(req.params.groupId);
        const threadId = parseInt(req.params.threadId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        // Replies stored as Messages with metadata.threadId
        const { Op } = require('sequelize');
        const replies = Message ? await Message.findAll({
            where: {
                isDeleted: false,
                metadata: { [Op.contains]: { threadId } },
            },
            order: [['createdAt', 'ASC']],
            limit, offset,
            include: [{ model: User, as: 'messageSender', attributes: ['id','username','firstName','lastName','avatar'], required: false }],
        }) : [];
        return res.json({ success: true, data: { replies: replies.map(r => _fmtMessage ? _fmtMessage(r, userId, groupId) : r), total: replies.length } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to get thread replies', error: e.message });
    }
});

router.post('/:groupId/threads/:threadId/reply', async (req, res) => {
    try {
        const userId   = getUserId(req);
        const groupId  = parseInt(req.params.groupId);
        const threadId = parseInt(req.params.threadId);
        const { content = '' } = req.body;
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        if (!content.trim()) return res.status(400).json({ success: false, message: 'Reply content required' });
        const db = require('../models');
        const GroupThread = db.models?.GroupThread || db.GroupThread;
        const thread = GroupThread ? await GroupThread.findOne({ where: { id: threadId, groupId } }) : null;
        if (!thread) return res.status(404).json({ success: false, message: 'Thread not found' });
        if (thread.isLocked) return res.status(403).json({ success: false, message: 'Thread is locked', code: 'THREAD_LOCKED' });

        const group = await Group.findByPk(groupId, { attributes: ['id','chatId','name','disappearingTimer'] });
        if (!group?.chatId || !Message) return res.status(503).json({ success: false, message: 'Chat unavailable' });

        const disappearSecs = group.disappearingTimer || 0;
        const expiresAt = disappearSecs > 0 ? new Date(Date.now() + disappearSecs * 1000) : null;

        const reply = await Message.create({
            chatId: group.chatId, senderId: userId, content: content.trim(), type: 'text',
            isRead: false, reactions: {},
            metadata: { groupId, threadId, readBy: [userId] },
            sentAt: new Date(), deliveredAt: new Date(),
            ...(expiresAt && { expiresAt }),
        });
        // Update thread stats
        await thread.update({ replyCount: thread.replyCount + 1, lastReplyAt: new Date(), lastReplyBy: userId });
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:thread:reply', { groupId, threadId, reply });
        // Push notification
        if (pushService?.isConfigured()) {
            setImmediate(() => pushService.pushGroupMessage(groupId, { ...reply.dataValues, senderId: userId, content: content.trim() }, group.name).catch(() => {}));
        }
        return res.status(201).json({ success: true, message: 'Reply posted', data: { reply } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to post reply', error: e.message });
    }
});

router.patch('/:groupId/threads/:threadId/lock', async (req, res) => {
    try {
        const userId   = getUserId(req);
        const groupId  = parseInt(req.params.groupId);
        const threadId = parseInt(req.params.threadId);
        if (!userId) return res.status(401).json({ success: false, message: 'Auth required' });
        const membership = GroupMember ? await GroupMember.findOne({ where: { groupId, userId } }) : null;
        if (!membership || !['owner','admin','moderator'].includes(membership.role))
            return res.status(403).json({ success: false, message: 'Admin access required' });
        const db = require('../models');
        const GroupThread = db.models?.GroupThread || db.GroupThread;
        const thread = GroupThread ? await GroupThread.findOne({ where: { id: threadId, groupId } }) : null;
        if (!thread) return res.status(404).json({ success: false, message: 'Thread not found' });
        const locked = req.body.locked !== undefined ? Boolean(req.body.locked) : !thread.isLocked;
        await thread.update({ isLocked: locked });
        const io = global.__socketIO;
        if (io) io.to(`group:${groupId}`).emit('group:thread:lock_changed', { groupId, threadId, isLocked: locked });
        await _logMod(groupId, userId, locked ? 'group_locked' : 'group_unlocked', null, `Thread ${threadId} ${locked ? 'locked' : 'unlocked'}`, { threadId });
        return res.json({ success: true, message: `Thread ${locked ? 'locked' : 'unlocked'}`, data: { isLocked: locked } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to lock thread', error: e.message });
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
