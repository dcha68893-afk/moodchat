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
// Reuse the lastSeen privacy enforcement built in users.js (see that file
// for _applyLastSeenPrivacy) instead of duplicating it here.
const applyLastSeenPrivacy = require('./users').applyLastSeenPrivacy;
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { authenticateToken, optionalAuthenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
// Notification service for mention/like/comment/question-answer notifications
let notificationService;
try { notificationService = require('../services/notificationService'); } catch(_) { notificationService = null; }
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
    // FIX: StatusLike / StatusComment have no convenience getter on the
    // models/index.js export object (only Status, StatusView, StatusReaction,
    // and StatusReply do) — db.StatusLike / db.StatusComment were always
    // undefined here even though the model files exist. Must read them off
    // db.models directly, the same way friends.js resolves Friend/Group/etc.
    StatusLike = db.StatusLike || db.StatusLikes || db.models?.StatusLike || db.models?.StatusLikes;
    StatusComment = db.StatusComment || db.StatusComments || db.models?.StatusComment || db.models?.StatusComments;
    StatusView = db.StatusView || db.StatusViews;
    StatusReaction = db.StatusReaction || db.StatusReactions;
    StatusReply = db.StatusReply || db.StatusReplies;
    Message = db.Message || db.Messages;
    Friend = db.Friend || db.Friends;
    console.log('[Status Route] Models loaded - User:', !!User, 'Status:', !!Status, 'Friend:', !!Friend, 'StatusLike:', !!StatusLike, 'StatusComment:', !!StatusComment);
} catch (e) {
    console.error('[Status Route] Error loading models:', e.message);
}

const Sequelize = require('sequelize');
const { Op } = Sequelize;

console.log('✅ Status routes initialized (v6.2 - added /scheduled route)');

// ===== GLOBAL SOCKET.IO INJECTION (FIX) =====
// Same fix applied to friends.js / chats.js / messages.js: req.io was never
// injected here, so any handler that emits real-time status events (likes,
// comments, new-status-from-friend) via req.io silently no-op'd.
router.use((req, _res, next) => {
    if (!req.io) req.io = global.__socketIO || null;
    next();
});

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
        isPinned: d.isPinned || false,
        isHighlight: d.isHighlight || false,
        altText: d.altText || null,
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

const VALID_TYPES = ['text', 'image', 'video', 'audio', 'mood', 'location', 'poll', 'question'];
const VALID_MOODS = ['happy', 'sad', 'angry', 'excited', 'calm', 'anxious', 'tired', 'energetic',
    'focused', 'relaxed', 'nostalgic', 'romantic', 'lonely', 'confused', 'proud',
    'grateful', 'hopeful', 'bored', 'sick', 'neutral'];
const VALID_PRIVACY = ['public', 'everyone', 'friends', 'close-friends', 'private', 'except', 'specific', 'micro-circle'];

const userInclude = () => User ? [{
    model: User,
    as: 'statusUser',
    required: false,
    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'settings'],
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
            // P2 FIX: pinned statuses first, then by recency
            order: [['isPinned', 'DESC'], ['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
        const site1Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site1Users.length) await applyLastSeenPrivacy(site1Users, getUserId(req));
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
    const { limit = 20, offset = 0, ranked } = req.query;
    const where = { isPublic: true, ...activeWhere() };

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            // P3 FIX: algorithm ranking when ?ranked=1
            // Score = viewCount*1 + likeCount*3 + commentCount*5 + shareCount*2
            // Decay: penalise posts older than 6h (simulated by secondary sort)
            order: ranked
                ? [['likeCount', 'DESC'], ['commentCount', 'DESC'], ['viewCount', 'DESC'], ['createdAt', 'DESC']]
                : [['isPinned', 'DESC'], ['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
        const site2Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site2Users.length) await applyLastSeenPrivacy(site2Users, getUserId(req));

        // P3 FIX: In-memory weighted score + recency decay for ranked feed
        if (ranked && rows.length > 1) {
            const now = Date.now();
            rows = rows.map(s => {
                const ageMs = now - new Date(s.createdAt).getTime();
                const ageHours = ageMs / 3600000;
                const decayFactor = Math.max(0.1, 1 - ageHours / 72); // decay over 72h
                const score = ((s.viewCount || 0) * 1 + (s.likeCount || 0) * 3 + (s.commentCount || 0) * 5 + (s.shareCount || 0) * 2) * decayFactor;
                return { _score: score, status: s };
            }).sort((a, b) => b._score - a._score).map(x => x.status);
        }
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
        const site3Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site3Users.length) await applyLastSeenPrivacy(site3Users, getUserId(req));
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
        const site4Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site4Users.length) await applyLastSeenPrivacy(site4Users, getUserId(req));
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
        const site5Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site5Users.length) await applyLastSeenPrivacy(site5Users, getUserId(req));
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

// ── Multer upload for status media (image / video / audio) ─────────────────
let multer;
try { multer = require('multer'); } catch(_) { multer = null; }
const cloudinaryService = require('../services/cloudinaryService');
const _statusCloudinaryEnabled = cloudinaryService.isConfigured();

const statusMediaStorage = multer ? (
    _statusCloudinaryEnabled
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = process.env.UPLOAD_DIR || './uploads';
            const sub = file.mimetype.startsWith('image/') ? 'images' :
                        file.mimetype.startsWith('video/') ? 'videos' : 'audio';
            const nodePath = require('path');
            const fs = require('fs');
            const dest = nodePath.join(dir, sub);
            fs.mkdirSync(dest, { recursive: true });
            cb(null, dest);
        },
        filename: (req, file, cb) => {
            const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            const ext = file.originalname.split('.').pop();
            cb(null, 'status-' + suffix + '.' + ext);
        },
    })
) : null;
if (_statusCloudinaryEnabled) {
    console.log('✅ Status media storage: Cloudinary (persistent CDN)');
}

const ALLOWED_STATUS_MIMES = new Set([
    'image/jpeg','image/jpg','image/png','image/gif','image/webp',
    'video/mp4','video/webm','video/quicktime',
    'audio/mpeg','audio/mp3','audio/ogg','audio/wav','audio/webm','audio/aac',
]);

const statusUpload = multer ? multer({
    storage: statusMediaStorage,
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_STATUS_MIMES.has(file.mimetype)) cb(null, true);
        else cb(Object.assign(new Error('File type not allowed: ' + file.mimetype), { status: 415 }), false);
    },
}) : null;

async function resolveUploadedFileUrl(req, file) {
    if (!file) return null;
    if (_statusCloudinaryEnabled) {
        const folder = file.mimetype.startsWith('image/') ? 'nexopa/status/images' :
                       file.mimetype.startsWith('video/') ? 'nexopa/status/videos' : 'nexopa/status/audio';
        const result = await cloudinaryService.uploadToCloudinary(file.buffer, { folder });
        if (!result) throw new Error('Cloudinary upload failed');
        return result.url;
    }
    if (file.location) return file.location; // S3/Cloudinary storage engines
    return req.protocol + '://' + req.get('host') + '/' + file.path.replace(/\\/g, '/');
}

// ── Create status (PROTECTED)
router.post(
    '/',
    authenticateToken,
    ...(statusUpload ? [
        (req, res, next) => statusUpload.single('media')(req, res, (err) => {
            if (err) return res.status(err.status || 400).json({ success: false, message: err.message });
            next();
        }),
    ] : []),
    [
        body('content').optional().isLength({ max: 2000 }).withMessage('Content too long'),
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

        // P1 FIX: resolve uploaded file → mediaUrl (multipart upload support)
        const uploadedFileUrl = req.file ? await resolveUploadedFileUrl(req, req.file) : null;
        const resolvedMediaUrl = uploadedFileUrl || mediaUrl || null;
        const resolvedType = type || (req.file
            ? (req.file.mimetype.startsWith('image/') ? 'image'
               : req.file.mimetype.startsWith('video/') ? 'video' : 'audio')
            : 'text');

        const finalContent = content || text || '';
        if (!finalContent && resolvedType !== 'mood' && resolvedType !== 'location' && !resolvedMediaUrl) {
            return res.status(400).json({ success: false, message: 'Content or media is required' });
        }

        // P1 FIX: poll/question type handling
        const pollOptions = resolvedType === 'poll' && req.body.pollOptions
            ? (typeof req.body.pollOptions === 'string' ? JSON.parse(req.body.pollOptions) : req.body.pollOptions)
                .slice(0, 4).map((opt, i) => ({ id: i + 1, text: String(opt).trim(), votes: 0 }))
            : null;
        if (resolvedType === 'poll' && (!pollOptions || pollOptions.length < 2)) {
            return res.status(400).json({ success: false, message: 'Poll requires 2–4 options' });
        }
        const questionText = resolvedType === 'question' ? (req.body.questionText || finalContent) : null;

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
            type: resolvedType,
            moodType: moodType || null,
            mediaUrl: resolvedMediaUrl,
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
                ...(pollOptions ? { pollOptions } : {}),
                ...(questionText ? { questionText, answers: [] } : {}),
                ...(req.body.mentions ? { mentions: req.body.mentions } : {}),
                ...(req.body.altText ? { altText: String(req.body.altText).trim() } : {}),
                ...(req.body.linkUrl ? { linkUrl: String(req.body.linkUrl).trim(), linkLabel: String(req.body.linkLabel || 'Visit').trim() } : {}),
                ...(req.body.countdown ? { countdown: { targetDate: req.body.countdown, label: req.body.countdownLabel || '' } } : {}),
                ...(req.body.hashtags ? (() => {
                    // Multipart/form-data uploads (createStatusWithFile) send this as a
                    // JSON-stringified array; regular JSON POSTs send a real array.
                    let raw = req.body.hashtags;
                    if (typeof raw === 'string') {
                        try { raw = JSON.parse(raw); } catch (_) { raw = [raw]; }
                    }
                    const list = (Array.isArray(raw) ? raw : [raw])
                        .filter(h => typeof h === 'string' && h.trim())
                        .map(h => h.replace(/^#/, '').trim().toLowerCase())
                        .slice(0, 10);
                    return list.length > 0 ? { hashtags: list } : {};
                })() : {}),
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

        if (req.io) {
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
            // FIX: Single canonical 'status:new' event
            io.to(`user:${userId}`).emit('status:new', wsPayload);

            // Emit to each accepted friend's room asynchronously (non-blocking)
            const { getAcceptedFriendIds } = require('../services/statusService');
            getAcceptedFriendIds(userId).then(friendIds => {
                friendIds.forEach(fid => {
                    try {
                        // FIX: Single canonical 'status:new' event per friend
                        io.to(`user:${fid}`).emit('status:new', wsPayload);
                    } catch (_) {}
                });
                logger.info(`[status.js] 📡 status:created emitted to ${friendIds.length} friend rooms for userId=${userId}`);
            }).catch(err => {
                logger.warn(`[status.js] getAcceptedFriendIds failed, falling back to scoped emit: ${err.message}`);
                // Fallback: still emit to own room at minimum
            });
        }

        await emitStatusEvent(req, 'status:new', created, {
            type: created.type,
            content: created.content,
            mediaUrl: created.mediaUrl || null,
            createdAt: created.createdAt,
            expiresAt: created.expiresAt || null,
        });

        // P2 FIX: Send mention notifications to @mentioned users
        (async () => {
            try {
                const meta = created.metadata || {};
                const mentions = meta.mentions;
                if (!mentions || !Array.isArray(mentions) || !notificationService) return;
                const { Users } = db || {};
                let posterName = 'Someone';
                if (Users) {
                    const poster = await Users.findByPk(userId, { attributes: ['displayName', 'username'] }).catch(() => null);
                    posterName = poster ? (poster.displayName || poster.username || 'Someone') : 'Someone';
                }
                for (const m of mentions) {
                    const mentionedId = typeof m === 'object' ? (m.userId || m.id) : m;
                    if (!mentionedId || String(mentionedId) === String(userId)) continue;
                    notificationService.createFromTemplate(mentionedId, 'status_mention', {
                        mentionerName: posterName,
                        statusId: created.id,
                    }).catch(() => {});
                }
            } catch(_) {}
        })();

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

    // P1 FIX: Filter muted users server-side using user_status_mutes table
    let mutedUserIds = [];
    try {
        const { sequelize: seq } = db || {};
        if (seq) {
            const mutedRows = await seq.query(
                `SELECT muted_user_id FROM user_status_mutes WHERE user_id = :userId`,
                { replacements: { userId }, type: 'SELECT' }
            ).catch(() => []);
            mutedUserIds = mutedRows.map(r => r.muted_user_id);
        }
    } catch (_) {}

    const filteredUserIds = visibleUserIds.filter(id => !mutedUserIds.includes(id));

    const where = { userId: { [Op.in]: filteredUserIds }, ...activeWhere() };
    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where,
            include: userInclude(),
            order: [['isPinned', 'DESC'], ['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows;
        total = r.count;
        const site6Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site6Users.length) await applyLastSeenPrivacy(site6Users, userId);
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
// ── Draft helpers (create-on-demand table) ─────────────────────────────────
async function ensureDraftTable(seq) {
    await seq.query(`CREATE TABLE IF NOT EXISTS status_drafts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        content TEXT,
        type VARCHAR(30) DEFAULT 'text',
        media_url VARCHAR(1000),
        mood_type VARCHAR(50),
        location VARCHAR(255),
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        is_public BOOLEAN DEFAULT false,
        privacy VARCHAR(30) DEFAULT 'friends',
        metadata JSONB DEFAULT '{}',
        saved_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
}

// GET /drafts — list from dedicated status_drafts table
router.get('/drafts', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { limit = 50, offset = 0 } = req.query;
    const { sequelize: seq } = db || {};

    // P2 FIX: Use dedicated status_drafts table
    if (seq) {
        await ensureDraftTable(seq);
        const rows = await seq.query(
            `SELECT * FROM status_drafts WHERE user_id = :userId ORDER BY saved_at DESC LIMIT :limit OFFSET :offset`,
            { replacements: { userId, limit: Math.min(+limit, 100), offset: +offset }, type: 'SELECT' }
        ).catch(() => []);
        const total = await seq.query(
            `SELECT COUNT(*) AS cnt FROM status_drafts WHERE user_id = :userId`,
            { replacements: { userId }, type: 'SELECT' }
        ).then(r => parseInt(r[0]?.cnt || 0, 10)).catch(() => 0);

        const formatted = rows.map(d => ({
            id: d.id,
            userId: d.user_id,
            content: d.content,
            type: d.type,
            mediaUrl: d.media_url,
            moodType: d.mood_type,
            location: d.location,
            latitude: d.latitude,
            longitude: d.longitude,
            isPublic: d.is_public,
            privacy: d.privacy,
            metadata: d.metadata || {},
            savedAt: d.saved_at,
            isDraft: true,
        }));
        return res.json({ success: true, data: { drafts: formatted, total, pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total } } });
    }

    // Fallback: old isActive=false query
    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where: { userId, isActive: false },
            include: userInclude(),
            order: [['createdAt', 'DESC']],
            limit: Math.min(+limit, 100),
            offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }
    res.json({ success: true, data: { drafts: rows.map(formatStatus), total, pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total } } });
}));

// POST /drafts — save to dedicated drafts table
router.post('/drafts', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { content, type, mediaUrl, moodType, location, latitude, longitude, isPublic, privacy, metadata } = req.body;
    const { sequelize: seq } = db || {};
    if (!seq) return res.status(503).json({ success: false, message: 'DB unavailable' });

    await ensureDraftTable(seq);
    const [rows] = await seq.query(
        `INSERT INTO status_drafts (user_id, content, type, media_url, mood_type, location, latitude, longitude, is_public, privacy, metadata, saved_at, updated_at)
         VALUES (:userId, :content, :type, :mediaUrl, :moodType, :location, :latitude, :longitude, :isPublic, :privacy, :metadata, NOW(), NOW()) RETURNING *`,
        { replacements: {
            userId,
            content: content || '',
            type: type || 'text',
            mediaUrl: mediaUrl || null,
            moodType: moodType || null,
            location: location || null,
            latitude: latitude || null,
            longitude: longitude || null,
            isPublic: isPublic || false,
            privacy: privacy || 'friends',
            metadata: JSON.stringify(metadata || {}),
        }}
    ).catch(() => [[null]]);

    res.status(201).json({ success: true, data: { draft: rows ? rows[0] : null }, message: 'Draft saved' });
}));

// PUT /drafts/:draftId — update draft
router.put('/drafts/:draftId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const draftId = parseInt(req.params.draftId, 10);
    const { content, type, mediaUrl, moodType, metadata } = req.body;
    const { sequelize: seq } = db || {};
    if (!seq) return res.status(503).json({ success: false, message: 'DB unavailable' });

    await ensureDraftTable(seq);
    await seq.query(
        `UPDATE status_drafts SET content = COALESCE(:content, content), type = COALESCE(:type, type),
         media_url = COALESCE(:mediaUrl, media_url), mood_type = COALESCE(:moodType, mood_type),
         metadata = COALESCE(:metadata, metadata), updated_at = NOW()
         WHERE id = :draftId AND user_id = :userId`,
        { replacements: { draftId, userId, content: content || null, type: type || null, mediaUrl: mediaUrl || null, moodType: moodType || null, metadata: metadata ? JSON.stringify(metadata) : null } }
    ).catch(() => {});

    res.json({ success: true, message: 'Draft updated' });
}));

// DELETE /drafts/:draftId — delete draft
router.delete('/drafts/:draftId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const draftId = parseInt(req.params.draftId, 10);
    const { sequelize: seq } = db || {};
    if (seq) {
        await ensureDraftTable(seq);
        await seq.query(`DELETE FROM status_drafts WHERE id = :draftId AND user_id = :userId`, { replacements: { draftId, userId } }).catch(() => {});
    }
    res.json({ success: true, message: 'Draft deleted' });
}));

// POST /drafts/:draftId/publish — move draft to live status
router.post('/drafts/:draftId/publish', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const draftId = parseInt(req.params.draftId, 10);
    const { sequelize: seq } = db || {};
    if (!seq) return res.status(503).json({ success: false, message: 'DB unavailable' });

    await ensureDraftTable(seq);
    const drafts = await seq.query(
        `SELECT * FROM status_drafts WHERE id = :draftId AND user_id = :userId`,
        { replacements: { draftId, userId }, type: 'SELECT' }
    ).catch(() => []);

    if (!drafts || !drafts.length) return res.status(404).json({ success: false, message: 'Draft not found' });
    const d = drafts[0];
    const meta = typeof d.metadata === 'string' ? JSON.parse(d.metadata) : (d.metadata || {});

    if (!Status) return res.status(503).json({ success: false, message: 'Status model unavailable' });
    const created = await Status.create({
        userId,
        content: d.content || '',
        type: d.type || 'text',
        mediaUrl: d.media_url || null,
        moodType: d.mood_type || null,
        location: d.location || null,
        latitude: d.latitude || null,
        longitude: d.longitude || null,
        isPublic: d.is_public || false,
        privacy: d.privacy || 'friends',
        isActive: true,
        metadata: meta,
        expiresAt: new Date(Date.now() + 86400 * 1000),
    });

    // Delete draft after publish
    await seq.query(`DELETE FROM status_drafts WHERE id = :draftId`, { replacements: { draftId } }).catch(() => {});

    // Emit status:new
    await emitStatusEvent(req, 'status:new', created, { type: created.type }).catch(() => {});

    res.status(201).json({ success: true, data: { status: formatStatus(created) }, message: 'Draft published' });
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
        const site7Users = rows.map(s => s.statusUser).filter(Boolean);
        if (site7Users.length) await applyLastSeenPrivacy(site7Users, viewerId);
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
    if (status.statusUser) await applyLastSeenPrivacy(status.statusUser, userId);

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
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'settings'],
        }] : [],
        order: [['viewedAt', 'DESC']],
    }).catch(() => []) : [];

    const site9Users = viewerRows.map(r => r.viewerUser).filter(Boolean);
    if (site9Users.length) await applyLastSeenPrivacy(site9Users, ownerId);

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
        // FIX: status:deleted already emitted above — duplicate removed
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

    // P2 FIX: like notification to status owner (async, non-blocking)
    if (!alreadyLiked && notificationService && String(status.userId) !== String(userId)) {
        (async () => {
            try {
                const { Users } = db || {};
                const liker = Users ? await Users.findByPk(userId, { attributes: ['displayName','username'] }).catch(()=>null) : null;
                const likerName = liker ? (liker.displayName || liker.username || 'Someone') : 'Someone';
                notificationService.createFromTemplate(status.userId, 'status_like', {
                    likerName, statusId: +statusId,
                }).catch(() => {});
            } catch(_) {}
        })();
    }

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

    // P2 FIX: comment notification to status owner (async, non-blocking)
    if (notificationService && String(status.userId) !== String(userId)) {
        (async () => {
            try {
                const commenterName = userObj ? (userObj.displayName || userObj.username || 'Someone') : 'Someone';
                notificationService.createFromTemplate(status.userId, 'status_comment', {
                    commenterName, statusId: +statusId,
                }).catch(() => {});
            } catch(_) {}
        })();
    }

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

    // Find or create direct chat between sender and status owner.
    //
    // ROOT-CAUSE FIX (status-reply-message-invisible): this used to be a
    // third, independent, UNLOCKED find-or-create-direct-chat — no
    // pg_advisory_xact_lock, so two near-simultaneous status replies (or a
    // status reply racing an ordinary message send) between the same pair
    // could each pass the "does a chat exist?" check before either
    // committed, creating two separate direct-chat rows for the same
    // pair. Each user's later messages then bind to whichever row their
    // own client resolved — so a status reply from one side could land in
    // a chat row the other side's app never looks at, while their push
    // notification (which targets the user directly, not a chat row)
    // still fires normally. Delegate to the same locked, type:'direct'
    // resolver POST /messages and the call flow now use.
    const Message = db.Message || db.Messages || db.ChatMessage || db.ChatMessages;
    if (!Message) return res.status(503).json({ success: false, message: 'Message service unavailable' });

    const messageDeliveryService = require('../services/messageDeliveryService');
    let chatId = null;
    try {
        chatId = await messageDeliveryService.resolveOrCreateDirectChat(senderId, ownerId);
    } catch (resolveErr) {
        return res.status(400).json({ success: false, message: resolveErr.message || 'Could not resolve conversation' });
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

// ═══════════════════════════════════════════════════════════════════
// P1 FIX: Server-persisted mute/unmute for status users
// ═══════════════════════════════════════════════════════════════════
router.post('/mute/:userId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const viewerId = getUserId(req);
    const targetId = parseInt(req.params.userId, 10);
    if (!viewerId || !targetId) return res.status(400).json({ success: false, message: 'Invalid user' });

    // Store in user_settings JSONB via Settings model or fallback to metadata on a ghost record
    const { sequelize: seq } = db || {};
    if (seq) {
        await seq.query(
            `INSERT INTO user_status_mutes (user_id, muted_user_id, created_at)
             VALUES (:viewerId, :targetId, NOW())
             ON CONFLICT (user_id, muted_user_id) DO NOTHING`,
            { replacements: { viewerId, targetId } }
        ).catch(async () => {
            // Table may not exist — create it on first use
            await seq.query(`CREATE TABLE IF NOT EXISTS user_status_mutes (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                muted_user_id INTEGER NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, muted_user_id)
            )`).catch(() => {});
            await seq.query(
                `INSERT INTO user_status_mutes (user_id, muted_user_id, created_at)
                 VALUES (:viewerId, :targetId, NOW()) ON CONFLICT DO NOTHING`,
                { replacements: { viewerId, targetId } }
            ).catch(() => {});
        });
    }
    res.json({ success: true, message: 'User muted from statuses' });
}));

router.delete('/mute/:userId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const viewerId = getUserId(req);
    const targetId = parseInt(req.params.userId, 10);
    const { sequelize: seq } = db || {};
    if (seq) {
        await seq.query(
            `DELETE FROM user_status_mutes WHERE user_id = :viewerId AND muted_user_id = :targetId`,
            { replacements: { viewerId, targetId } }
        ).catch(() => {});
    }
    res.json({ success: true, message: 'User unmuted from statuses' });
}));

router.get('/muted', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const viewerId = getUserId(req);
    const { sequelize: seq } = db || {};
    let mutedIds = [];
    if (seq) {
        const rows = await seq.query(
            `SELECT muted_user_id FROM user_status_mutes WHERE user_id = :viewerId`,
            { replacements: { viewerId }, type: 'SELECT' }
        ).catch(() => []);
        mutedIds = rows.map(r => r.muted_user_id);
    }
    res.json({ success: true, data: { mutedUserIds: mutedIds } });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Named Highlight Albums (create / list / add / remove)
// ═══════════════════════════════════════════════════════════════════
router.post('/highlights/albums', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { name, coverImage } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Album name is required' });
    const { sequelize: seq } = db || {};
    if (!seq) return res.status(503).json({ success: false, message: 'DB unavailable' });

    await seq.query(`CREATE TABLE IF NOT EXISTS status_highlight_albums (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name VARCHAR(100) NOT NULL,
        cover_image VARCHAR(500),
        status_ids INTEGER[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});

    const [rows] = await seq.query(
        `INSERT INTO status_highlight_albums (user_id, name, cover_image, created_at, updated_at)
         VALUES (:userId, :name, :coverImage, NOW(), NOW()) RETURNING *`,
        { replacements: { userId, name: name.trim(), coverImage: coverImage || null } }
    ).catch(() => [[null]]);
    res.status(201).json({ success: true, data: { album: rows ? rows[0] : null } });
}));

router.get('/highlights/albums', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { sequelize: seq } = db || {};
    if (!seq) return res.json({ success: true, data: { albums: [] } });
    const rows = await seq.query(
        `SELECT * FROM status_highlight_albums WHERE user_id = :userId ORDER BY created_at DESC`,
        { replacements: { userId }, type: 'SELECT' }
    ).catch(() => []);
    res.json({ success: true, data: { albums: rows } });
}));

router.post('/highlights/albums/:albumId/add', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const albumId = parseInt(req.params.albumId, 10);
    const { statusId } = req.body;
    if (!statusId) return res.status(400).json({ success: false, message: 'statusId required' });
    const { sequelize: seq } = db || {};
    if (!seq) return res.status(503).json({ success: false, message: 'DB unavailable' });

    await seq.query(
        `UPDATE status_highlight_albums SET status_ids = array_append(status_ids, :statusId), updated_at = NOW()
         WHERE id = :albumId AND user_id = :userId`,
        { replacements: { albumId, userId, statusId: parseInt(statusId, 10) } }
    ).catch(() => {});
    res.json({ success: true, message: 'Status added to album' });
}));

router.delete('/highlights/albums/:albumId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const albumId = parseInt(req.params.albumId, 10);
    const { sequelize: seq } = db || {};
    if (seq) await seq.query(
        `DELETE FROM status_highlight_albums WHERE id = :albumId AND user_id = :userId`,
        { replacements: { albumId, userId } }
    ).catch(() => {});
    res.json({ success: true, message: 'Album deleted' });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Share / Report / Pin / Unpin routes (missing from router)
// ═══════════════════════════════════════════════════════════════════
router.post('/:statusId/share', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { caption, privacy } = req.body;
    if (!statusId || !userId) return res.status(400).json({ success: false, message: 'Invalid request' });
    const { shareStatus } = require('../services/statusService');
    const shared = await shareStatus(statusId, userId, caption, privacy);
    res.status(201).json({ success: true, data: { status: formatStatus(shared) }, message: 'Status shared' });
}));

router.post('/:statusId/report', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { reason, description } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'reason is required' });
    const { reportStatus } = require('../services/statusService');
    const result = await reportStatus(statusId, userId, reason, description);
    res.json({ success: true, data: result, message: 'Status reported' });
}));

router.post('/:statusId/pin', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { pinStatus } = require('../services/statusService');
    const result = await pinStatus(statusId, userId);
    res.json({ success: true, data: result, message: 'Status pinned' });
}));

router.delete('/:statusId/pin', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { unpinStatus } = require('../services/statusService');
    const result = await unpinStatus(statusId, userId);
    res.json({ success: true, data: result, message: 'Status unpinned' });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Poll vote endpoint
// ═══════════════════════════════════════════════════════════════════
router.post('/:statusId/poll/vote', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { optionId } = req.body;
    if (!optionId) return res.status(400).json({ success: false, message: 'optionId is required' });

    if (!Status) return res.status(503).json({ success: false, message: 'Status unavailable' });
    const status = await Status.findOne({ where: { id: statusId, isActive: true } });
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
    if (status.type !== 'poll') return res.status(400).json({ success: false, message: 'Not a poll status' });

    const meta = status.metadata || {};
    const options = meta.pollOptions || [];
    const opt = options.find(o => o.id == optionId);
    if (!opt) return res.status(404).json({ success: false, message: 'Option not found' });

    // Prevent double-voting (track in metadata.pollVoters)
    const voters = meta.pollVoters || {};
    if (voters[userId]) {
        // Switch vote
        const prevOpt = options.find(o => o.id == voters[userId]);
        if (prevOpt) prevOpt.votes = Math.max(0, (prevOpt.votes || 0) - 1);
    }
    opt.votes = (opt.votes || 0) + 1;
    voters[userId] = optionId;

    await status.update({ metadata: { ...meta, pollOptions: options, pollVoters: voters } });
    await emitStatusEvent(req, 'status:poll_update', status, { pollOptions: options });

    res.json({ success: true, data: { pollOptions: options, yourVote: optionId } });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Question sticker answer endpoint
// ═══════════════════════════════════════════════════════════════════
router.post('/:statusId/question/answer', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, message: 'Answer text is required' });

    if (!Status) return res.status(503).json({ success: false, message: 'Status unavailable' });
    const status = await Status.findOne({ where: { id: statusId, isActive: true } });
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
    if (status.type !== 'question') return res.status(400).json({ success: false, message: 'Not a question status' });

    const meta = status.metadata || {};
    const answers = meta.answers || [];
    if (answers.some(a => a.userId === userId)) {
        return res.status(409).json({ success: false, message: 'Already answered' });
    }
    answers.push({ userId, text: text.trim(), answeredAt: new Date().toISOString() });
    await status.update({ metadata: { ...meta, answers } });

    // Notify creator + emit realtime event
    await emitStatusEvent(req, 'status:question_answer', status, { answer: { userId, text: text.trim() } });

    // P2 FIX: push notification to status owner
    if (notificationService && String(status.userId) !== String(userId)) {
        (async () => {
            try {
                const { Users } = db || {};
                const answerer = Users ? await Users.findByPk(userId, { attributes: ['displayName','username'] }).catch(()=>null) : null;
                const answererName = answerer ? (answerer.displayName || answerer.username || 'Someone') : 'Someone';
                notificationService.createFromTemplate(status.userId, 'status_question_answer', {
                    answererName, statusId: +statusId,
                }).catch(() => {});
            } catch(_) {}
        })();
    }

    res.status(201).json({ success: true, data: { answersCount: answers.length } });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Save / Bookmark status
// ═══════════════════════════════════════════════════════════════════
router.post('/:statusId/bookmark', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { sequelize: seq } = db || {};
    if (!seq) return res.status(503).json({ success: false, message: 'DB unavailable' });

    await seq.query(`CREATE TABLE IF NOT EXISTS status_bookmarks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        status_id INTEGER NOT NULL,
        saved_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, status_id)
    )`).catch(() => {});

    await seq.query(
        `INSERT INTO status_bookmarks (user_id, status_id, saved_at) VALUES (:userId, :statusId, NOW()) ON CONFLICT DO NOTHING`,
        { replacements: { userId, statusId } }
    ).catch(() => {});
    res.json({ success: true, message: 'Status bookmarked' });
}));

router.delete('/:statusId/bookmark', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    const { sequelize: seq } = db || {};
    if (seq) await seq.query(
        `DELETE FROM status_bookmarks WHERE user_id = :userId AND status_id = :statusId`,
        { replacements: { userId, statusId } }
    ).catch(() => {});
    res.json({ success: true, message: 'Bookmark removed' });
}));

router.get('/bookmarks', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { sequelize: seq } = db || {};
    if (!seq) return res.json({ success: true, data: { statuses: [] } });

    const rows = await seq.query(
        `SELECT sb.status_id, sb.saved_at FROM status_bookmarks sb WHERE sb.user_id = :userId ORDER BY sb.saved_at DESC LIMIT 50`,
        { replacements: { userId }, type: 'SELECT' }
    ).catch(() => []);
    const statusIds = rows.map(r => r.status_id);
    let statuses = [];
    if (Status && statusIds.length) {
        statuses = await Status.findAll({ where: { id: statusIds, isActive: true } }).catch(() => []);
    }
    res.json({ success: true, data: { statuses: statuses.map(formatStatus) } });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Action button click tracking
// ═══════════════════════════════════════════════════════════════════
router.post('/:statusId/action-click', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req) || 0;
    const statusId = parseInt(req.params.statusId, 10);
    const { buttonIndex, buttonLabel } = req.body;

    if (!Status) return res.json({ success: true });
    const status = await Status.findOne({ where: { id: statusId } });
    if (!status) return res.json({ success: true });

    const meta = status.metadata || {};
    const clicks = meta.actionClicks || [];
    clicks.push({ userId, buttonIndex, buttonLabel, clickedAt: new Date().toISOString() });
    await status.update({ metadata: { ...meta, actionClicks: clicks } }).catch(() => {});
    res.json({ success: true, data: { totalClicks: clicks.length } });
}));

// ═══════════════════════════════════════════════════════════════════
// P2: Hashtag feed
// ═══════════════════════════════════════════════════════════════════
router.get('/hashtag/:tag', apiRateLimiter, asyncHandler(async (req, res) => {
    const tag = req.params.tag.replace(/^#/, '').toLowerCase();
    const { Op } = require('sequelize');
    const now = new Date();
    const statuses = Status ? await Status.findAll({
        where: {
            isActive: true,
            isPublic: true,
            expiresAt: { [Op.gt]: now },
        },
        order: [['createdAt', 'DESC']],
        limit: 50,
    }).then(all => all.filter(s => {
        const meta = s.metadata || {};
        return (meta.hashtags || []).map(h => h.toLowerCase()).includes(tag);
    })).catch(() => []) : [];
    res.json({ success: true, data: { tag, statuses: statuses.map(formatStatus) } });
}));


// ═══════════════════════════════════════════════════════════════════
// P3 FIX: Story Templates — pre-designed status layouts
// ═══════════════════════════════════════════════════════════════════
const STATUS_TEMPLATES = [
    { id: 'birthday',       name: 'Birthday',      background: 'linear-gradient(135deg,#f9c74f,#f8961e)', textColor: '#fff', fontFamily: 'Pacifico, cursive',    icon: '🎂', tags: ['celebration'] },
    { id: 'announcement',   name: 'Announcement',  background: 'linear-gradient(135deg,#4cc9f0,#4361ee)', textColor: '#fff', fontFamily: 'Poppins, sans-serif',  icon: '📢', tags: ['news'] },
    { id: 'quote',          name: 'Quote',         background: 'linear-gradient(135deg,#2d3436,#636e72)', textColor: '#fff', fontFamily: 'Merriweather,serif',   icon: '💬', tags: ['inspiration'] },
    { id: 'motivation',     name: 'Motivation',    background: 'linear-gradient(135deg,#00b4d8,#023e8a)', textColor: '#fff', fontFamily: 'Poppins, sans-serif',  icon: '💪', tags: ['motivation'] },
    { id: 'love',           name: 'Love',          background: 'linear-gradient(135deg,#ff6b6b,#c9184a)', textColor: '#fff', fontFamily: 'Pacifico, cursive',    icon: '❤️', tags: ['romance'] },
    { id: 'nature',         name: 'Nature',        background: 'linear-gradient(135deg,#52b788,#1b4332)', textColor: '#fff', fontFamily: 'Lato, sans-serif',     icon: '🌿', tags: ['nature'] },
    { id: 'celebration',    name: 'Celebration',   background: 'linear-gradient(135deg,#ffd60a,#e76f51)', textColor: '#222', fontFamily: 'Poppins, sans-serif',  icon: '🎉', tags: ['celebration'] },
    { id: 'minimal',        name: 'Minimal',       background: '#ffffff',                                  textColor: '#222', fontFamily: 'Inter, sans-serif',    icon: '◻️', tags: ['clean'] },
    { id: 'dark',           name: 'Dark Mode',     background: '#1a1a2e',                                  textColor: '#e0e0e0', fontFamily: 'Inter, sans-serif',  icon: '🌙', tags: ['dark'] },
    { id: 'gradient_purple',name: 'Purple Dream',  background: 'linear-gradient(135deg,#7b2d8b,#e040fb)', textColor: '#fff', fontFamily: 'Quicksand, sans-serif', icon: '💜', tags: ['mood'] },
    { id: 'gradient_ocean', name: 'Ocean',         background: 'linear-gradient(135deg,#00b4d8,#0077b6)', textColor: '#fff', fontFamily: 'Raleway, sans-serif',   icon: '🌊', tags: ['nature'] },
    { id: 'gradient_sunset',name: 'Sunset',        background: 'linear-gradient(135deg,#ff9a3c,#ff6392)', textColor: '#fff', fontFamily: 'Poppins, sans-serif',   icon: '🌅', tags: ['mood'] },
];

router.get('/templates', apiRateLimiter, (req, res) => {
    const { tag } = req.query;
    const templates = tag ? STATUS_TEMPLATES.filter(t => t.tags.includes(tag)) : STATUS_TEMPLATES;
    res.json({ success: true, data: { templates } });
});

// ═══════════════════════════════════════════════════════════════════
// P3 FIX: Countdown sticker — GET live countdown for a status
// ═══════════════════════════════════════════════════════════════════
router.get('/:statusId/countdown', optionalAuthenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const statusId = parseInt(req.params.statusId, 10);
    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findOne({ where: { id: statusId, isActive: true } }).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    const meta = status.metadata || {};
    if (!meta.countdown || !meta.countdown.targetDate) {
        return res.status(400).json({ success: false, message: 'This status has no countdown sticker' });
    }

    const targetDate = new Date(meta.countdown.targetDate);
    const now = new Date();
    const msLeft = targetDate - now;

    if (msLeft <= 0) {
        return res.json({ success: true, data: { finished: true, label: meta.countdown.label || '', msLeft: 0, formatted: { days: 0, hours: 0, minutes: 0, seconds: 0 } } });
    }

    const totalSeconds = Math.floor(msLeft / 1000);
    const days    = Math.floor(totalSeconds / 86400);
    const hours   = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    res.json({ success: true, data: {
        finished: false,
        label: meta.countdown.label || '',
        targetDate: targetDate.toISOString(),
        msLeft,
        formatted: { days, hours, minutes, seconds },
    }});
}));

// ═══════════════════════════════════════════════════════════════════
// P3 FIX: Profile-visit tracking from story views
// ═══════════════════════════════════════════════════════════════════
router.get('/:statusId/viewers/profiles', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findOne({ where: { id: statusId, userId } }).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found or not yours' });

    const viewers = StatusView ? await StatusView.findAll({
        where: { statusId },
        attributes: ['userId', 'viewedAt'],
        include: [{ model: User, as: 'viewer', attributes: ['id', 'username', 'displayName', 'avatar'], required: false }],
        order: [['viewedAt', 'DESC']],
        limit: 100,
    }).catch(() => []) : [];

    res.json({ success: true, data: {
        viewers: viewers.map(v => ({
            userId: v.userId,
            viewedAt: v.viewedAt,
            user: v.viewer ? formatUser(v.viewer) : { id: v.userId },
        })),
        totalViews: viewers.length,
    }});
}));


// ═══════════════════════════════════════════════════════════════════
// P3 FIX: Per-status analytics endpoint
// ═══════════════════════════════════════════════════════════════════
router.get('/stats/:statusId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId   = getUserId(req);
    const statusId = parseInt(req.params.statusId, 10);
    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findOne({ where: { id: statusId, userId } }).catch(() => null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found or not yours' });

    // Viewer breakdown (top 20 viewers)
    const viewers = StatusView ? await StatusView.findAll({
        where: { statusId },
        attributes: ['userId', 'viewedAt'],
        order: [['viewedAt', 'DESC']],
        limit: 20,
    }).catch(() => []) : [];

    // Comment count breakdown
    const commentCount = StatusComment ? await StatusComment.count({ where: { statusId, isDeleted: false } }).catch(() => 0) : 0;

    const meta = status.metadata || {};
    const pollOptions  = meta.pollOptions  || null;
    const pollVoters   = meta.pollVoters   || {};
    const answers      = meta.answers      || [];
    const actionClicks = meta.actionClicks || [];

    // Engagement rate: (likes + comments + shares) / views
    const views    = status.viewCount    || 0;
    const likes    = status.likeCount    || 0;
    const shares   = status.shareCount   || 0;
    const engRate  = views > 0 ? (((likes + commentCount + shares) / views) * 100).toFixed(1) : '0.0';

    res.json({ success: true, data: {
        statusId,
        type: status.type,
        content: status.content,
        createdAt: status.createdAt,
        expiresAt: status.expiresAt,
        isPinned: status.isPinned,
        metrics: {
            views, likes, shares,
            comments: commentCount,
            engagementRate: `${engRate}%`,
        },
        viewers: viewers.map(v => ({ userId: v.userId, viewedAt: v.viewedAt })),
        pollStats: pollOptions ? {
            options: pollOptions,
            totalVotes: pollOptions.reduce((s, o) => s + (o.votes || 0), 0),
            voterCount: Object.keys(pollVoters).length,
        } : null,
        questionStats: status.type === 'question' ? {
            questionText: meta.questionText,
            answersCount: answers.length,
            answers: answers.slice(0, 10), // first 10 answers
        } : null,
        actionClickStats: actionClicks.length ? {
            totalClicks: actionClicks.length,
            byButton: actionClicks.reduce((acc, c) => {
                const key = c.buttonLabel || `Button ${c.buttonIndex}`;
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {}),
        } : null,
    }});
}));

// ═══════════════════════════════════════════════════════════════════
// P3 FIX: Creator analytics dashboard — aggregated top-performers
// ═══════════════════════════════════════════════════════════════════
router.get('/analytics/dashboard', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { period = '7d' } = req.query;
    const periodMs = { '1d': 86400000, '7d': 604800000, '30d': 2592000000 };
    const startDate = new Date(Date.now() - (periodMs[period] || periodMs['7d']));
    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    // All statuses in period
    const statuses = await Status.findAll({
        where: { userId, createdAt: { [Op.gte]: startDate } },
        attributes: ['id', 'type', 'content', 'viewCount', 'likeCount', 'shareCount', 'commentCount', 'createdAt', 'isPinned'],
        order: [['viewCount', 'DESC']],
        limit: 100,
    }).catch(() => []);

    const totals = statuses.reduce((acc, s) => {
        acc.views    += (s.viewCount    || 0);
        acc.likes    += (s.likeCount    || 0);
        acc.shares   += (s.shareCount   || 0);
        acc.comments += (s.commentCount || 0);
        return acc;
    }, { views: 0, likes: 0, shares: 0, comments: 0 });

    const typeBreakdown = statuses.reduce((acc, s) => {
        acc[s.type] = (acc[s.type] || 0) + 1;
        return acc;
    }, {});

    const topByViews    = statuses.slice(0, 5).map(s => ({ id: s.id, content: s.content, views: s.viewCount || 0 }));
    const topByLikes    = [...statuses].sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0)).slice(0, 5).map(s => ({ id: s.id, content: s.content, likes: s.likeCount || 0 }));
    const engRate       = totals.views > 0 ? (((totals.likes + totals.comments + totals.shares) / totals.views) * 100).toFixed(1) : '0.0';

    res.json({ success: true, data: {
        period,
        totalStatuses: statuses.length,
        totals: { ...totals, engagementRate: `${engRate}%` },
        typeBreakdown,
        topByViews,
        topByLikes,
        bestPostingTimes: statuses.reduce((acc, s) => {
            const hour = new Date(s.createdAt).getHours();
            acc[hour] = (acc[hour] || 0) + (s.viewCount || 0);
            return acc;
        }, {}),
    }});
}));


module.exports = router;
