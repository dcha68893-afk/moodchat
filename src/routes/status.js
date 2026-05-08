// routes/status.js - Complete Status Management Routes
// FIXED v6.2:
//   1. ALL protected routes now have authenticateToken applied INDIVIDUALLY
//   2. Route order: SPECIFIC paths BEFORE parameterized paths
//   3. Removed router.use(authenticateToken) - each protected route gets auth individually
//   4. Fixed /my route - now properly protected
//   5. Added proper error handling for invalid status IDs
//   6. ADDED /highlights and /drafts routes (FIXED v6.1)
//   7. ADDED /scheduled route for scheduled statuses (FIXED v6.2)

'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { authenticateToken, optionalAuthenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const WebSocketService = require('../services/webSocketService');
const { getAcceptedFriendIds } = require('../services/statusService');
// FIX: logger needed for friend-targeted socket emit logging
let logger;
try { logger = require('../utils/logger'); } catch(_) { logger = console; }

// ---------------------------------------------------------------------------
// Model imports
// ---------------------------------------------------------------------------
let db, User, Status, StatusLike, StatusComment, StatusView, StatusReaction, StatusReply, Message, Friend;
try {
    db = require('../models');
    User = db.User || db.Users;
    Status = db.Status || db.Statuses;
    StatusLike = db.StatusLike || db.StatusLikes;
    StatusComment = db.StatusComment || db.StatusComments;
    StatusView = db.StatusView || db.StatusViews;
    StatusReaction = db.StatusReaction || db.StatusReactions;
    StatusReply = db.StatusReply || db.StatusReplies;
    Message = db.Message || db.Messages;
    Friend = db.Friend || db.Friends;
    console.log('[Status Route] Models loaded - User:', !!User, 'Status:', !!Status, 'Friend:', !!Friend);
} catch (e) {
    console.error('[Status Route] Error loading models:', e.message);
}

const Sequelize = require('sequelize');
const { Op } = Sequelize;

console.log('✅ Status routes initialized (v6.2 - added /scheduled route)');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const formatUser = (u) => {
    if (!u) return null;
    const d = u.toJSON ? u.toJSON() : u;
    return {
        id: d.id,
        username: d.username,
        avatar: d.avatar,
        displayName: [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.username,
        firstName: d.firstName || '',
        lastName: d.lastName || '',
        status: d.status,
        lastSeen: d.lastSeen,
    };
};

const formatStatus = (s) => {
    if (!s) return null;
    const d = s.toJSON ? s.toJSON() : s;
    return {
        id: d.id,
        userId: d.userId,
        content: d.content,
        type: d.type,
        moodType: d.moodType,
        mediaUrl: d.mediaUrl,
        location: d.location,
        latitude: d.latitude,
        longitude: d.longitude,
        isActive: d.isActive,
        isPublic: d.isPublic,
        privacy: normalizePrivacy(d.privacy, d.isPublic),
        expiresAt: d.expiresAt,
        viewCount: d.viewCount || 0,
        likeCount: d.likeCount || 0,
        commentCount: d.commentCount || 0,
        shareCount: d.shareCount || 0,
        metadata: d.metadata,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        user: formatUser(d.statusUser || d.user),
    };
};

const getUserId = (req) => req.user?.userId || req.user?.id || null;

const VALID_TYPES = ['text', 'image', 'video', 'audio', 'mood', 'location'];
const VALID_MOODS = ['happy', 'sad', 'angry', 'excited', 'calm', 'anxious', 'tired', 'energetic',
    'focused', 'relaxed', 'nostalgic', 'romantic', 'lonely', 'confused', 'proud',
    'grateful', 'hopeful', 'bored', 'sick', 'neutral'];
const VALID_PRIVACY = ['public', 'everyone', 'friends', 'close-friends', 'private', 'except', 'specific', 'micro-circle'];

const userInclude = () => User ? [{
    model: User,
    as: 'statusUser',
    required: false,
    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
}] : [];

const activeWhere = () => ({
    isActive: true,
    [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
});

const getStatusMetadata = (status) => {
    if (!status) return {};
    const raw = status.toJSON ? status.toJSON() : status;
    return raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
};

const normalizePrivacy = (privacy, isPublic = false) => {
    const value = String(privacy || '').trim().toLowerCase();
    if (VALID_PRIVACY.includes(value)) return value;
    return isPublic ? 'everyone' : 'friends';
};

const normalizeUserIds = (value) => {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(
        source
            .map((entry) => Number(entry))
            .filter((entry) => Number.isInteger(entry) && entry > 0)
    )];
};

const getAllowedUserIds = (status) => {
    const metadata = getStatusMetadata(status);
    return normalizeUserIds(
        metadata.allowedUserIds ||
        metadata.allowedUsers ||
        metadata.selectedFriendIds ||
        metadata.specificUserIds ||
        []
    );
};

const getExcludedUserIds = (status) => {
    const metadata = getStatusMetadata(status);
    return normalizeUserIds(metadata.excludedUserIds || metadata.excludedUsers || []);
};

const canReplyToStatus = (status) => {
    const metadata = getStatusMetadata(status);
    return metadata.allowReplies !== false;
};

const getIO = (req) => {
    return req?.io || (req?.app && req.app.get && req.app.get('io')) || WebSocketService.getIO?.() || global.__socketIO || null;
};

const emitToUsers = (io, userIds, eventName, payload) => {
    if (!io) return;
    [...new Set((userIds || []).map((id) => Number(id)).filter(Boolean))].forEach((userId) => {
        try {
            io.to(`user:${userId}`).emit(eventName, payload);
        } catch (_error) {}
    });
};

const buildFriendContext = async (viewerId) => {
    const context = {
        acceptedFriendIds: new Set(),
        blockedUserIds: new Set(),
        closeFriendIds: new Set(),
    };

    if (!viewerId || !Friend) {
        return context;
    }

    const relationships = await Friend.findAll({
        where: {
            [Op.or]: [{ requesterId: viewerId }, { receiverId: viewerId }],
        },
        attributes: ['requesterId', 'receiverId', 'status', 'closenessLevel', 'category'],
    }).catch(() => []);

    for (const relationship of relationships) {
        const otherUserId = Number(relationship.requesterId) === Number(viewerId)
            ? Number(relationship.receiverId)
            : Number(relationship.requesterId);

        if (!otherUserId) continue;

        if (relationship.status === 'accepted') {
            context.acceptedFriendIds.add(otherUserId);
            if (Number(relationship.closenessLevel || 0) >= 7 || String(relationship.category || '').toLowerCase() === 'close-friends') {
                context.closeFriendIds.add(otherUserId);
            }
        }

        if (relationship.status === 'blocked') {
            context.blockedUserIds.add(otherUserId);
        }
    }

    return context;
};

const canUserViewStatus = async (status, viewerId, context = null) => {
    if (!status) return false;

    const ownerId = Number(status.userId);
    const currentViewerId = viewerId ? Number(viewerId) : null;
    if (currentViewerId && ownerId === currentViewerId) return true;

    const privacy = normalizePrivacy(status.privacy, status.isPublic);
    if (!currentViewerId) {
        return privacy === 'public' || privacy === 'everyone' || status.isPublic === true;
    }

    const friendContext = context || await buildFriendContext(currentViewerId);
    if (friendContext.blockedUserIds.has(ownerId)) {
        return false;
    }

    if (privacy === 'public' || privacy === 'everyone' || status.isPublic === true) {
        return true;
    }

    if (!friendContext.acceptedFriendIds.has(ownerId)) {
        return false;
    }

    if (privacy === 'friends') return true;
    if (privacy === 'close-friends') {
        const allowedIds = getAllowedUserIds(status);
        return friendContext.closeFriendIds.has(ownerId) || allowedIds.includes(currentViewerId);
    }
    if (privacy === 'except') {
        return !getExcludedUserIds(status).includes(currentViewerId);
    }
    if (privacy === 'specific' || privacy === 'micro-circle') {
        return getAllowedUserIds(status).includes(currentViewerId);
    }

    return false;
};

const filterStatusesForViewer = async (rows, viewerId, context = null) => {
    const friendContext = context || await buildFriendContext(viewerId);
    const result = [];

    for (const row of rows || []) {
        if (await canUserViewStatus(row, viewerId, friendContext)) {
            result.push(row);
        }
    }

    return result;
};

const getAudienceUserIds = async (status, ownerId = null) => {
    const creatorId = Number(ownerId || status?.userId);
    if (!creatorId) return [];

    const privacy = normalizePrivacy(status?.privacy, status?.isPublic);
    const acceptedFriendIds = await getAcceptedFriendIds(creatorId).catch(() => []);
    let audience = [...acceptedFriendIds];

    if (privacy === 'private') {
        audience = [];
    } else if (privacy === 'close-friends') {
        const allowedIds = getAllowedUserIds(status);
        audience = allowedIds.length > 0 ? acceptedFriendIds.filter((id) => allowedIds.includes(Number(id))) : acceptedFriendIds;
    } else if (privacy === 'except') {
        const excludedIds = getExcludedUserIds(status);
        audience = acceptedFriendIds.filter((id) => !excludedIds.includes(Number(id)));
    } else if (privacy === 'specific' || privacy === 'micro-circle') {
        audience = getAllowedUserIds(status);
    }

    return [...new Set([creatorId, ...audience.map((id) => Number(id)).filter(Boolean)])];
};

const emitStatusEvent = async (req, eventName, status, extraPayload = {}) => {
    const io = getIO(req);
    if (!io || !status) return;

    const audience = await getAudienceUserIds(status, status.userId);
    const payload = {
        statusId: Number(status.id),
        userId: Number(status.userId),
        status: formatStatus(status),
        timestamp: new Date().toISOString(),
        ...extraPayload,
    };

    emitToUsers(io, audience, eventName, payload);
};

const recordStatusView = async (req, status, viewerId) => {
    if (!status || !viewerId || Number(status.userId) === Number(viewerId)) {
        return { alreadyViewed: true, viewCount: status?.viewCount || 0 };
    }

    let alreadyViewed = false;
    if (StatusView) {
        const existing = await StatusView.findOne({
            where: { statusId: Number(status.id), userId: Number(viewerId) }
        }).catch(() => null);
        alreadyViewed = !!existing;

        if (!alreadyViewed) {
            await StatusView.create({
                statusId: Number(status.id),
                userId: Number(viewerId),
                viewedAt: new Date(),
            }).catch(() => {});
        }
    }

    if (!alreadyViewed) {
        await Status.increment('viewCount', { where: { id: Number(status.id) } }).catch(() => {});
        status.viewCount = Number(status.viewCount || 0) + 1;

        const io = getIO(req);
        const payload = {
            statusId: Number(status.id),
            userId: Number(status.userId),
            viewerId: Number(viewerId),
            viewerCount: Number(status.viewCount || 0),
            viewCount: Number(status.viewCount || 0),
            viewedAt: new Date().toISOString(),
            timestamp: new Date().toISOString(),
        };
        emitToUsers(io, [status.userId], 'status:viewed', payload);
        emitToUsers(io, [status.userId, viewerId], 'status:viewer_update', payload);
    }

    return { alreadyViewed, viewCount: Number(status.viewCount || 0) };
};

const ensureModels = (req, res, next) => {
    if (!User) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
    next();
};

router.use(ensureModels);
router.use((req, _res, next) => {
    if (!req.io) {
        req.io = getIO(req);
    }
    next();
});

if (!global.__statusExpiryCleanupStarted) {
    global.__statusExpiryCleanupStarted = true;
    setInterval(async () => {
        try {
            if (!Status) return;
            const expiredStatuses = await Status.findAll({
                where: {
                    isActive: true,
                    expiresAt: { [Op.lte]: new Date() },
                },
                limit: 100,
            }).catch(() => []);

            for (const status of expiredStatuses) {
                await status.update({ isActive: false }).catch(() => {});
                const io = WebSocketService.getIO?.() || global.__socketIO || null;
                const audience = await getAudienceUserIds(status, status.userId);
                emitToUsers(io, audience, 'status:expired', {
                    statusId: Number(status.id),
                    userId: Number(status.userId),
                    timestamp: new Date().toISOString(),
                });
            }
        } catch (error) {
            logger.warn(`[status.js] expiry cleanup failed: ${error.message}`);
        }
    }, 60 * 1000);
}

// ============================================================================
// PUBLIC ROUTES (no authentication required)
// ============================================================================

// Health check
router.get('/health', (req, res) => res.json({
    success: true,
    status: 'online',
    service: 'Status API',
    timestamp: new Date().toISOString(),
}));

// All active public statuses
router.get('/', apiRateLimiter, asyncHandler(async (req, res) => {
    const { limit = 20, offset = 0, type, moodType } = req.query;
    const where = { isPublic: true, ...activeWhere() };
    if (type && VALID_TYPES.includes(type)) where.type = type;
    if (moodType && VALID_MOODS.includes(moodType)) where.moodType = moodType;

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// Public alias
router.get('/public', apiRateLimiter, asyncHandler(async (req, res) => {
    const { limit = 20, offset = 0 } = req.query;
    const where = { isPublic: true, ...activeWhere() };

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// Trending statuses (last 24 hours)
router.get('/trending', apiRateLimiter, asyncHandler(async (req, res) => {
    const { limit = 10 } = req.query;
    const where = {
        isPublic: true,
        ...activeWhere(),
        createdAt: { [Op.gte]: new Date(Date.now() - 24 * 3600000) },
    };

    let rows = [];
    if (Status) {
        rows = await Status.findAll({
            where,
            include: userInclude(),
            order: [['likeCount', 'DESC'], ['viewCount', 'DESC'], ['createdAt', 'DESC']],
            limit: Math.min(+limit, 50),
        }).catch(() => []);
    }

    res.json({ success: true, data: { statuses: rows.map(formatStatus), total: rows.length } });
}));

// Search public statuses
router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
    const { q, limit = 20, offset = 0 } = req.query;
    if (!q || q.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
    }

    const where = { isPublic: true, content: { [Op.iLike]: `%${q}%` }, ...activeWhere() };
    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            query: q,
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// Filter by mood
router.get('/mood/:moodType', apiRateLimiter, asyncHandler(async (req, res) => {
    const { moodType } = req.params;
    if (!VALID_MOODS.includes(moodType)) {
        return res.status(400).json({ success: false, message: 'Invalid mood type' });
    }

    const { limit = 20, offset = 0 } = req.query;
    const where = { isPublic: true, type: 'mood', moodType, ...activeWhere() };

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            moodType,
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// Comments on public statuses (read-only)
router.get('/:statusId/comments', apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;
    
    // Validate statusId is a number
    if (isNaN(+statusId)) {
        return res.status(400).json({ success: false, message: 'Invalid status ID' });
    }
    
    const { limit = 20, offset = 0 } = req.query;

    let rows = [], total = 0;
    if (StatusComment) {
        const include = User ? [{
            model: User,
            as: 'commentUser',
            required: false,
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
        }] : [];
        const r = await StatusComment.findAndCountAll({
            where: { statusId },
            include,
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            comments: rows.map(c => ({
                id: c.id,
                statusId: c.statusId,
                userId: c.userId,
                content: c.content,
                createdAt: c.createdAt,
                user: c.commentUser ? formatUser(c.commentUser) : null,
            })),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// Likes on public statuses (read-only)
router.get('/:statusId/likes', apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;
    
    // Validate statusId is a number
    if (isNaN(+statusId)) {
        return res.status(400).json({ success: false, message: 'Invalid status ID' });
    }
    
    const { limit = 20, offset = 0 } = req.query;

    let rows = [], total = 0;
    if (StatusLike) {
        const include = User ? [{
            model: User,
            as: 'likeUser',
            required: false,
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
        }] : [];
        const r = await StatusLike.findAndCountAll({
            where: { statusId },
            include,
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            likes: rows.map(l => ({
                id: l.id,
                statusId: l.statusId,
                userId: l.userId,
                createdAt: l.createdAt,
                user: l.likeUser ? formatUser(l.likeUser) : null,
            })),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// ============================================================================
// PROTECTED ROUTES (require authentication token - applied INDIVIDUALLY)
// ============================================================================

// ── Create status (PROTECTED)
router.post(
    '/',
    authenticateToken,
    [
        body('content').optional().isLength({ max: 500 }).withMessage('Content too long'),
        body('type').optional().isIn(VALID_TYPES).withMessage('Invalid type'),
        body('moodType').optional().isIn(VALID_MOODS).withMessage('Invalid mood'),
        body('mediaUrl').optional().isURL().withMessage('Invalid media URL'),
        body('isPublic').optional().isBoolean(),
        body('privacy').optional().isString(),
    ],
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
        }

        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const {
            content, type, moodType, mediaUrl,
            location, latitude, longitude,
            isPublic, background, expiresAt, privacy,
            text, duration, allowReplies,
            allowedUserIds, selectedFriendIds, excludedUserIds, specificUserIds,
            caption, mediaType, fontFamily, textColor, actionButtons,
        } = req.body;

        const finalContent = content || text || '';
        if (!finalContent && type !== 'mood' && type !== 'location' && !mediaUrl) {
            return res.status(400).json({ success: false, message: 'Content is required' });
        }

        if (!Status) {
            return res.status(503).json({
                success: false,
                message: 'Status service unavailable',
                code: 'STATUS_MODEL_UNAVAILABLE'
            });
        }

        const safePrivacy = normalizePrivacy(privacy, isPublic);
        const resolvedIsPublic = safePrivacy === 'public' || safePrivacy === 'everyone'
            ? true
            : typeof isPublic === 'boolean'
                ? isPublic
                : false;
        const durationMs = Number(duration || 86400) * 1000;
        const allowList = normalizeUserIds(allowedUserIds || selectedFriendIds || specificUserIds);
        const excludeList = normalizeUserIds(excludedUserIds);
        const statusData = {
            userId,
            content: finalContent,
            type: type || 'text',
            moodType: moodType || null,
            mediaUrl: mediaUrl || null,
            location: location || null,
            latitude: latitude || null,
            longitude: longitude || null,
            isPublic: resolvedIsPublic,
            privacy: safePrivacy,
            isActive: true,
            metadata: {
                ...(background ? { background } : {}),
                ...(caption ? { caption: String(caption).trim() } : {}),
                ...(mediaType ? { mediaType: String(mediaType).trim() } : {}),
                ...(fontFamily ? { fontFamily: String(fontFamily).trim() } : {}),
                ...(textColor ? { textColor: String(textColor).trim() } : {}),
                ...(Array.isArray(actionButtons) ? { actionButtons } : {}),
                allowReplies: allowReplies !== false,
                allowedUserIds: allowList,
                selectedFriendIds: allowList,
                excludedUserIds: excludeList,
            },
            expiresAt: expiresAt ? new Date(expiresAt) : new Date(Date.now() + (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 24 * 3600000)),
        };

        const created = await Status.create(statusData);

        const user = User ? await User.findByPk(userId, {
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
        }).catch(() => null) : null;
        if (user) created.dataValues.statusUser = user;

        if (false && req.io) {
            // FIX Bug C: was req.io.emit() = global broadcast to ALL sockets.
            // FIX Bug D: payload was missing the full `status` object so receivers
            //            couldn't render the card without a second fetch.
            // Now: emit only to accepted friends' user rooms, with full status object.
            const io = req.io || (req.app && req.app.get && req.app.get('io'));
            const wsPayload = {
                statusId:  created.id,
                userId,
                type:      created.type,
                content:   created.content,
                mediaUrl:  created.mediaUrl  || null,
                createdAt: created.createdAt,
                expiresAt: created.expiresAt || null,
                status:    formatStatus(created), // FIX Bug D: include full object
                timestamp: new Date().toISOString()
            };

            // Emit to creator's own room so their other tabs/devices update
            io.to(`user:${userId}`).emit('status:created', wsPayload);
            io.to(`user:${userId}`).emit('new_status',     wsPayload);

            // Emit to each accepted friend's room asynchronously (non-blocking)
            const { getAcceptedFriendIds } = require('../services/statusService');
            getAcceptedFriendIds(userId).then(friendIds => {
                friendIds.forEach(fid => {
                    try {
                        io.to(`user:${fid}`).emit('status:created', wsPayload);
                        io.to(`user:${fid}`).emit('new_status',     wsPayload);
                        io.to(`user:${fid}`).emit('status_created', wsPayload);
                    } catch (_) {}
                });
                logger.info(`[status.js] 📡 status:created emitted to ${friendIds.length} friend rooms for userId=${userId}`);
            }).catch(err => {
                logger.warn(`[status.js] getAcceptedFriendIds failed, falling back to scoped emit: ${err.message}`);
                // Fallback: still emit to own room at minimum
            });
        }

        await emitStatusEvent(req, 'status:created', created, {
            type: created.type,
            content: created.content,
            mediaUrl: created.mediaUrl || null,
            createdAt: created.createdAt,
            expiresAt: created.expiresAt || null,
        });
        await emitStatusEvent(req, 'new_status', created);
        await emitStatusEvent(req, 'status_created', created);

        res.status(201).json({
            success: true,
            data: { status: formatStatus(created) },
            message: 'Status created successfully',
        });
    })
);

// ── My statuses (PROTECTED - SPECIFIC PATH)
router.get('/my', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { limit = 50, offset = 0, includeInactive = false } = req.query;
    const where = { userId };
    if (includeInactive !== 'true') Object.assign(where, activeWhere());

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// ── Friends' statuses (PROTECTED - SPECIFIC PATH)
router.get('/friends', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { limit = 50, offset = 0 } = req.query;
    const friendContext = await buildFriendContext(userId);
    const friendIds = [...friendContext.acceptedFriendIds];

    // FIX: Always include the viewer's own statuses in the feed so:
    //   1. User A can see their own posted status immediately after posting
    //   2. The list is never completely empty for a user with no friends yet
    const visibleUserIds = [...new Set([userId, ...friendIds])];

    const where = { userId: { [Op.in]: visibleUserIds }, ...activeWhere() };
    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    rows = await filterStatusesForViewer(rows, userId, friendContext);
    total = rows.length;

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// ============================================================================
// ADDED: /highlights, /drafts, and /scheduled routes (FIX v6.2)
// These MUST come BEFORE the parameterized /:statusId routes
// ============================================================================

// ── Highlights (PROTECTED - user's highlighted/popular statuses)
router.get('/highlights', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    
    const { limit = 50, offset = 0 } = req.query;
    let rows = [], total = 0;
    
    if (Status) {
        // Get most liked/viewed active statuses as "highlights"
        const r = await Status.findAndCountAll({
            where: { userId, isActive: true, ...activeWhere() },
            include: userInclude(),
            order: [['likeCount', 'DESC'], ['viewCount', 'DESC'], ['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }
    
    res.json({ 
        success: true, 
        data: { 
            statuses: rows.map(formatStatus), 
            total, 
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total } 
        } 
    });
}));

// ── Drafts (PROTECTED - user's inactive/draft statuses)
router.get('/drafts', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    
    const { limit = 50, offset = 0 } = req.query;
    let rows = [], total = 0;
    
    if (Status) {
        const r = await Status.findAndCountAll({
            where: { userId, isActive: false },
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }
    
    res.json({ 
        success: true, 
        data: { 
            statuses: rows.map(formatStatus), 
            total, 
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total } 
        } 
    });
}));

// ── Scheduled statuses (PROTECTED - create/get scheduled statuses)
router.get('/scheduled', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    
    const { limit = 50, offset = 0 } = req.query;
    let rows = [], total = 0;
    
    if (Status) {
        // Get scheduled statuses (isActive false with scheduled metadata)
        const r = await Status.findAndCountAll({
            where: { 
                userId, 
                isActive: false,
                metadata: { scheduled: true }
            },
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }
    
    res.json({ 
        success: true, 
        data: { 
            statuses: rows.map(formatStatus), 
            total, 
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total } 
        } 
    });
}));

// ── Create scheduled status (PROTECTED)
router.post('/scheduled', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    
    const { content, type, scheduledFor, mediaUrl, isPublic = true, moodType, location, latitude, longitude } = req.body;
    
    if (!scheduledFor) {
        return res.status(400).json({ success: false, message: 'scheduledFor is required' });
    }
    
    // Validate scheduledFor is a future date
    const scheduledDate = new Date(scheduledFor);
    if (isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid scheduledFor date' });
    }
    
    if (!Status) {
        return res.status(503).json({
            success: false,
            message: 'Status service unavailable',
            code: 'STATUS_MODEL_UNAVAILABLE'
        });
    }
    
    const statusData = {
        userId,
        content: content || '',
        type: type || 'text',
        moodType: moodType || null,
        mediaUrl: mediaUrl || null,
        location: location || null,
        latitude: latitude || null,
        longitude: longitude || null,
        isPublic,
        isActive: false,
        metadata: { scheduled: true, scheduledFor: scheduledFor },
        expiresAt: null
    };
    
    const created = await Status.create(statusData);
    
    const user = User ? await User.findByPk(userId, {
        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
    }).catch(() => null) : null;
    if (user) created.dataValues.statusUser = user;
    
    if (req.io) {
        req.io.emit('status:scheduled', {
            statusId: created.id,
            userId,
            scheduledFor,
            timestamp: new Date(),
        });
    }
    
    res.status(201).json({ 
        success: true, 
        data: { status: formatStatus(created) }, 
        message: 'Status scheduled successfully' 
    });
}));

// ============================================================================
// CONTINUE: More protected routes (SPECIFIC PATHS)
// ============================================================================

// GET /api/status/user/:userId - user statuses (PROTECTED - SPECIFIC PATH)
router.get('/user/:userId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const viewerId = getUserId(req);
    const targetId = req.params.userId;
    const { limit = 20, offset = 0, includeExpired = false } = req.query;

    const where = { userId: targetId };
    if (targetId !== viewerId) {
        Object.assign(where, activeWhere());
    } else if (includeExpired !== 'true') {
        Object.assign(where, activeWhere());
    }

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
    }

    if (targetId !== viewerId) {
        rows = await filterStatusesForViewer(rows, viewerId);
        total = rows.length;
    }

    res.json({
        success: true,
        data: {
            statuses: rows.map(formatStatus),
            pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
        }
    });
}));

// ── Stats (PROTECTED - SPECIFIC PATH)
router.get('/stats', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { period = '7d' } = req.query;
    const periodMs = { '1d': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000 };
    if (!periodMs[period]) return res.status(400).json({ success: false, message: 'Invalid period. Use: 1d, 7d, 30d, 90d' });

    const startDate = new Date(Date.now() - periodMs[period]);
    let totalStatuses = 0, activeStatuses = 0, totalLikes = 0, totalViews = 0, totalComments = 0;

    if (Status) {
        [totalStatuses, activeStatuses] = await Promise.all([
            Status.count({ where: { userId, createdAt: { [Op.gte]: startDate } } }).catch(() => 0),
            Status.count({ where: { userId, isActive: true, ...activeWhere() } }).catch(() => 0),
        ]);

        const stats = await Status.findAll({
            where: { userId, createdAt: { [Op.gte]: startDate } },
            attributes: [
                [Sequelize.fn('SUM', Sequelize.col('likeCount')), 'tl'],
                [Sequelize.fn('SUM', Sequelize.col('viewCount')), 'tv'],
                [Sequelize.fn('SUM', Sequelize.col('commentCount')), 'tc'],
            ],
        }).catch(() => []);

        if (stats[0]) {
            totalLikes = parseInt(stats[0].dataValues.tl) || 0;
            totalViews = parseInt(stats[0].dataValues.tv) || 0;
            totalComments = parseInt(stats[0].dataValues.tc) || 0;
        }
    }

    res.json({
        success: true,
        data: {
            period,
            totalStatuses,
            activeStatuses,
            totalLikes,
            totalViews,
            totalComments,
            engagementRate: totalStatuses > 0 ? (((totalLikes + totalComments) / totalStatuses)).toFixed(2) : 0,
        }
    });
}));

// ============================================================================
// PARAMETERIZED PATH ROUTES (with individual auth where needed)
// ============================================================================

// ── Single status (public read for active/public statuses)
router.get('/:statusId', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;

    // Validate statusId is a number
    if (isNaN(+statusId)) {
        return res.status(400).json({ success: false, message: 'Invalid status ID' });
    }

    const userId = getUserId(req);

    let status = null;
    if (Status) {
        status = await Status.findOne({ where: { id: statusId }, include: userInclude() }).catch(() => null);
    }
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    const isOwner = userId && Number(status.userId) === Number(userId);
    const isExpired = status.expiresAt && new Date(status.expiresAt) < new Date();

    if (!(await canUserViewStatus(status, userId))) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (isExpired) {
        return res.status(410).json({ success: false, message: 'Status has expired' });
    }

    if (!isOwner && userId) {
        await recordStatusView(req, status, userId);
    }

    res.json({ success: true, data: { status: formatStatus(status) } });
}));

// ── Update status (PROTECTED)
router.get('/:statusId/viewers', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const ownerId = getUserId(req);
    const { statusId } = req.params;

    if (!statusId || isNaN(+statusId)) {
        return res.status(400).json({ success: false, message: 'Invalid status ID' });
    }

    const status = await Status?.findByPk(statusId).catch(() => null);
    if (!status) {
        return res.status(404).json({ success: false, message: 'Status not found' });
    }
    if (Number(status.userId) !== Number(ownerId)) {
        return res.status(403).json({ success: false, message: 'Only the creator can view viewers' });
    }

    const viewerRows = StatusView ? await StatusView.findAll({
        where: { statusId: Number(statusId) },
        include: User ? [{
            model: User,
            as: 'viewerUser',
            required: false,
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
        }] : [],
        order: [['viewedAt', 'DESC']],
    }).catch(() => []) : [];

    const replyRows = StatusReply ? await StatusReply.findAll({
        where: { statusId: Number(statusId) },
        attributes: ['senderId'],
    }).catch(() => []) : [];

    const reactionRows = StatusReaction ? await StatusReaction.findAll({
        where: { statusId: Number(statusId) },
        attributes: ['userId', 'emoji'],
    }).catch(() => []) : [];

    const replyCounts = new Map();
    replyRows.forEach((reply) => {
        const key = Number(reply.senderId);
        replyCounts.set(key, (replyCounts.get(key) || 0) + 1);
    });

    const reactionMap = new Map();
    reactionRows.forEach((reaction) => {
        reactionMap.set(Number(reaction.userId), reaction.emoji);
    });

    const viewers = viewerRows.map((row) => ({
        id: row.id,
        statusId: Number(row.statusId),
        viewerId: Number(row.userId),
        viewedAt: row.viewedAt,
        reaction: reactionMap.get(Number(row.userId)) || null,
        replyCount: replyCounts.get(Number(row.userId)) || 0,
        viewer: formatUser(row.viewerUser),
    }));

    res.json({
        success: true,
        data: {
            statusId: Number(statusId),
            totalViews: viewers.length,
            viewers,
        }
    });
}));

router.put('/:statusId', authenticateToken, [
    body('content').optional().isLength({ max: 500 }).withMessage('Content too long'),
    body('isPublic').optional().isBoolean(),
    body('privacy').optional().isString(),
], apiRateLimiter, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = getUserId(req);
    const { statusId } = req.params;
    
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    let status = null;
    if (Status) {
        status = await Status.findOne({ where: { id: statusId, userId } }).catch(() => null);
    }
    if (!status) return res.status(404).json({ success: false, message: 'Status not found or you do not own it' });

    const { content, isPublic, privacy, metadata } = req.body;
    const updates = {};
    if (content !== undefined) updates.content = content;
    if (isPublic !== undefined) updates.isPublic = isPublic;
    if (privacy !== undefined) updates.privacy = normalizePrivacy(privacy, isPublic ?? status.isPublic);
    if (metadata && typeof metadata === 'object') {
        updates.metadata = { ...getStatusMetadata(status), ...metadata };
    }
    updates.updatedAt = new Date();

    await status.update(updates).catch(() => { });

    const refreshed = Status ? await Status.findOne({
        where: { id: statusId },
        include: userInclude(),
    }).catch(() => status) : status;

    await emitStatusEvent(req, 'status:updated', refreshed, {
        updates: {
            content: refreshed.content,
            isPublic: refreshed.isPublic,
            privacy: refreshed.privacy,
            metadata: refreshed.metadata,
            updatedAt: refreshed.updatedAt,
        }
    });

    res.json({ success: true, data: { status: formatStatus(refreshed) }, message: 'Status updated successfully' });
}));

// ── Delete status (PROTECTED)
router.delete('/:statusId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    const status = await Status?.findOne({ where: { id: statusId, userId } }).catch(() => null);
    let deleted = false;
    if (Status) {
        deleted = await Status.destroy({ where: { id: statusId, userId } }).then(n => n > 0).catch(() => false);
    }
    if (!deleted) return res.status(404).json({ success: false, message: 'Status not found or you do not own it' });

    if (status) {
        await emitStatusEvent(req, 'status:deleted', status, {
            statusId: Number(statusId),
            deleted: true,
        });
        await emitStatusEvent(req, 'status_deleted', status, {
            statusId: Number(statusId),
            deleted: true,
        });
    }

    res.json({ success: true, message: 'Status deleted successfully' });
}));

// ── Like a status (PROTECTED)
router.post('/:statusId/like', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    let alreadyLiked = false;
    if (StatusLike) {
        const existing = await StatusLike.findOne({ where: { statusId, userId } }).catch(() => null);
        alreadyLiked = !!existing;
        if (!alreadyLiked) {
            await StatusLike.create({ statusId: +statusId, userId, createdAt: new Date() }).catch(() => { });
            await Status.update({ likeCount: (status.likeCount || 0) + 1 }, { where: { id: statusId } });
            status.likeCount = (status.likeCount || 0) + 1;
        }
    } else {
        await Status.update({ likeCount: (status.likeCount || 0) + 1 }, { where: { id: statusId } });
        status.likeCount = (status.likeCount || 0) + 1;
    }

    if (req.io) req.io.emit('status:liked', { statusId, userId, timestamp: new Date() });
    res.json({
        success: true,
        data: { liked: !alreadyLiked, likeCount: status.likeCount },
        message: alreadyLiked ? 'Already liked' : 'Status liked successfully'
    });
}));

// ── Unlike a status (PROTECTED)
router.delete('/:statusId/like', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    let wasLiked = false;
    if (StatusLike) {
        const like = await StatusLike.findOne({ where: { statusId, userId } }).catch(() => null);
        wasLiked = !!like;
        if (like) {
            await like.destroy();
            await Status.update({ likeCount: Math.max(0, (status.likeCount || 0) - 1) }, { where: { id: statusId } });
            status.likeCount = Math.max(0, (status.likeCount || 0) - 1);
        }
    }

    if (req.io) req.io.emit('status:unliked', { statusId, userId, timestamp: new Date() });
    res.json({
        success: true,
        data: { liked: false, likeCount: status.likeCount },
        message: wasLiked ? 'Status unliked' : 'Status was not liked'
    });
}));

// ── Record view (public - anyone can record a view)
const _recordView = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = req.params.statusId || req.body.statusId;
    
    if (!statusId || isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.json({ success: true, data: { viewed: false, viewCount: 0 } });

    const status = await Status.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
    if (!(await canUserViewStatus(status, userId))) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (status.expiresAt && new Date(status.expiresAt) < new Date()) {
        return res.status(410).json({ success: false, message: 'Status has expired' });
    }
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required to record a view' });
    }

    const { alreadyViewed, viewCount } = await recordStatusView(req, status, userId);

    res.json({
        success: true,
        data: { viewed: !alreadyViewed, viewCount },
        message: alreadyViewed ? 'View already recorded' : 'View recorded'
    });
});

router.post('/view', optionalAuthenticateToken, apiRateLimiter, _recordView);
router.post('/:statusId/view', optionalAuthenticateToken, apiRateLimiter, _recordView);

// ── Comment on a status (PROTECTED)
router.post('/:statusId/comment', authenticateToken, [
    body('content').notEmpty().withMessage('Comment required').isLength({ max: 500 }).withMessage('Too long'),
], apiRateLimiter, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = getUserId(req);
    const { statusId } = req.params;
    
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    const { content } = req.body;
    let comment = null;
    if (StatusComment) {
        comment = await StatusComment.create({ statusId: +statusId, userId, content, createdAt: new Date() });
    } else {
        comment = { id: Date.now(), statusId: +statusId, userId, content, createdAt: new Date() };
    }
    await Status.update({ commentCount: (status.commentCount || 0) + 1 }, { where: { id: statusId } });

    const userObj = User ? await User.findByPk(userId, { attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'] }).catch(() => null) : null;

    if (req.io) req.io.emit('status:commented', { statusId, commentId: comment.id, userId, timestamp: new Date() });
    res.status(201).json({
        success: true,
        data: { comment: { ...(comment.toJSON?.() || comment), user: userObj ? formatUser(userObj) : null } },
        message: 'Comment added'
    });
}));

// ── Delete comment (PROTECTED)
router.delete('/:statusId/comment/:commentId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId, commentId } = req.params;
    
    if (isNaN(+statusId) || isNaN(+commentId)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    if (!StatusComment) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const comment = await StatusComment.findOne({ where: { id: commentId, statusId } }).catch(() => null);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    if (comment.userId !== userId) return res.status(403).json({ success: false, message: 'Not your comment' });

    await comment.destroy();
    if (Status) {
        const status = await Status.findByPk(statusId).catch(() => null);
        if (status) await Status.update({ commentCount: Math.max(0, (status.commentCount || 0) - 1) }, { where: { id: statusId } });
    }

    if (req.io) req.io.emit('status:comment:deleted', { statusId, commentId, userId, timestamp: new Date() });
    res.json({ success: true, message: 'Comment deleted' });
}));

// ── Emoji Reaction (PROTECTED)  POST /:statusId/react  { emoji: "🔥" }
router.post('/:statusId/react', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    const { emoji } = req.body;

    if (!statusId || isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });
    if (!emoji || !emoji.trim()) return res.status(400).json({ success: false, message: 'emoji is required' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
    if (!(await canUserViewStatus(status, userId))) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Check expired
    if (status.expiresAt && new Date(status.expiresAt) < new Date()) {
        return res.status(410).json({ success: false, message: 'Status has expired' });
    }
    let reactionCount = 0;

    if (StatusReaction) {
        // One reaction per user per status — remove old, insert new
        await StatusReaction.destroy({ where: { statusId: +statusId, userId } }).catch(() => {});
        await StatusReaction.create({ statusId: +statusId, userId, emoji: emoji.trim(), createdAt: new Date() }).catch(() => {});
        reactionCount = await StatusReaction.count({ where: { statusId: +statusId, emoji: emoji.trim() } }).catch(() => 0);
    } else {
        // Fallback: persist in metadata JSON
        const meta = status.metadata || {};
        const reactions = meta.reactions || {};
        // Remove any previous reaction by this user across all emojis
        for (const e of Object.keys(reactions)) {
            reactions[e] = reactions[e].filter(id => id !== userId);
            if (reactions[e].length === 0) delete reactions[e];
        }
        if (!reactions[emoji.trim()]) reactions[emoji.trim()] = [];
        reactions[emoji.trim()].push(userId);
        reactionCount = reactions[emoji.trim()].length;
        await status.update({ metadata: { ...meta, reactions } }).catch(() => {});
    }

    // Real-time: notify the status owner
    const io = getIO(req);
    const audience = await getAudienceUserIds(status, status.userId);
    emitToUsers(io, [...audience, userId], 'status:reaction', {
        statusId: +statusId,
        reactorId: userId,
        userId: Number(status.userId),
        emoji: emoji.trim(),
        count: reactionCount,
        timestamp: new Date().toISOString(),
    });

    res.json({ success: true, data: { emoji: emoji.trim(), count: reactionCount }, message: 'Reaction added' });
}));

// ── Remove Reaction (PROTECTED)  DELETE /:statusId/react
router.delete('/:statusId/react', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;

    if (!statusId || isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (StatusReaction) {
        await StatusReaction.destroy({ where: { statusId: +statusId, userId } }).catch(() => {});
    } else if (Status) {
        const status = await Status.findByPk(statusId).catch(() => null);
        if (status) {
            const meta = status.metadata || {};
            const reactions = meta.reactions || {};
            for (const e of Object.keys(reactions)) {
                reactions[e] = reactions[e].filter(id => id !== userId);
                if (reactions[e].length === 0) delete reactions[e];
            }
            await status.update({ metadata: { ...meta, reactions } }).catch(() => {});
        }
    }

    const status = await Status?.findByPk(statusId).catch(() => null);
    if (status) {
        const io = getIO(req);
        const audience = await getAudienceUserIds(status, status.userId);
        emitToUsers(io, [...audience, userId], 'status:reaction', {
            statusId: +statusId,
            reactorId: userId,
            userId: Number(status.userId),
            emoji: null,
            count: 0,
            removed: true,
            timestamp: new Date().toISOString(),
        });
    }

    res.json({ success: true, message: 'Reaction removed' });
}));

// ── Get Reactions (public)  GET /:statusId/reactions
router.get('/:statusId/reactions', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;
    if (!statusId || isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    const status = await Status?.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
    if (!(await canUserViewStatus(status, getUserId(req)))) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    let reactions = [];

    if (StatusReaction) {
        const rows = await StatusReaction.findAll({ where: { statusId: +statusId } }).catch(() => []);
        // Group by emoji
        const grouped = {};
        for (const r of rows) {
            const e = r.emoji;
            if (!grouped[e]) grouped[e] = { emoji: e, count: 0, users: [] };
            grouped[e].count++;
            grouped[e].users.push(r.userId);
        }
        reactions = Object.values(grouped);
    } else if (Status) {
        const status = await Status.findByPk(statusId, { attributes: ['metadata'] }).catch(() => null);
        const meta = status?.metadata || {};
        const reactionMap = meta.reactions || {};
        reactions = Object.entries(reactionMap).map(([emoji, users]) => ({ emoji, count: users.length, users }));
    }

    res.json({ success: true, data: { reactions } });
}));

// ── Reply to Status (PROTECTED)  POST /:statusId/reply  { content: "..." }
// Replies become chat messages — NOT stored as statuses
router.post('/:statusId/reply', authenticateToken, [
    body('content').notEmpty().withMessage('Reply content required').isLength({ max: 1000 }),
], apiRateLimiter, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const senderId = getUserId(req);
    const { statusId } = req.params;
    const { content } = req.body;

    if (!statusId || isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });
    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
    if (!(await canUserViewStatus(status, senderId))) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (!canReplyToStatus(status)) {
        return res.status(403).json({ success: false, message: 'Replies are disabled for this status' });
    }

    if (status.expiresAt && new Date(status.expiresAt) < new Date()) {
        return res.status(410).json({ success: false, message: 'Status has expired' });
    }

    const ownerId = status.userId;
    const statusPreview = JSON.stringify({
        id: status.id,
        content: (status.content || '').slice(0, 100),
        type: status.type || 'text',
        mediaUrl: status.mediaUrl || null,
    });

    // Find or create direct chat between sender and status owner
    const Chat     = db.Chat     || db.Chats     || db.Conversation || db.Conversations;
    const Message  = db.Message  || db.Messages  || db.ChatMessage  || db.ChatMessages;
    const ChatParticipant = db.ChatParticipant || db.ChatParticipants;

    if (!Message) return res.status(503).json({ success: false, message: 'Message service unavailable' });

    let chatId = null;
    if (Chat && ChatParticipant) {
        // Find a direct chat that has BOTH users as participants
        const { QueryTypes } = require('sequelize');
        const rawDb = db.sequelize;

        if (rawDb) {
            const rows = await rawDb.query(
                `SELECT c.id FROM "Chats" c
                 JOIN "ChatParticipants" cp1 ON cp1."chatId" = c.id AND cp1."userId" = :senderId
                 JOIN "ChatParticipants" cp2 ON cp2."chatId" = c.id AND cp2."userId" = :ownerId
                 WHERE c.type = 'direct' LIMIT 1`,
                { replacements: { senderId, ownerId }, type: QueryTypes.SELECT }
            ).catch(() => []);
            if (rows.length) chatId = rows[0].id;
        }

        if (!chatId) {
            const newChat = await Chat.create({
                type: 'direct', createdBy: senderId, isActive: true,
                createdAt: new Date(), updatedAt: new Date(),
            }).catch(() => null);
            if (newChat) {
                chatId = newChat.id;
                await ChatParticipant.bulkCreate([
                    { chatId, userId: senderId, joinedAt: new Date() },
                    { chatId, userId: ownerId,  joinedAt: new Date() },
                ]).catch(() => {});
            }
        }
    }

    const message = await Message.create({
        chatId,
        senderId,
        receiverId: ownerId,
        content: content.trim(),
        type: 'status_reply',
        replyToStatusId: +statusId,
        statusPreview,
        createdAt: new Date(),
        updatedAt: new Date(),
    }).catch(e => { throw Object.assign(new Error('Failed to save reply: ' + e.message), { statusCode: 500 }); });

    if (StatusReply) {
        await StatusReply.create({
            statusId: +statusId,
            senderId,
            receiverId: ownerId,
            messageId: message.id || null,
            content: content.trim(),
            createdAt: new Date(),
            updatedAt: new Date(),
        }).catch(() => {});
    }

    // Real-time: deliver to owner via socket
    const io = getIO(req);
    if (io) {
        const payload = {
            statusId: Number(statusId),
            message: message.toJSON ? message.toJSON() : message,
            chatId,
            type: 'status_reply',
            senderId,
            userId: Number(ownerId),
            statusPreview: JSON.parse(statusPreview),
            timestamp: new Date().toISOString(),
        };
        io.to(`user:${ownerId}`).emit('new_message',    payload);
        io.to(`user:${ownerId}`).emit('status:reply',   payload);
        io.to(`user:${senderId}`).emit('new_message',   payload); // sender's other tabs
        io.to(`user:${senderId}`).emit('status:reply',  payload);
    }

    res.status(201).json({
        success: true,
        message: 'Reply sent',
        data: {
            message: message.toJSON ? message.toJSON() : message,
            chatId,
            statusPreview: JSON.parse(statusPreview),
        }
    });
}));

module.exports = router;
