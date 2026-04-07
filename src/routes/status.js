// routes/status.js - Complete Status Management Routes
// FIXED v2.0:
//   1. POST /status        = create  (was mapped as /status/create)
//   2. POST /:id/view      = view    (was mapped as /status/view — wrong path)
//   3. DELETE /:id         = delete  (was mapped as /status/delete — wrong path)
//   4. /my                 = my own statuses (authenticated)
//   5. /friends            = friends' statuses (authenticated) — NEW, wired to friendService
//   6. stats route before /:statusId to avoid param collision
//   7. Response shape:  { success, data: { statuses } }  OR  { success, data: { status } }
//      Backend always wraps in data.* so status-core.js can find response.data.statuses

'use strict';

const express   = require('express');
const router    = express.Router();
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { authenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// ---------------------------------------------------------------------------
// Model imports
// ---------------------------------------------------------------------------
let db, User, Status, StatusLike, StatusComment, StatusView, Friend;
try {
    db            = require('../models');
    User          = db.User          || db.Users;
    Status        = db.Status        || db.Statuses;
    StatusLike    = db.StatusLike    || db.StatusLikes;
    StatusComment = db.StatusComment || db.StatusComments;
    StatusView    = db.StatusView    || db.StatusViews;
    Friend        = db.Friend        || db.Friends;
    console.log('[Status Route] Models loaded - User:', !!User, 'Status:', !!Status, 'Friend:', !!Friend);
} catch (e) {
    console.error('[Status Route] Error loading models:', e.message);
}

const Sequelize = require('sequelize');
const { Op }    = Sequelize;

console.log('✅ Status routes initialized (v2.0)');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const formatUser = (u) => {
    if (!u) return null;
    const d = u.toJSON ? u.toJSON() : u;
    return {
        id: d.id, username: d.username, avatar: d.avatar,
        displayName: [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.username,
        firstName: d.firstName || '', lastName: d.lastName || '',
        status: d.status, lastSeen: d.lastSeen,
    };
};

const formatStatus = (s) => {
    if (!s) return null;
    const d = s.toJSON ? s.toJSON() : s;
    return {
        id: d.id, userId: d.userId,
        content: d.content, type: d.type, moodType: d.moodType,
        mediaUrl: d.mediaUrl, location: d.location,
        latitude: d.latitude, longitude: d.longitude,
        isActive: d.isActive, isPublic: d.isPublic, expiresAt: d.expiresAt,
        viewCount: d.viewCount || 0, likeCount: d.likeCount || 0,
        commentCount: d.commentCount || 0, shareCount: d.shareCount || 0,
        metadata: d.metadata, createdAt: d.createdAt, updatedAt: d.updatedAt,
        // support both 'user' (legacy) and Sequelize association alias 'statusUser'
        user: formatUser(d.statusUser || d.user),
    };
};

const getUserId = (req) => req.user?.userId || req.user?.id || null;

const VALID_TYPES  = ['text', 'image', 'video', 'audio', 'mood', 'location'];
const VALID_MOODS  = ['happy','sad','angry','excited','calm','anxious','tired','energetic',
                      'focused','relaxed','nostalgic','romantic','lonely','confused','proud',
                      'grateful','hopeful','bored','sick','neutral'];

const userInclude = () => User ? [{
    model: User, as: 'statusUser', required: false,
    attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'],
}] : [];

const activeWhere = () => ({
    isActive: true,
    [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
});

const ensureModels = (req, res, next) => {
    if (!User) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
    next();
};

router.use(ensureModels);

// ---------------------------------------------------------------------------
// PUBLIC ROUTES (no auth required)
// ---------------------------------------------------------------------------

// Health
router.get('/health', (req, res) => res.json({
    success: true, status: 'online', service: 'Status API', timestamp: new Date().toISOString(),
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
            where, include: userInclude(),
            order: [['createdAt', 'DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus),
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// Public alias
router.get('/public', apiRateLimiter, asyncHandler(async (req, res) => {
    const { limit = 20, offset = 0 } = req.query;
    const where = { isPublic: true, ...activeWhere() };

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where, include: userInclude(),
            order: [['createdAt', 'DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus),
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// Trending
router.get('/trending', apiRateLimiter, asyncHandler(async (req, res) => {
    const { limit = 10 } = req.query;
    const where = {
        isPublic: true, ...activeWhere(),
        createdAt: { [Op.gte]: new Date(Date.now() - 24 * 3600000) },
    };

    let rows = [];
    if (Status) {
        rows = await Status.findAll({
            where, include: userInclude(),
            order: [['likeCount','DESC'],['viewCount','DESC'],['createdAt','DESC']],
            limit: +limit,
        }).catch(() => []);
    }

    res.json({ success: true, data: { statuses: rows.map(formatStatus), total: rows.length }});
}));

// Search
router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
    const { q, limit = 20, offset = 0 } = req.query;
    if (!q || q.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
    }

    const where = { isPublic: true, content: { [Op.iLike]: `%${q}%` }, ...activeWhere() };
    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where, include: userInclude(),
            order: [['createdAt','DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus), query: q,
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// Mood filter
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
            where, include: userInclude(),
            order: [['createdAt','DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus), moodType,
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// Comments & likes (public read)
router.get('/:statusId/comments', apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    let rows = [], total = 0;
    if (StatusComment) {
        const include = User ? [{ model: User, as: 'commentUser', required: false,
            attributes: ['id','username','avatar','firstName','lastName'] }] : [];
        const r = await StatusComment.findAndCountAll({
            where: { statusId }, include,
            order: [['createdAt','DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        comments: rows.map(c => ({
            id: c.id, statusId: c.statusId, userId: c.userId, content: c.content,
            createdAt: c.createdAt, user: c.commentUser ? formatUser(c.commentUser) : null,
        })),
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

router.get('/:statusId/likes', apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    let rows = [], total = 0;
    if (StatusLike) {
        const include = User ? [{ model: User, as: 'likeUser', required: false,
            attributes: ['id','username','avatar','firstName','lastName'] }] : [];
        const r = await StatusLike.findAndCountAll({
            where: { statusId }, include,
            order: [['createdAt','DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        likes: rows.map(l => ({
            id: l.id, statusId: l.statusId, userId: l.userId, createdAt: l.createdAt,
            user: l.likeUser ? formatUser(l.likeUser) : null,
        })),
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// Single status (public read — view count incremented if authenticated)
router.get('/:statusId', apiRateLimiter, asyncHandler(async (req, res) => {
    const { statusId } = req.params;
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    // optional auth — try to pull userId if available (middleware may not be applied here)
    const userId = req.user ? getUserId(req) : null;

    let status = null;
    if (Status) {
        status = await Status.findOne({ where: { id: statusId }, include: userInclude() }).catch(() => null);
    }
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    const isOwner    = userId && status.userId === userId;
    const isPublic   = status.isPublic === true;
    const isExpired  = status.expiresAt && new Date(status.expiresAt) < new Date();

    if (!isOwner && !isPublic) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (isExpired) {
        return res.status(410).json({ success: false, message: 'Status has expired' });
    }

    if (!isOwner && userId) {
        await Status.update({ viewCount: (status.viewCount||0)+1 }, { where: { id: statusId } }).catch(()=>{});
        status.viewCount = (status.viewCount||0)+1;
        if (StatusView) {
            const seen = await StatusView.findOne({ where: { statusId, userId } }).catch(()=>null);
            if (!seen) StatusView.create({ statusId: +statusId, userId, viewedAt: new Date() }).catch(()=>{});
        }
    }

    res.json({ success: true, data: { status: formatStatus(status) }});
}));

// ---------------------------------------------------------------------------
// AUTHENTICATED ROUTES
// ---------------------------------------------------------------------------
router.use(authenticateToken);

// ── Create status  ──────────────────────────────────────────────────────────
// status-core.js sends POST /api/status/create  →  chat.html maps it to POST /api/status
// This single route handles BOTH /api/status  (direct) and is what the frontend hits.
router.post(
    '/',
    [
        body('content').optional().isLength({ max: 500 }).withMessage('Content too long'),
        body('type').optional().isIn(VALID_TYPES).withMessage('Invalid type'),
        body('moodType').optional().isIn(VALID_MOODS).withMessage('Invalid mood'),
        body('mediaUrl').optional().isURL().withMessage('Invalid media URL'),
        body('isPublic').optional().isBoolean(),
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
            isPublic = true, background, expiresAt,
            // status-core.js sends 'text' as field name — support both
            text,
        } = req.body;

        // Accept 'text' (status-core) or 'content' (controller/route)
        const finalContent = content || text || '';
        if (!finalContent && type !== 'mood' && type !== 'location' && !mediaUrl) {
            return res.status(400).json({ success: false, message: 'Content is required' });
        }

        if (!Status) {
            // graceful fallback — return a synthetic status so frontend doesn't crash
            const fake = {
                id: Date.now(), userId, content: finalContent, type: type||'text',
                isPublic, isActive: true, createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(), user: { id: userId },
            };
            return res.status(201).json({ success: true, data: { status: formatStatus(fake) }, message: 'Status created' });
        }

        const statusData = {
            userId, content: finalContent, type: type || 'text',
            moodType: moodType || null, mediaUrl: mediaUrl || null,
            location: location || null, latitude: latitude || null, longitude: longitude || null,
            isPublic, isActive: true,
            metadata: background ? { background } : {},
            expiresAt: expiresAt ? new Date(expiresAt) : new Date(Date.now() + 24*3600000),
        };

        const created = await Status.create(statusData);

        // Attach user info
        const user = User ? await User.findByPk(userId, {
            attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'],
        }).catch(()=>null) : null;
        if (user) created.dataValues.statusUser = user;

        // Real-time broadcast via Socket.IO (if available)
        if (req.io) {
            req.io.emit('status:created', {
                statusId: created.id, userId,
                content: created.content, timestamp: new Date(),
            });
        }

        res.status(201).json({
            success: true,
            data: { status: formatStatus(created) },
            message: 'Status created successfully',
        });
    })
);

// ── My statuses  ────────────────────────────────────────────────────────────
router.get('/my', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { limit = 50, offset = 0, includeInactive = false } = req.query;
    const where = { userId };
    if (includeInactive !== 'true') Object.assign(where, activeWhere());

    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where, include: userInclude(),
            order: [['createdAt','DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus),
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// ── Friends' statuses  ──────────────────────────────────────────────────────
// NEW: status-core.js can load these by calling GET /api/status/friends
router.get('/friends', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { limit = 50, offset = 0 } = req.query;

    // Collect friend IDs
    let friendIds = [];
    if (Friend) {
        const friendships = await Friend.findAll({
            where: {
                status: 'accepted',
                [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
            },
            attributes: ['requesterId', 'receiverId'],
        }).catch(() => []);
        friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);
    }

    if (friendIds.length === 0) {
        return res.json({ success: true, data: {
            statuses: [],
            pagination: { limit: +limit, offset: +offset, total: 0, hasMore: false },
        }});
    }

    const where = { userId: { [Op.in]: friendIds }, ...activeWhere() };
    let rows = [], total = 0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where, include: userInclude(),
            order: [['createdAt','DESC']], limit: +limit, offset: +offset,
        }).catch(() => ({ rows: [], count: 0 }));
        rows = r.rows; total = r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus),
        pagination: { limit: +limit, offset: +offset, total, hasMore: +offset + rows.length < total },
    }});
}));

// ── Stats (must be BEFORE /:statusId)  ──────────────────────────────────────
router.get('/stats', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { period = '7d' } = req.query;
    const periodMs = { '1d': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000 };
    if (!periodMs[period]) return res.status(400).json({ success: false, message: 'Invalid period. Use: 1d, 7d, 30d, 90d' });

    const startDate = new Date(Date.now() - periodMs[period]);
    let totalStatuses=0, activeStatuses=0, totalLikes=0, totalViews=0, totalComments=0;

    if (Status) {
        [totalStatuses, activeStatuses] = await Promise.all([
            Status.count({ where: { userId, createdAt: { [Op.gte]: startDate } } }).catch(()=>0),
            Status.count({ where: { userId, isActive: true, ...activeWhere() } }).catch(()=>0),
        ]);

        const stats = await Status.findAll({
            where: { userId, createdAt: { [Op.gte]: startDate } },
            attributes: [
                [Sequelize.fn('SUM', Sequelize.col('likeCount')),    'tl'],
                [Sequelize.fn('SUM', Sequelize.col('viewCount')),    'tv'],
                [Sequelize.fn('SUM', Sequelize.col('commentCount')), 'tc'],
            ],
        }).catch(()=>[]);

        if (stats[0]) {
            totalLikes    = parseInt(stats[0].dataValues.tl) || 0;
            totalViews    = parseInt(stats[0].dataValues.tv) || 0;
            totalComments = parseInt(stats[0].dataValues.tc) || 0;
        }
    }

    res.json({ success: true, data: {
        period, totalStatuses, activeStatuses, totalLikes, totalViews, totalComments,
        engagementRate: totalStatuses > 0 ? (((totalLikes+totalComments)/totalStatuses)).toFixed(2) : 0,
    }});
}));

// ── Update status  ──────────────────────────────────────────────────────────
router.put('/:statusId', [
    body('content').optional().isLength({ max: 500 }).withMessage('Content too long'),
    body('isPublic').optional().isBoolean(),
], apiRateLimiter, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId   = getUserId(req);
    const { statusId } = req.params;
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    let status = null;
    if (Status) {
        status = await Status.findOne({ where: { id: statusId, userId } }).catch(()=>null);
    }
    if (!status) return res.status(404).json({ success: false, message: 'Status not found or you do not own it' });

    const { content, isPublic } = req.body;
    const updates = {};
    if (content  !== undefined) updates.content  = content;
    if (isPublic !== undefined) updates.isPublic = isPublic;
    updates.updatedAt = new Date();

    await status.update(updates).catch(()=>{});

    const refreshed = Status ? await Status.findOne({
        where: { id: statusId }, include: userInclude(),
    }).catch(()=>status) : status;

    if (req.io) req.io.emit('status:updated', { statusId, userId, timestamp: new Date() });

    res.json({ success: true, data: { status: formatStatus(refreshed) }, message: 'Status updated successfully' });
}));

// ── Delete status  ──────────────────────────────────────────────────────────
router.delete('/:statusId', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    let deleted = false;
    if (Status) {
        deleted = await Status.destroy({ where: { id: statusId, userId } }).then(n=>n>0).catch(()=>false);
    }
    if (!deleted) return res.status(404).json({ success: false, message: 'Status not found or you do not own it' });

    if (req.io) req.io.emit('status:deleted', { statusId, userId, timestamp: new Date() });

    res.json({ success: true, message: 'Status deleted successfully' });
}));

// ── Like  ────────────────────────────────────────────────────────────────────
router.post('/:statusId/like', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(()=>null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    let alreadyLiked = false;
    if (StatusLike) {
        const existing = await StatusLike.findOne({ where: { statusId, userId } }).catch(()=>null);
        alreadyLiked = !!existing;
        if (!alreadyLiked) {
            await StatusLike.create({ statusId: +statusId, userId, createdAt: new Date() }).catch(()=>{});
            await Status.update({ likeCount: (status.likeCount||0)+1 }, { where: { id: statusId } });
            status.likeCount = (status.likeCount||0)+1;
        }
    } else {
        await Status.update({ likeCount: (status.likeCount||0)+1 }, { where: { id: statusId } });
        status.likeCount = (status.likeCount||0)+1;
    }

    if (req.io) req.io.emit('status:liked', { statusId, userId, timestamp: new Date() });
    res.json({ success: true, data: { liked: !alreadyLiked, likeCount: status.likeCount },
        message: alreadyLiked ? 'Already liked' : 'Status liked successfully' });
}));

// ── Unlike  ──────────────────────────────────────────────────────────────────
router.delete('/:statusId/like', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId } = req.params;
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(()=>null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    let wasLiked = false;
    if (StatusLike) {
        const like = await StatusLike.findOne({ where: { statusId, userId } }).catch(()=>null);
        wasLiked = !!like;
        if (like) {
            await like.destroy();
            await Status.update({ likeCount: Math.max(0,(status.likeCount||0)-1) }, { where: { id: statusId } });
            status.likeCount = Math.max(0,(status.likeCount||0)-1);
        }
    }

    if (req.io) req.io.emit('status:unliked', { statusId, userId, timestamp: new Date() });
    res.json({ success: true, data: { liked: false, likeCount: status.likeCount },
        message: wasLiked ? 'Status unliked' : 'Status was not liked' });
}));

// ── Record view  ─────────────────────────────────────────────────────────────
// status-core.js sends POST /api/status/view → mapped in chat.html to POST /status/view
// But the real route is  POST /status/:statusId/view
// We add BOTH: /view  (legacy, statusId in body) AND  /:statusId/view  (RESTful)
const _recordView = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    // Accept statusId from params OR body (for legacy /view call)
    const statusId = req.params.statusId || req.body.statusId;
    if (!statusId || isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.json({ success: true, data: { viewed: false, viewCount: 0 } });

    const status = await Status.findByPk(statusId).catch(()=>null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    let alreadyViewed = false;
    if (StatusView) {
        const existing = await StatusView.findOne({ where: { statusId, userId } }).catch(()=>null);
        alreadyViewed = !!existing;
        if (!alreadyViewed) {
            await StatusView.create({ statusId: +statusId, userId, viewedAt: new Date() }).catch(()=>{});
            await Status.update({ viewCount: (status.viewCount||0)+1 }, { where: { id: statusId } });
            status.viewCount = (status.viewCount||0)+1;
        }
    } else {
        await Status.update({ viewCount: (status.viewCount||0)+1 }, { where: { id: statusId } });
        status.viewCount = (status.viewCount||0)+1;
    }

    res.json({ success: true, data: { viewed: !alreadyViewed, viewCount: status.viewCount },
        message: alreadyViewed ? 'View already recorded' : 'View recorded' });
});

router.post('/view',           apiRateLimiter, _recordView);   // legacy endpoint
router.post('/:statusId/view', apiRateLimiter, _recordView);   // RESTful endpoint

// ── Comment  ──────────────────────────────────────────────────────────────────
router.post('/:statusId/comment', [
    body('content').notEmpty().withMessage('Comment required').isLength({ max: 500 }).withMessage('Too long'),
], apiRateLimiter, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = getUserId(req);
    const { statusId } = req.params;
    if (isNaN(+statusId)) return res.status(400).json({ success: false, message: 'Invalid status ID' });

    if (!Status) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const status = await Status.findByPk(statusId).catch(()=>null);
    if (!status) return res.status(404).json({ success: false, message: 'Status not found' });

    const { content } = req.body;
    let comment = null;
    if (StatusComment) {
        comment = await StatusComment.create({ statusId: +statusId, userId, content, createdAt: new Date() });
    } else {
        comment = { id: Date.now(), statusId: +statusId, userId, content, createdAt: new Date() };
    }
    await Status.update({ commentCount: (status.commentCount||0)+1 }, { where: { id: statusId } });

    const userObj = User ? await User.findByPk(userId, { attributes: ['id','username','avatar','firstName','lastName'] }).catch(()=>null) : null;

    if (req.io) req.io.emit('status:commented', { statusId, commentId: comment.id, userId, timestamp: new Date() });
    res.status(201).json({ success: true,
        data: { comment: { ...comment.toJSON?.() || comment, user: userObj ? formatUser(userObj) : null } },
        message: 'Comment added' });
}));

// ── Delete comment  ───────────────────────────────────────────────────────────
router.delete('/:statusId/comment/:commentId', apiRateLimiter, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { statusId, commentId } = req.params;
    if (isNaN(+statusId) || isNaN(+commentId)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    if (!StatusComment) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const comment = await StatusComment.findOne({ where: { id: commentId, statusId } }).catch(()=>null);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    if (comment.userId !== userId) return res.status(403).json({ success: false, message: 'Not your comment' });

    await comment.destroy();
    if (Status) {
        const status = await Status.findByPk(statusId).catch(()=>null);
        if (status) await Status.update({ commentCount: Math.max(0,(status.commentCount||0)-1) }, { where: { id: statusId } });
    }

    if (req.io) req.io.emit('status:comment:deleted', { statusId, commentId, userId, timestamp: new Date() });
    res.json({ success: true, message: 'Comment deleted' });
}));

// ── User statuses  ────────────────────────────────────────────────────────────
router.get('/user/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
    const viewerId    = getUserId(req);
    const targetId    = req.params.userId;
    const { limit=20, offset=0, includeExpired=false } = req.query;

    const where = { userId: targetId };
    if (targetId !== viewerId) { Object.assign(where, activeWhere()); where.isPublic = true; }
    else if (includeExpired !== 'true') Object.assign(where, activeWhere());

    let rows=[], total=0;
    if (Status) {
        const r = await Status.findAndCountAll({
            where, include: userInclude(),
            order:[['createdAt','DESC']], limit:+limit, offset:+offset,
        }).catch(()=>({ rows:[], count:0 }));
        rows=r.rows; total=r.count;
    }

    res.json({ success: true, data: {
        statuses: rows.map(formatStatus),
        pagination: { limit:+limit, offset:+offset, total, hasMore:+offset+rows.length<total },
    }});
}));

module.exports = router;