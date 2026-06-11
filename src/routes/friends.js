const path = require('path');
const express = require('express');
const router = express.Router();

// ===== SAFE MODEL IMPORT =====
let db, User, Friend, Chat, Message, Call, Group, GroupMember, Invite;
try {
    db = require('../models');

    // FIX: Try every known alias for each model. Sequelize registers models under
    // the class name used in define(), which varies per project. Log exactly what
    // was found so a null Friend is immediately visible in server logs.
    User        = db.models?.Users    || db.models?.User    || db.User    || db.Users;
    Friend      = db.models?.Friends  || db.models?.Friend  || db.Friend  || db.Friends
               || db.models?.Friendship || db.Friendship;
    Chat        = db.models?.Chats    || db.models?.Chat    || db.Chat    || db.Chats;
    Message     = db.models?.Messages || db.models?.Message || db.Message || db.Messages;
    Call        = db.models?.Calls    || db.models?.Call    || db.Call    || db.Calls;
    Group       = db.models?.Groups   || db.models?.Group   || db.Group   || db.Groups;
    GroupMember = db.models?.GroupMembers || db.models?.GroupMember || db.GroupMember || db.GroupMembers;
    Invite      = db.models?.Invites  || db.models?.Invite  || db.Invite  || db.Invites;

    console.log('[Friends Route] Models resolved — User:', !!User, 'Friend:', !!Friend, 'Invite:', !!Invite);

    if (!Friend) {
        // Dump registered model names so the developer can see exactly what's available
        const registered = db.models
            ? Object.keys(db.models)
            : Object.keys(db).filter(k => !['sequelize','Sequelize','Op','DataTypes'].includes(k));
        console.error('[Friends Route] ⚠️  Friend model NOT FOUND. Registered models:', registered.join(', '));
    }
} catch (error) {
    console.error('[Friends Route] Error loading models:', error.message);
    db = null;
}

const Sequelize = require('sequelize');
const { Op } = Sequelize;
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// ===== AUTHENTICATION MIDDLEWARE IMPORT =====
let authenticateToken;
try {
    const authMiddleware = require('../middleware/auth');
    authenticateToken = authMiddleware.authenticateToken || authMiddleware;
    console.log('[Friends Route] Auth middleware loaded');
} catch (error) {
    console.error('[Friends Route] Failed to load auth middleware:', error.message);
    // Fail closed: never run this router without real auth middleware.
    throw new Error('[Friends Route] Critical security dependency missing: auth middleware');
}

console.log('✅ Friends routes initialized');

// ===== APPLY AUTHENTICATION GLOBALLY =====
// This ensures req.user is always populated for all routes
router.use(authenticateToken);

const formatUser = (user) => {
    if (!user) return null;
    const u = user.toJSON ? user.toJSON() : user;
    const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username;
    return {
        id: u.id,
        username: u.username || '',
        avatar: u.avatar || null,
        displayName,
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        bio: u.bio || '',
        status: u.status || 'offline',
        lastActive: u.lastSeen || null
    };
};

// FIX: getUserId supports BOTH integer and UUID/string IDs.
// parseInt() was breaking UUID-based user systems — if the ID is purely numeric
// we still return it as an integer for DB compatibility, otherwise return as-is.
const getUserId = (req) => {
    if (!req.user) { 
        console.error('[Friends] req.user is undefined! Auth middleware may not be working');
        return null; 
    }
    const id = req.user.userId || req.user.id;
    if (!id) return null;
    // Only coerce to integer if the id looks purely numeric
    const parsed = parseInt(id, 10);
    return !isNaN(parsed) && String(parsed) === String(id) ? parsed : String(id);
};

// FIX: Safe ID parser — handles both integer PKs and UUID string PKs.
// parseInt() silently returns NaN for UUIDs, causing all param-based routes to
// return 400 "Invalid ID" for UUID-based users. Use this everywhere instead.
const parseId = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const n = parseInt(s, 10);
    // If purely numeric AND roundtrips correctly, treat as integer; otherwise UUID/string
    return !isNaN(n) && String(n) === s ? n : s;
};

const withTimeout = (promise, timeoutMs = 8000) => {
    let tid;
    const t = new Promise((_, reject) => { tid = setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs); });
    return Promise.race([promise, t]).finally(() => { if (tid) clearTimeout(tid); });
};

const ensureModels = (req, res, next) => {
    if (!User) {
        console.error('[Friends] FATAL: User model unavailable — DB not loaded correctly');
        return res.status(503).json({ success: false, message: 'Service temporarily unavailable', code: 'MODEL_UNAVAILABLE' });
    }
    // FIX: Log Friend model availability on every mutating request so failures are visible.
    // Previously the Friend null-guard silently returned 503 on POST routes and the
    // API bridge in chat.html mapped that to a success — so friend-core.js never knew
    // the request failed and saved the record as isLocalOnly:true forever.
    if (!Friend && (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT' || req.method === 'PATCH')) {
        console.error('[Friends] FATAL: Friend model null for', req.method, req.path,
            '— db.Friend=', !!db.Friend, 'db.Friends=', !!db.Friends,
            'db.models?.Friends=', !!(db.models && db.models.Friends));
        return res.status(503).json({
            success: false,
            message: 'Friend service temporarily unavailable — model not loaded',
            code: 'FRIEND_MODEL_UNAVAILABLE'
        });
    }
    next();
};
router.use(ensureModels);

// ============================================================
// IMPORTANT: All specific GET routes MUST come before /:friendId
// ============================================================

// ===== PING =====
router.get('/ping', apiRateLimiter, asyncHandler(async (req, res) => {
    return res.json({ success: true, route: 'friends', timestamp: new Date().toISOString(), status: 'online' });
}));

// ===== GET ALL FRIENDS =====
router.get('/', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { friends: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            attributes: ['requesterId', 'receiverId'], raw: true, limit: 500
        }));

        if (!friendships || friendships.length === 0) return res.json({ success: true, data: { friends: [] } });

        // 🔴 BUG 3 FIX: Handle both camelCase and snake_case from raw queries
        const friendIds = friendships.map(f => {
            const rid = f.requesterId || f.requester_id;
            const rcid = f.receiverId || f.receiver_id;
            // Use loose equality to handle string/int mismatch from raw query
            // eslint-disable-next-line eqeqeq
            return rid == userId ? rcid : rid;
            // eslint-disable-next-line eqeqeq
        }).filter(id => id && id != userId);

        if (!friendIds.length) return res.json({ success: true, data: { friends: [] } });

        const friends = await withTimeout(User.findAll({
            where: { id: { [Op.in]: friendIds } },
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'], limit: 500
        }));

        return res.json({ success: true, data: { friends: (friends || []).map(formatUser) } });
    } catch (e) {
        console.error('[Friends GET /]', e.message);
        return res.json({ success: true, data: { friends: [] } });
    }
}));

// ===== GET FRIENDS LIST ALIAS =====
router.get('/list', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { friends: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            include: [
                { model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false },
                { model: User, as: 'friendReceiverUser',  attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false }
            ], limit: 200
        }));

        const friends = (friendships || []).map(f => f.requesterId === userId ? formatUser(f.friendReceiverUser) : formatUser(f.friendRequesterUser)).filter(f => f && f.id);
        return res.json({ success: true, data: { friends } });
    } catch (e) {
        console.error('[Friends GET /list]', e.message);
        return res.json({ success: true, data: { friends: [] } });
    }
}));

// ===== GET ALL USERS FOR DISCOVER =====
router.get('/users/all', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { limit = 200, page = 1, search } = req.query;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 200));
        const offset = (pageNum - 1) * limitNum;

        // Get IDs of users already related (blocked, pending, accepted) to exclude from "all users"
        let excludedIds = [userId];
        if (Friend) {
            try {
                const relations = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }] },
                    attributes: ['requesterId', 'receiverId', 'status'], raw: true
                }));
                // Only exclude accepted friends and blocked; show pending so user can see they sent request
                relations.forEach(f => {
                    const rid = f.requesterId || f.requester_id;
                    const rcid = f.receiverId || f.receiver_id;
                    const other = rid === userId ? rcid : rid;
                    // Only exclude blocked users from discover
                    if (f.status === 'blocked') excludedIds.push(other);
                });
            } catch (e) { /* non-fatal */ }
        }

        const whereCondition = { id: { [Op.notIn]: excludedIds } };

        if (search && search.trim().length >= 1) {
            const s = `%${search.trim().toLowerCase()}%`;
            whereCondition[Op.or] = [
                Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('username')),  { [Op.like]: s }),
                Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('firstName')), { [Op.like]: s }),
                Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('lastName')),  { [Op.like]: s })
            ];
        }

        const { count, rows: users } = await withTimeout(User.findAndCountAll({
            where: whereCondition,
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
            limit: limitNum, offset,
            order: [
                [Sequelize.literal("CASE WHEN status IN ('online','away') THEN 0 ELSE 1 END"), 'ASC'],
                ['username', 'ASC']
            ]
        }), 10000);

        // For each user, get their friendship status with the current user
        let friendshipMap = {};
        if (Friend && users && users.length > 0) {
            try {
                const userIds = users.map(u => u.id);
                const relations = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: { [Op.in]: userIds } },
                            { requesterId: { [Op.in]: userIds }, receiverId: userId }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId', 'status'], raw: true
                }));
                relations.forEach(r => {
                    const rid = r.requesterId || r.requester_id;
                    const rcid = r.receiverId || r.receiver_id;
                    const otherId = rid === userId ? rcid : rid;
                    let rel = 'none';
                    if (r.status === 'accepted') rel = 'friends';
                    else if (r.status === 'pending') {
                        rel = rid === userId ? 'request_sent' : 'request_received';
                    } else if (r.status === 'blocked') rel = 'blocked';
                    friendshipMap[otherId] = rel;
                });
            } catch (e) { /* non-fatal */ }
        }

        const formattedUsers = (users || []).map(u => ({
            ...formatUser(u),
            friendshipStatus: friendshipMap[u.id] || 'none'
        }));

        return res.json({
            success: true,
            data: {
                users: formattedUsers,
                pagination: { total: count, page: pageNum, limit: limitNum, pages: Math.ceil(count / limitNum) }
            }
        });
    } catch (e) {
        console.error('[Friends GET /users/all]', e.message);
        return res.json({ success: true, data: { users: [], pagination: { total: 0, page: 1, limit: 200, pages: 0 } } });
    }
}));

// ===== NEARBY USERS =====
// ===== NEARBY PRESENCE — push user GPS coords so they appear in others' nearby results =====
router.post('/nearby/presence', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { lat, lng, status = 'online' } = req.body;
        if (!lat || !lng || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
            return res.json({ success: true, skipped: true });
        }

        // Best-effort update — non-fatal if columns don't exist
        try {
            const tableDesc = await User.describe().catch(() => null);
            if (tableDesc) {
                const updates = {};
                if ('lat' in tableDesc)       updates.lat       = parseFloat(lat);
                if ('latitude' in tableDesc)  updates.latitude  = parseFloat(lat);
                if ('lng' in tableDesc)       updates.lng       = parseFloat(lng);
                if ('longitude' in tableDesc) updates.longitude = parseFloat(lng);
                if ('status' in tableDesc)    updates.status    = status;
                if (Object.keys(updates).length > 0) {
                    await User.update(updates, { where: { id: userId } });
                }
            }
        } catch (_) { /* non-fatal */ }

        return res.json({ success: true });
    } catch (e) {
        return res.json({ success: true }); // never block the client for a presence ping
    }
}));

// 🔴 BUG 5 FIX: Improved nearby with better fallback and friendship status
router.get('/nearby', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { lat, lng, radius = 5000 } = req.query;

        let excludeIds = [userId];
        // Only exclude blocked users - show everyone else including non-friends
        if (Friend) {
            try {
                const blocked = await withTimeout(Friend.findAll({
                    where: {
                        status: 'blocked',
                        [Op.or]: [{ requesterId: userId }, { receiverId: userId }]
                    },
                    attributes: ['requesterId', 'receiverId'], raw: true
                }));
                blocked.forEach(f => {
                    const rid = f.requesterId || f.requester_id;
                    const rcid = f.receiverId || f.receiver_id;
                    excludeIds.push(rid === userId ? rcid : rid);
                });
            } catch (e) { /* non-fatal */ }
        }

        const whereClause = { id: { [Op.notIn]: excludeIds } };
        const hasCoords = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));

        // 🔴 BUG 5 FIX: If no coordinates, return online AND recently active users (not just strictly online)
        if (!hasCoords) {
            const onlineUsers = await withTimeout(User.findAll({
                where: {
                    id: { [Op.notIn]: excludeIds },
                    [Op.or]: [
                        { status: 'online' },
                        { status: 'away' },
                        { lastSeen: { [Op.gte]: new Date(Date.now() - 30 * 60 * 1000) } }
                    ]
                },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                limit: 50,
                order: [
                    [Sequelize.literal("CASE WHEN status = 'online' THEN 0 ELSE 1 END"), 'ASC'],
                    ['lastSeen', 'DESC NULLS LAST']
                ]
            }));
            
            // Get friendship statuses for returned users
            let friendshipMap = {};
            if (Friend && onlineUsers && onlineUsers.length > 0) {
                try {
                    const uids = onlineUsers.map(u => u.id);
                    const relations = await withTimeout(Friend.findAll({
                        where: {
                            [Op.or]: [
                                { requesterId: userId, receiverId: { [Op.in]: uids } },
                                { requesterId: { [Op.in]: uids }, receiverId: userId }
                            ]
                        },
                        attributes: ['requesterId', 'receiverId', 'status'], raw: true
                    }));
                    relations.forEach(r => {
                        const rid = r.requesterId || r.requester_id;
                        const rcid = r.receiverId || r.receiver_id;
                        const other = rid === userId ? rcid : rid;
                        let rel = 'none';
                        if (r.status === 'accepted') rel = 'friends';
                        else if (r.status === 'pending') rel = rid === userId ? 'request_sent' : 'request_received';
                        else if (r.status === 'blocked') rel = 'blocked';
                        friendshipMap[other] = rel;
                    });
                } catch (e) { /* non-fatal */ }
            }

            const formattedUsers = (onlineUsers || []).map(u => ({
                ...formatUser(u),
                friendshipStatus: friendshipMap[u.id] || 'none'
            }));
            
            return res.json({
                success: true,
                data: {
                    users: formattedUsers,
                    count: formattedUsers.length,
                    mode: 'online'
                }
            });
        }

        // Has coordinates - location-based search
        const latF = parseFloat(lat);
        const lngF = parseFloat(lng);
        const radM = Math.min(50000, parseInt(radius));
        const radDeg = radM / 111320;
        whereClause.latitude = { [Op.between]: [latF - radDeg, latF + radDeg] };
        whereClause.longitude = { [Op.between]: [lngF - radDeg * 1.5, lngF + radDeg * 1.5] };

        const users = await withTimeout(User.findAll({
            where: whereClause,
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
            limit: 100,
            order: [
                [Sequelize.literal("CASE WHEN status IN ('online','away') THEN 0 ELSE 1 END"), 'ASC'],
                ['lastSeen', 'DESC NULLS LAST']
            ]
        }));

        // Get friendship statuses for returned users
        let friendshipMap = {};
        if (Friend && users && users.length > 0) {
            try {
                const uids = users.map(u => u.id);
                const relations = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: { [Op.in]: uids } },
                            { requesterId: { [Op.in]: uids }, receiverId: userId }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId', 'status'], raw: true
                }));
                relations.forEach(r => {
                    const rid = r.requesterId || r.requester_id;
                    const rcid = r.receiverId || r.receiver_id;
                    const other = rid === userId ? rcid : rid;
                    let rel = 'none';
                    if (r.status === 'accepted') rel = 'friends';
                    else if (r.status === 'pending') rel = rid === userId ? 'request_sent' : 'request_received';
                    else if (r.status === 'blocked') rel = 'blocked';
                    friendshipMap[other] = rel;
                });
            } catch (e) { /* non-fatal */ }
        }

        const formatted = (users || []).map(u => ({
            ...formatUser(u),
            friendshipStatus: friendshipMap[u.id] || 'none'
        }));

        return res.json({
            success: true,
            data: {
                users: formatted,
                count: formatted.length,
                mode: 'location'
            }
        });
    } catch (e) {
        console.error('[Friends GET /nearby]', e.message);
        return res.json({ success: true, data: { users: [], count: 0, mode: 'none' } });
    }
}));

// ===== SEARCH USERS =====
router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const query = (req.query.q || req.query.query || req.query.search || '').trim();
        if (!query || query.length < 1) return res.status(400).json({ success: false, message: 'Search query required (min 1 char)' });

        const s = `%${query.toLowerCase()}%`;
        const users = await withTimeout(User.findAll({
            where: {
                id: { [Op.ne]: userId },
                [Op.or]: [
                    Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('username')),  { [Op.like]: s }),
                    Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('firstName')), { [Op.like]: s }),
                    Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('lastName')),  { [Op.like]: s })
                ]
            },
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'],
            limit: Math.min(100, parseInt(req.query.limit) || 50),
            order: [['username', 'ASC']]
        }));

        // Attach friendship status
        let friendshipMap = {};
        if (Friend && users && users.length > 0) {
            try {
                const uids = users.map(u => u.id);
                const relations = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: { [Op.in]: uids } },
                            { requesterId: { [Op.in]: uids }, receiverId: userId }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId', 'status'], raw: true
                }));
                relations.forEach(r => {
                    const rid = r.requesterId || r.requester_id;
                    const rcid = r.receiverId || r.receiver_id;
                    const other = rid === userId ? rcid : rid;
                    let rel = 'none';
                    if (r.status === 'accepted') rel = 'friends';
                    else if (r.status === 'pending') rel = rid === userId ? 'request_sent' : 'request_received';
                    friendshipMap[other] = rel;
                });
            } catch (e) { /* non-fatal */ }
        }

        return res.json({
            success: true,
            data: { users: (users || []).map(u => ({ ...formatUser(u), friendshipStatus: friendshipMap[u.id] || 'none' })) }
        });
    } catch (e) {
        console.error('[Friends GET /search]', e.message);
        return res.status(500).json({ success: false, message: 'Search failed' });
    }
}));

// ===== SEARCH NEW USERS =====
// P2 FIX: /search/new now shares the same blocked-user exclusion and friendshipStatus
// as /search — previously diverged. Also accepts ?q= alias for query param.
router.get('/search/new', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const query = (req.query.query || req.query.q || '').trim();
        if (!query || query.length < 1) return res.status(400).json({ success: false, message: 'Search query required' });

        const pageNum  = Math.max(1, parseInt(req.query.page)  || 1);
        const limitNum = Math.min(100, parseInt(req.query.limit) || 20);
        const offset   = (pageNum - 1) * limitNum;
        const s = `%${query.toLowerCase()}%`;

        const where = {
            id: { [Op.ne]: userId },
            [Op.or]: [
                Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('username')),  { [Op.like]: s }),
                Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('firstName')), { [Op.like]: s }),
                Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('lastName')),  { [Op.like]: s })
            ]
        };

        // Exclude blocked users (matches /search)
        if (Friend) {
            try {
                const blocks = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }], status: 'blocked' },
                    attributes: ['requesterId', 'receiverId'], raw: true, limit: 200
                }));
                const blockedIds = blocks.map(b => {
                    const r = parseInt(b.requesterId || b.requester_id);
                    const rc = parseInt(b.receiverId || b.receiver_id);
                    return r === parseInt(userId) ? rc : r;
                }).filter(Boolean);
                if (blockedIds.length > 0) where.id = { [Op.ne]: userId, [Op.notIn]: blockedIds };
            } catch (e) { /* non-fatal */ }
        }

        const { count, rows: users } = await withTimeout(User.findAndCountAll({
            where,
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'],
            order: [['username', 'ASC']], offset, limit: limitNum
        }));

        // Attach friendship status
        let fsMap = {};
        if (Friend && users && users.length > 0) {
            try {
                const uids = users.map(u => u.id);
                const rels = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [
                        { requesterId: userId, receiverId: { [Op.in]: uids } },
                        { requesterId: { [Op.in]: uids }, receiverId: userId }
                    ]},
                    attributes: ['requesterId', 'receiverId', 'status'], raw: true
                }));
                rels.forEach(r => {
                    const rid = parseInt(r.requesterId || r.requester_id);
                    const rcid = parseInt(r.receiverId || r.receiver_id);
                    const other = rid === parseInt(userId) ? rcid : rid;
                    let rel = 'none';
                    if (r.status === 'accepted') rel = 'friends';
                    else if (r.status === 'pending') rel = rid === parseInt(userId) ? 'request_sent' : 'request_received';
                    fsMap[other] = rel;
                });
            } catch (e) { /* non-fatal */ }
        }

        return res.json({
            success: true,
            data: {
                users: (users || []).map(u => ({ ...formatUser(u), friendshipStatus: fsMap[u.id] || 'none' })),
                pagination: { total: count, page: pageNum, limit: limitNum, pages: Math.ceil(count / limitNum) }
            }
        });
    } catch (e) {
        console.error('[Friends GET /search/new]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to search users' });
    }
}));

// ===== INCOMING REQUESTS =====
router.get('/incoming', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { requests: [] } });

        const requests = await withTimeout(Friend.findAll({
            where: { receiverId: userId, status: 'pending' },
            include: [
                { 
                    model: User, 
                    as: 'friendRequesterUser',
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                    required: false 
                }
            ],
            order: [['createdAt', 'DESC']], 
            limit: 200
        }));

        const formatted = (requests || []).map(r => ({
            id: r.id,
            senderId: r.requesterId,
            receiverId: r.receiverId,
            status: r.status,
            notes: r.notes,
            createdAt: r.createdAt,
            user: r.friendRequesterUser ? formatUser(r.friendRequesterUser) : null
        }));

        return res.json({ success: true, data: { requests: formatted } });
    } catch (e) {
        console.error('[Friends GET /incoming]', e.message);
        return res.json({ success: true, data: { requests: [] } });
    }
}));

// ===== SENT REQUESTS =====
router.get('/sent', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { requests: [] } });

        const requests = await withTimeout(Friend.findAll({
            where: { requesterId: userId, status: 'pending' },
            include: [
                { 
                    model: User, 
                    as: 'friendReceiverUser',
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                    required: false 
                }
            ],
            order: [['createdAt', 'DESC']], 
            limit: 200
        }));

        const formatted = (requests || []).map(r => ({
            id: r.id,
            senderId: r.requesterId,
            receiverId: r.receiverId,
            status: r.status,
            notes: r.notes,
            createdAt: r.createdAt,
            user: r.friendReceiverUser ? formatUser(r.friendReceiverUser) : null
        }));

        return res.json({ success: true, data: { requests: formatted } });
    } catch (e) {
        console.error('[Friends GET /sent]', e.message);
        return res.json({ success: true, data: { requests: [] } });
    }
}));

// ===== PENDING (BOTH) =====
router.get('/pending', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { incoming: [], outgoing: [], total: 0 } });

        const [inc, out] = await Promise.all([
            withTimeout(Friend.findAll({ where: { receiverId: userId, status: 'pending' }, include: [{ model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName'], required: false }], limit: 100 })),
            withTimeout(Friend.findAll({ where: { requesterId: userId, status: 'pending' }, include: [{ model: User, as: 'friendReceiverUser', attributes: ['id','username','avatar','firstName','lastName'], required: false }], limit: 100 }))
        ]);

        const incoming = (inc || []).map(r => ({ id: r.id, user: formatUser(r.friendRequesterUser), status: r.status, createdAt: r.createdAt })).filter(r => r.user);
        const outgoing = (out || []).map(r => ({ id: r.id, user: formatUser(r.friendReceiverUser), status: r.status, createdAt: r.createdAt })).filter(r => r.user);

        return res.json({ success: true, data: { incoming, outgoing, total: incoming.length + outgoing.length } });
    } catch (e) {
        console.error('[Friends GET /pending]', e.message);
        return res.json({ success: true, data: { incoming: [], outgoing: [], total: 0 } });
    }
}));

// ===== ACCEPTED FRIENDS =====
router.get('/accepted', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { friends: [], total: 0 } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            attributes: ['requesterId', 'receiverId'], raw: true, limit: 200
        }));

        if (!friendships || !friendships.length) return res.json({ success: true, data: { friends: [], total: 0 } });

        // 🔴 BUG 3 FIX: Handle both camelCase and snake_case from raw queries
        const friendIds = friendships.map(f => {
            const rid = f.requesterId || f.requester_id;
            const rcid = f.receiverId || f.receiver_id;
            return rid === userId ? rcid : rid;
        }).filter(id => id && id !== userId);

        if (!friendIds.length) return res.json({ success: true, data: { friends: [], total: 0 } });

        const friends = await withTimeout(User.findAll({
            where: { id: { [Op.in]: friendIds } },
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'], limit: 200
        }));

        const formattedFriends = (friends || []).map(formatUser);
        return res.json({ success: true, data: { friends: formattedFriends, total: formattedFriends.length } });
    } catch (e) {
        console.error('[Friends GET /accepted]', e.message);
        return res.json({ success: true, data: { friends: [], total: 0 } });
    }
}));

// ===== BLOCKED USERS =====
router.get('/blocked', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { blocked: [], total: 0 } });

        const blockedRelations = await withTimeout(Friend.findAll({
            where: { requesterId: userId, status: 'blocked' },
            attributes: ['requesterId', 'receiverId'], raw: true, limit: 100
        }));

        if (!blockedRelations || !blockedRelations.length) return res.json({ success: true, data: { blocked: [], total: 0 } });

        // 🔴 BUG 3 FIX: Handle both camelCase and snake_case from raw queries
        const blockedIds = blockedRelations.map(f => {
            const rcid = f.receiverId || f.receiver_id;
            return rcid;
        }).filter(id => id && id !== userId);

        if (!blockedIds.length) return res.json({ success: true, data: { blocked: [], total: 0 } });

        const blockedUsers = await withTimeout(User.findAll({
            where: { id: { [Op.in]: blockedIds } },
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'], limit: 100
        }));

        return res.json({ success: true, data: { blocked: (blockedUsers || []).map(formatUser), total: blockedUsers.length } });
    } catch (e) {
        console.error('[Friends GET /blocked]', e.message);
        return res.json({ success: true, data: { blocked: [], total: 0 } });
    }
}));

// ===== PINNED FRIENDS =====
router.get('/pinned', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { friends: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }], isPinned: true },
            include: [
                { model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false },
                { model: User, as: 'friendReceiverUser',  attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false }
            ], limit: 100
        }));

        const friends = (friendships || []).map(f => f.requesterId === userId ? formatUser(f.friendReceiverUser) : formatUser(f.friendRequesterUser)).filter(f => f && f.id);
        return res.json({ success: true, data: { friends } });
    } catch (e) {
        console.error('[Friends GET /pinned]', e.message);
        return res.json({ success: true, data: { friends: [] } });
    }
}));

// ===== MUTED FRIENDS =====
router.get('/muted', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { friends: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }], isMuted: true },
            include: [
                { model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false },
                { model: User, as: 'friendReceiverUser',  attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false }
            ], limit: 100
        }));

        const friends = (friendships || []).map(f => f.requesterId === userId ? formatUser(f.friendReceiverUser) : formatUser(f.friendRequesterUser)).filter(f => f && f.id);
        return res.json({ success: true, data: { friends } });
    } catch (e) {
        console.error('[Friends GET /muted]', e.message);
        return res.json({ success: true, data: { friends: [] } });
    }
}));

// ===== SYNCED CONTACTS =====
router.get('/synced', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { synced: false, contacts: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            include: [
                { model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false },
                { model: User, as: 'friendReceiverUser',  attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false }
            ], limit: 200
        }));

        const contacts = (friendships || []).map(f => f.requesterId === userId ? formatUser(f.friendReceiverUser) : formatUser(f.friendRequesterUser)).filter(f => f && f.id);
        return res.json({ success: true, data: { synced: true, contacts } });
    } catch (e) {
        console.error('[Friends GET /synced]', e.message);
        return res.json({ success: true, data: { synced: false, contacts: [] } });
    }
}));

// ===== CONTACTS SYNCED (ALIAS for frontend that calls /contacts/synced) =====
router.get('/contacts/synced', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { synced: false, contacts: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            include: [
                { model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false },
                { model: User, as: 'friendReceiverUser',  attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'], required: false }
            ], limit: 200
        }));

        const contacts = (friendships || []).map(f => f.requesterId === userId ? formatUser(f.friendReceiverUser) : formatUser(f.friendRequesterUser)).filter(f => f && f.id);
        return res.json({ success: true, data: { synced: true, contacts } });
    } catch (e) {
        console.error('[Friends GET /contacts/synced]', e.message);
        return res.json({ success: true, data: { synced: false, contacts: [] } });
    }
}));

// ===== STATS (MERGED P2 FIX) =====
// Merged original stats (total/online/pinned/muted) with new category analytics
// (categories/snoozed/restricted/pending/blocked). Both fields in one response.
router.get('/stats', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const empty = { total: 0, online: 0, offline: 0, recentlyActive: 0, pinned: 0, muted: 0, pending: 0, blocked: 0, snoozed: 0, restricted: 0, categories: {} };
        if (!Friend) return res.json({ success: true, data: empty });

        const all = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }] },
            attributes: ['requesterId', 'receiverId', 'status', 'category', 'isPinned', 'isMuted', 'snoozedUntil', 'isRestricted'],
            raw: true, limit: 1000
        }));

        if (!all || !all.length) return res.json({ success: true, data: empty });

        const now = new Date();
        const stats = { total: 0, online: 0, offline: 0, recentlyActive: 0, pinned: 0, muted: 0, pending: 0, blocked: 0, snoozed: 0, restricted: 0, categories: {} };
        const friendIds = [];

        all.forEach(f => {
            const rid  = parseInt(f.requesterId || f.requester_id);
            const rcid = parseInt(f.receiverId  || f.receiver_id);
            const otherId = rid === parseInt(userId) ? rcid : rid;

            if (f.status === 'accepted') {
                stats.total++;
                friendIds.push(otherId);
                const cat = f.category || 'friend';
                stats.categories[cat] = (stats.categories[cat] || 0) + 1;
                if (f.isPinned    || f.is_pinned)    stats.pinned++;
                if (f.isMuted     || f.is_muted)     stats.muted++;
                if (f.isRestricted)                  stats.restricted++;
                if (f.snoozedUntil && new Date(f.snoozedUntil) > now) stats.snoozed++;
            } else if (f.status === 'pending') {
                stats.pending++;
            } else if (f.status === 'blocked') {
                stats.blocked++;
            }
        });

        if (friendIds.length) {
            try {
                const users = await withTimeout(User.findAll({ where: { id: { [Op.in]: friendIds } }, attributes: ['id', 'status', 'lastSeen'], limit: 1000 }));
                const ago30 = new Date(Date.now() - 30 * 60 * 1000);
                stats.online         = users.filter(u => u.status === 'online').length;
                stats.offline        = stats.total - stats.online;
                stats.recentlyActive = users.filter(u => u.lastSeen && new Date(u.lastSeen) > ago30).length;
            } catch (_) {}
        }

        return res.json({ success: true, data: stats });
    } catch (e) {
        console.error('[Friends GET /stats]', e.message);
        return res.json({ success: true, data: { total: 0, online: 0, offline: 0, recentlyActive: 0, pinned: 0, muted: 0, pending: 0, blocked: 0, snoozed: 0, restricted: 0, categories: {} } });
    }
}));

// ===== SUGGESTIONS =====
// P1 FIX: Replaced naive "newest users" with a 3-signal ranked algorithm:
//   Signal 1 (weight 0.5): mutual friends (friends-of-friends)
//   Signal 2 (weight 0.3): shared group members
//   Signal 3 (weight 0.2): recency padding when social signals are sparse
router.get('/suggestions', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const maxLimit = Math.min(parseInt(req.query.limit) || 10, 50);
        let excludedIds = new Set([parseInt(userId)]);
        let myFriendIds = new Set();

        // Build exclusion set (existing friends / blocked / pending)
        if (Friend) {
            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }] },
                    attributes: ['requesterId', 'receiverId', 'status'], raw: true, limit: 500
                }));
                friendships.forEach(f => {
                    const rid  = parseInt(f.requesterId  || f.requester_id);
                    const rcid = parseInt(f.receiverId   || f.receiver_id);
                    const otherId = rid === parseInt(userId) ? rcid : rid;
                    excludedIds.add(otherId);
                    if (f.status === 'accepted') myFriendIds.add(otherId);
                });
            } catch (e) { /* non-fatal */ }
        }

        const scoreMap = new Map();
        const getScore = (id) => scoreMap.get(id) || { mutualCount: 0, sharedGroupCount: 0 };

        // Signal 1: friends-of-friends
        if (Friend && myFriendIds.size > 0) {
            try {
                const foF = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: { [Op.in]: [...myFriendIds] }, status: 'accepted' },
                            { receiverId:  { [Op.in]: [...myFriendIds] }, status: 'accepted' }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId'], raw: true, limit: 2000
                }));
                foF.forEach(f => {
                    [parseInt(f.requesterId || f.requester_id), parseInt(f.receiverId || f.receiver_id)].forEach(id => {
                        if (!excludedIds.has(id)) {
                            const s = getScore(id); s.mutualCount++;
                            scoreMap.set(id, s);
                        }
                    });
                });
            } catch (e) { /* non-fatal */ }
        }

        // Signal 2: shared group members
        if (GroupMember) {
            try {
                const myMemberships = await withTimeout(GroupMember.findAll({
                    where: { userId }, attributes: ['groupId'], raw: true, limit: 100
                }));
                const myGroupIds = myMemberships.map(m => parseInt(m.groupId));
                if (myGroupIds.length > 0) {
                    const sharedMembers = await withTimeout(GroupMember.findAll({
                        where: { groupId: { [Op.in]: myGroupIds }, userId: { [Op.notIn]: [...excludedIds] } },
                        attributes: ['userId'], raw: true, limit: 1000
                    }));
                    sharedMembers.forEach(m => {
                        const id = parseInt(m.userId);
                        if (!excludedIds.has(id)) {
                            const s = getScore(id); s.sharedGroupCount++;
                            scoreMap.set(id, s);
                        }
                    });
                }
            } catch (e) { /* non-fatal */ }
        }

        let candidateIds = [...scoreMap.keys()].sort((a, b) => {
            const sa = getScore(a), sb = getScore(b);
            return (sb.mutualCount * 0.5 + sb.sharedGroupCount * 0.3) - (sa.mutualCount * 0.5 + sa.sharedGroupCount * 0.3);
        });

        let suggestions = [];
        if (candidateIds.length > 0) {
            const topIds = candidateIds.slice(0, maxLimit);
            const users = await withTimeout(User.findAll({
                where: { id: { [Op.in]: topIds } },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'bio', 'createdAt']
            }));
            const userMap = new Map(users.map(u => [u.id, u]));
            suggestions = topIds.map(id => userMap.get(id)).filter(Boolean);
        }

        // Signal 3: pad with newest users if not enough social candidates
        if (suggestions.length < maxLimit) {
            const needed = maxLimit - suggestions.length;
            const padExclude = [...excludedIds, ...suggestions.map(u => u.id)];
            try {
                const pad = await withTimeout(User.findAll({
                    where: { id: { [Op.notIn]: padExclude } },
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'bio'],
                    order: [['createdAt', 'DESC']], limit: needed
                }));
                suggestions = [...suggestions, ...pad];
            } catch (e) { /* non-fatal */ }
        }

        const formatted = suggestions.map(u => {
            const base = formatUser(u);
            const s = getScore(u.id);
            return { ...base, mutualFriendCount: s.mutualCount || 0, sharedGroupCount: s.sharedGroupCount || 0 };
        });

        return res.json({ success: true, data: { suggestions: formatted } });
    } catch (e) {
        console.error('[Friends GET /suggestions]', e.message);
        return res.json({ success: true, data: { suggestions: [] } });
    }
}));

// ===== CONTACTS (ALIAS FOR FRIENDS) =====
router.get('/contacts', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { contacts: [] } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            include: [
                { model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false },
                { model: User, as: 'friendReceiverUser',  attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'], required: false }
            ], limit: 200
        }));

        const contacts = (friendships || []).map(f => f.requesterId === userId ? formatUser(f.friendReceiverUser) : formatUser(f.friendRequesterUser)).filter(f => f && f.id);
        return res.json({ success: true, data: { contacts } });
    } catch (e) {
        console.error('[Friends GET /contacts]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch contacts' });
    }
}));

// ===== INVITES =====
router.get('/invites', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        return res.json({ success: true, data: { invites: [], total: 0 } });
    } catch (e) {
        return res.json({ success: true, data: { invites: [], total: 0 } });
    }
}));

// ===== EXPORT =====
router.get('/export', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        let friendsData = [];
        if (Friend) {
            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
                    include: [
                        { model: User, as: 'friendRequesterUser', attributes: ['id','username','firstName','lastName','avatar','status','lastSeen','bio'], required: false },
                        { model: User, as: 'friendReceiverUser',  attributes: ['id','username','firstName','lastName','avatar','status','lastSeen','bio'], required: false }
                    ], limit: 1000
                }));

                friendsData = friendships.map(f => {
                    const friend = f.requesterId === userId ? f.friendReceiverUser : f.friendRequesterUser;
                    return {
                        id: friend?.id,
                        username: friend?.username || '',
                        displayName: [friend?.firstName, friend?.lastName].filter(Boolean).join(' ') || friend?.username,
                        firstName: friend?.firstName || '',
                        lastName: friend?.lastName || '',
                        status: friend?.status || 'offline',
                        lastActive: friend?.lastSeen || null,
                        bio: friend?.bio || ''
                    };
                }).filter(f => f.username);
            } catch (e) { /* non-fatal */ }
        }

        const { format = 'json' } = req.query;
        if (format === 'csv') {
            const fields = ['id','username','firstName','lastName','status','lastActive','bio'];
            const csv = [fields.join(','), ...friendsData.map(f => fields.map(k => `"${(f[k]||'').toString().replace(/"/g,'""')}"`).join(','))].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=friends_${new Date().toISOString().split('T')[0]}.csv`);
            return res.send(csv);
        }

        return res.json({ success: true, data: { exportedAt: new Date().toISOString(), count: friendsData.length, friends: friendsData } });
    } catch (e) {
        console.error('[Friends GET /export]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to export friends' });
    }
}));

// ===== GROUPS FOR USER =====
router.get('/groups/user', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        if (Group && GroupMember) {
            try {
                const memberships = await withTimeout(GroupMember.findAll({
                    where: { userId },
                    include: [{ model: Group, as: 'group', attributes: ['id','name','avatar','description','createdBy','createdAt'] }],
                    limit: 100
                }));
                const groups = memberships.map(m => ({ id: m.group?.id, name: m.group?.name, avatar: m.group?.avatar, description: m.group?.description, role: m.role, joinedAt: m.createdAt })).filter(g => g.id);
                return res.json({ success: true, data: { groups } });
            } catch (e) { /* non-fatal */ }
        }
        return res.json({ success: true, data: { groups: [] } });
    } catch (e) {
        return res.json({ success: true, data: { groups: [] } });
    }
}));

// ===== GET USER BY ID =====
router.get('/user/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const requesterId = getUserId(req);
        if (!requesterId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const targetId = parseId(req.params.userId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const targetUser = await withTimeout(User.findByPk(targetId, { attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'] }));
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

        let friendshipStatus = null;
        if (Friend) {
            try {
                const existing = await withTimeout(Friend.findOne({
                    where: { [Op.or]: [{ requesterId: requesterId, receiverId: targetId }, { requesterId: targetId, receiverId: requesterId }] }
                }));
                friendshipStatus = existing ? existing.status : null;
            } catch (e) { /* non-fatal */ }
        }

        const u = targetUser.toJSON ? targetUser.toJSON() : targetUser;
        return res.json({
            success: true,
            data: {
                user: {
                    id: u.id, username: u.username || '', avatar: u.avatar || null,
                    displayName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username,
                    firstName: u.firstName || '', lastName: u.lastName || '',
                    status: u.status || 'offline', lastActive: u.lastSeen || null, friendshipStatus
                }
            }
        });
    } catch (e) {
        console.error('[Friends GET /user/:userId]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch user' });
    }
}));

// ===== REQUESTS INCOMING (ALIAS) =====
router.get('/requests/incoming', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { requests: [] } });

        const requests = await withTimeout(Friend.findAll({
            where: { receiverId: userId, status: 'pending' },
            include: [{ model: User, as: 'friendRequesterUser', attributes: ['id','username','avatar','firstName','lastName'], required: false }],
            limit: 100, order: [['createdAt', 'DESC']]
        }));

        return res.json({
            success: true,
            data: {
                requests: (requests || []).map(r => ({ id: r.id, senderId: r.requesterId, user: formatUser(r.friendRequesterUser), status: r.status, notes: r.notes, createdAt: r.createdAt })).filter(r => r.user)
            }
        });
    } catch (e) {
        return res.json({ success: true, data: { requests: [] } });
    }
}));

// ===== REQUESTS SENT (ALIAS) =====
router.get('/requests/sent', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { requests: [] } });

        const requests = await withTimeout(Friend.findAll({
            where: { requesterId: userId, status: 'pending' },
            include: [{ model: User, as: 'friendReceiverUser', attributes: ['id','username','avatar','firstName','lastName'], required: false }],
            limit: 100, order: [['createdAt', 'DESC']]
        }));

        return res.json({
            success: true,
            data: {
                requests: (requests || []).map(r => ({ id: r.id, receiverId: r.receiverId, user: formatUser(r.friendReceiverUser), status: r.status, notes: r.notes, createdAt: r.createdAt })).filter(r => r.user)
            }
        });
    } catch (e) {
        return res.json({ success: true, data: { requests: [] } });
    }
}));

// ===== SEND FRIEND REQUEST (BODY) =====
router.post('/requests/send', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const receiverId = parseId(req.body.receiverId || req.body.userId || req.body.targetId);
        if (receiverId === null) return res.status(400).json({ success: false, message: 'receiverId is required' });
        if (receiverId === userId) return res.status(400).json({ success: false, message: 'Cannot send friend request to yourself', code: 'SELF_REQUEST' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const targetUser = await withTimeout(User.findByPk(receiverId, { attributes: ['id', 'username'] }));
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

        const existing = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId }, { requesterId: receiverId, receiverId: userId }] }
        }));

        if (existing) {
            if (existing.status === 'accepted') return res.status(400).json({ success: false, message: 'Already friends with this user' });
            if (existing.status === 'pending') {
                if (existing.receiverId === userId) {
                    existing.status = 'accepted'; existing.acceptedAt = new Date(); existing.updatedAt = new Date();
                    await existing.save();
                    return res.json({ success: true, data: { request: existing }, message: 'Friend request accepted automatically' });
                }
                return res.status(400).json({ success: false, message: 'Friend request already sent' });
            }
            if (existing.status === 'blocked') return res.status(400).json({ success: false, message: 'Cannot send request to blocked user' });
        }

        const friendRequest = await Friend.create({
            requesterId: userId, receiverId, status: 'pending',
            notes:          req.body.note     || null,
            category:       req.body.category || null,
            // P1/P2 FIX: persist fields that the frontend sends but backend was silently dropping
            isBusiness:     req.body.isBusiness     ? true : false,
            requestMessage: req.body.message        ? String(req.body.message).substring(0, 300) : null,
            // P1 FIX: server-side expiresAt for temporary friends
            expiresAt:      (req.body.isTemporary && req.body.duration)
                                ? new Date(Date.now() + (parseInt(req.body.duration) * 1000))
                                : null,
            createdAt: new Date(), updatedAt: new Date()
        });

        // FIX: Emit friend:request to receiver in real-time so their inbox updates immediately.
        // Previously this event was never emitted — the receiver only found out via polling.
        // FIX: Try req.io first, then app.get('io'), then global webSocketService
        // If none are set, the receiver never gets real-time notification.
        const io = req.io || (req.app && req.app.get('io'))
            || (global._wsService && global._wsService.getIO && global._wsService.getIO())
            || null;

        const senderInfo = req.user ? {
            id:          userId,
            username:    req.user.username    || '',
            displayName: req.user.displayName || req.user.username || '',
            avatar:      req.user.avatar      || null,
        } : { id: userId };

        const requestPayload = {
            id:             friendRequest.id,
            requestId:      friendRequest.id,
            requesterId:    userId,
            receiverId:     receiverId,
            status:         'pending',
            createdAt:      friendRequest.createdAt,
            senderName:     senderInfo.displayName,
            senderUsername: senderInfo.username,
            senderAvatar:   senderInfo.avatar,
            user:           senderInfo,
        };

        if (io) {
            // Emit to all room name formats the client may have joined
            io.to(`user:${receiverId}`).emit('friend:request', requestPayload);
            io.to(`user_${receiverId}`).emit('friend:request', requestPayload);
            io.to(`user:${receiverId}`).emit('FRIEND_REQUEST_RECEIVED', requestPayload);
            io.to(`user_${receiverId}`).emit('FRIEND_REQUEST_RECEIVED', requestPayload);
        } else {
            console.warn('[Friends /requests/send] ⚠️  io not available — receiver will not get real-time notification');
        }

        // FIX: Return request data under both field names friend-core.js looks for:
        //   response.data.request  (checked first in friend-core)
        //   response.data          (fallback)
        const _fr = friendRequest.toJSON ? friendRequest.toJSON() : {
            id: friendRequest.id, requesterId: friendRequest.requesterId,
            receiverId: friendRequest.receiverId, status: friendRequest.status,
            createdAt: friendRequest.createdAt
        };
        return res.status(201).json({
            success: true,
            message: 'Friend request sent successfully',
            data: {
                request:    _fr,
                friendRequest: _fr,
            }
        });
    } catch (e) {
        console.error('[Friends POST /requests/send]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to send friend request' });
    }
}));

// ===== ACCEPT FRIEND REQUEST =====
// 🔴 BUG 2 & 4 FIX: Parse requestId as integer and add Socket.IO notifications
router.post('/requests/:requestId/accept', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        // 🔴 BUG 2 FIX: Use integer directly for DB comparison, not string
        const friendRequest = await withTimeout(Friend.findOne({ 
            where: { 
                id: parseId(req.params.requestId), 
                status: 'pending',
                receiverId: userId
            } 
        }));
        
        if (!friendRequest) {
            return res.status(404).json({ success: false, message: 'Friend request not found' });
        }

        friendRequest.status = 'accepted'; 
        friendRequest.acceptedAt = new Date();
        await friendRequest.save();

        // FIX: emit friend:accepted to BOTH room formats (user:ID and user_ID) so that
        // clients are notified regardless of which format their socket joined with.
        // Fetch full profiles for both users so clients can update caches without a round-trip.
        const io = req.io || (req.app && req.app.get('io'));
        if (io) {
            // Fetch accepter profile (current user = receiver)
            let accepterProfile = { id: userId };
            let senderProfile   = { id: friendRequest.requesterId };
            try {
                if (User) {
                    const [accepterUser, senderUser] = await Promise.all([
                        User.findByPk(userId,                  { attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'] }),
                        User.findByPk(friendRequest.requesterId, { attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'] }),
                    ]);
                    if (accepterUser) {
                        const u = accepterUser.toJSON ? accepterUser.toJSON() : accepterUser;
                        accepterProfile = { id: u.id, username: u.username||'', displayName: ([u.firstName,u.lastName].filter(Boolean).join(' ').trim())||u.username||'', avatar: u.avatar||null, status: u.status||'offline', lastSeen: u.lastSeen||null };
                    }
                    if (senderUser) {
                        const u = senderUser.toJSON ? senderUser.toJSON() : senderUser;
                        senderProfile = { id: u.id, username: u.username||'', displayName: ([u.firstName,u.lastName].filter(Boolean).join(' ').trim())||u.username||'', avatar: u.avatar||null, status: u.status||'offline', lastSeen: u.lastSeen||null };
                    }
                }
            } catch (_) { /* non-fatal, use minimal profiles */ }

            // Tell the original SENDER: their request was accepted, new friend = accepter
            const senderPayload = {
                friendshipId: friendRequest.id,
                requestId:    friendRequest.id,
                friendId:     userId,
                acceptedById: userId,
                friendship:   { ...friendRequest.toJSON(), status: 'accepted' },
                user:         accepterProfile,
                friend:       accepterProfile,
                acceptedAt:   new Date().toISOString(),
            };
            // Tell the ACCEPTER's other tabs/devices: sync the new friendship
            const accepterPayload = {
                friendshipId: friendRequest.id,
                requestId:    friendRequest.id,
                friendId:     friendRequest.requesterId,
                acceptedById: userId,
                friendship:   { ...friendRequest.toJSON(), status: 'accepted' },
                user:         senderProfile,
                friend:       senderProfile,
                acceptedAt:   new Date().toISOString(),
            };
            // Emit to both room naming conventions to guarantee delivery
            io.to(`user_${friendRequest.requesterId}`).emit('friend:accepted', senderPayload);
            io.to(`user:${friendRequest.requesterId}`).emit('friend:accepted', senderPayload);
            io.to(`user_${userId}`).emit('friend:accepted', accepterPayload);
            io.to(`user:${userId}`).emit('friend:accepted', accepterPayload);
        }

        // Fetch sender profile for immediate display on the accepter's side
        const _fr2 = friendRequest.toJSON ? friendRequest.toJSON() : { ...friendRequest };
        let senderProfile = { id: _fr2.requesterId };
        try {
            if (User) {
                const _su = await User.findByPk(_fr2.requesterId, {
                    attributes: ['id','username','avatar','firstName','lastName','status','lastSeen']
                });
                if (_su) {
                    const u = _su.toJSON ? _su.toJSON() : _su;
                    senderProfile = {
                        id:          u.id,
                        username:    u.username || '',
                        displayName: ([u.firstName, u.lastName].filter(Boolean).join(' ').trim()) || u.username || '',
                        avatar:      u.avatar   || null,
                        status:      u.status   || 'offline',
                        lastSeen:    u.lastSeen || null
                    };
                }
            }
        } catch (_) {}
        return res.json({
            success: true,
            message: 'Friend request accepted successfully',
            data: {
                friendRequest: _fr2,
                friendship:    _fr2,
                friend:        senderProfile,
                user:          senderProfile,
            }
        });
    } catch (e) {
        console.error('[Friends POST /requests/:id/accept]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to accept friend request' });
    }
}));

// ===== REJECT FRIEND REQUEST =====
router.post('/requests/:requestId/reject', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        // 🔴 BUG 4 FIX: Parse requestId as integer for consistent DB comparison
        const friendRequest = await withTimeout(Friend.findOne({ where: { id: parseId(req.params.requestId), receiverId: userId, status: 'pending' } }));
        if (!friendRequest) return res.status(404).json({ success: false, message: 'Friend request not found' });

        await friendRequest.destroy();
        return res.json({ success: true, message: 'Friend request rejected successfully' });
    } catch (e) {
        console.error('[Friends POST /requests/:id/reject]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to reject friend request' });
    }
}));

// ===== SEND FRIEND REQUEST (URL PARAM) =====
router.post('/request/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const targetId = parseId(req.params.userId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid user ID' });
        if (targetId === userId) return res.status(400).json({ success: false, message: 'Cannot send friend request to yourself', code: 'SELF_REQUEST' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const targetUser = await withTimeout(User.findByPk(targetId, { attributes: ['id', 'username'] }));
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

        // P3 FIX: Enforce receiver's friend-request privacy setting
        const privacyAllowed = await _checkFriendRequestPrivacy(userId, targetId);
        if (!privacyAllowed) {
            return res.status(403).json({ success: false, message: 'This user is not accepting friend requests', code: 'PRIVACY_BLOCKED' });
        }

        const existing = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId }, { requesterId: targetId, receiverId: userId }] }
        }));

        if (existing) {
            if (existing.status === 'accepted') return res.status(400).json({ success: false, message: 'You are already friends with this user' });
            if (existing.status === 'pending') {
                if (existing.requesterId === userId) return res.status(400).json({ success: false, message: 'Friend request already sent' });
                existing.status = 'accepted'; existing.acceptedAt = new Date(); await existing.save();
                return res.json({ success: true, data: { friendship: existing }, message: 'Friend request accepted automatically' });
            }
            if (existing.status === 'blocked') return res.status(400).json({ success: false, message: 'Cannot send friend request to blocked user' });
        }

        const friendRequest = await Friend.create({ requesterId: userId, receiverId: targetId, status: 'pending', createdAt: new Date(), updatedAt: new Date() });
        return res.status(201).json({
            success: true,
            data: { request: { id: friendRequest.id, requesterId: friendRequest.requesterId, receiverId: friendRequest.receiverId, status: friendRequest.status, createdAt: friendRequest.createdAt } },
            message: 'Friend request sent successfully'
        });
    } catch (e) {
        console.error('[Friends POST /request/:userId]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to send friend request' });
    }
}));

// ===== PRIVATE NOTES (P1 FIX) =====
// The notes column existed in DB but was only written to localStorage.
// These endpoints let the frontend dual-write (localStorage + DB) so notes
// survive device switches and incognito sessions.
router.get('/:friendId/notes', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const friendId = parseId(req.params.friendId);
        if (!friendId) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        if (!Friend) return res.json({ success: true, data: { notes: '' } });

        const record = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: friendId }, { requesterId: friendId, receiverId: userId }], status: 'accepted' },
            attributes: ['notes']
        }));
        return res.json({ success: true, data: { notes: record?.notes || '' } });
    } catch (e) {
        console.error('[Friends GET /:friendId/notes]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to get notes' });
    }
}));

router.put('/:friendId/notes', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const friendId = parseId(req.params.friendId);
        if (!friendId) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        const notes = (req.body.notes || '').substring(0, 200);
        if (!Friend) return res.status(503).json({ success: false, message: 'Service unavailable' });

        const record = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: friendId }, { requesterId: friendId, receiverId: userId }], status: 'accepted' }
        }));
        if (!record) return res.status(404).json({ success: false, message: 'Friendship not found' });

        record.notes = notes || null;
        record.updatedAt = new Date();
        await record.save();
        return res.json({ success: true, data: { notes: record.notes } });
    } catch (e) {
        console.error('[Friends PUT /:friendId/notes]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to save notes' });
    }
}));

// ===== REPORT FRIEND (P2 FIX) =====
// Frontend showed "Report" but there was no backend route — reports silently failed.
router.post('/:friendId/report', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const reportedId = parseId(req.params.friendId);
        if (!reportedId) return res.status(400).json({ success: false, message: 'Invalid user ID' });

        const reason      = (req.body.reason      || 'other').substring(0, 100);
        const description = (req.body.description || '').substring(0, 500);

        // Log server-side — a full FriendReport model can be added in a future phase.
        console.warn('[FriendReport]', { reporterId: userId, reportedId, reason, description, ts: new Date().toISOString() });

        // Emit to admins if socket available
        if (global._wsService?.getIO) {
            try { global._wsService.getIO().to('admin:reports').emit('new_report', { reporterId: userId, reportedId, reason }); } catch (_) {}
        }

        return res.json({ success: true, message: 'Report submitted. Our team will review it.' });
    } catch (e) {
        console.error('[Friends POST /:friendId/report]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to submit report' });
    }
}));

// ===== SNOOZE FRIEND (P3 FIX) =====
// Temporarily hide a friend from the active list for N days without unfriending.
router.post('/:friendId/snooze', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const friendId = parseId(req.params.friendId);
        if (!friendId) return res.status(400).json({ success: false, message: 'Invalid friend ID' });

        // days: 1, 3, 7, 14, 30  — default 7
        const days = Math.min(30, Math.max(1, parseInt(req.body.days) || 7));

        if (!Friend) return res.status(503).json({ success: false, message: 'Service unavailable' });
        const record = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: friendId }, { requesterId: friendId, receiverId: userId }], status: 'accepted' }
        }));
        if (!record) return res.status(404).json({ success: false, message: 'Friendship not found' });

        record.snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        record.updatedAt = new Date();
        await record.save();

        return res.json({ success: true, data: { snoozedUntil: record.snoozedUntil, days } });
    } catch (e) {
        console.error('[Friends POST /:friendId/snooze]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to snooze friend' });
    }
}));

router.delete('/:friendId/snooze', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const friendId = parseId(req.params.friendId);
        if (!friendId) return res.status(400).json({ success: false, message: 'Invalid friend ID' });

        if (!Friend) return res.status(503).json({ success: false, message: 'Service unavailable' });
        const record = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: friendId }, { requesterId: friendId, receiverId: userId }], status: 'accepted' }
        }));
        if (!record) return res.status(404).json({ success: false, message: 'Friendship not found' });

        record.snoozedUntil = null;
        record.updatedAt = new Date();
        await record.save();
        return res.json({ success: true, message: 'Friend unsnoozed' });
    } catch (e) {
        console.error('[Friends DELETE /:friendId/snooze]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to unsnooze friend' });
    }
}));

// ===== RESTRICT FRIEND (P3 FIX) =====
// Restricted friends can see public posts but not private ones — no notification sent.
router.post('/:friendId/restrict', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const friendId = parseId(req.params.friendId);
        if (!friendId) return res.status(400).json({ success: false, message: 'Invalid friend ID' });

        if (!Friend) return res.status(503).json({ success: false, message: 'Service unavailable' });
        const record = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: friendId }, { requesterId: friendId, receiverId: userId }], status: 'accepted' }
        }));
        if (!record) return res.status(404).json({ success: false, message: 'Friendship not found' });

        record.isRestricted = true;
        record.updatedAt = new Date();
        await record.save();
        return res.json({ success: true, message: 'Friend restricted' });
    } catch (e) {
        console.error('[Friends POST /:friendId/restrict]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to restrict friend' });
    }
}));

router.delete('/:friendId/restrict', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const friendId = parseId(req.params.friendId);
        if (!friendId) return res.status(400).json({ success: false, message: 'Invalid friend ID' });

        if (!Friend) return res.status(503).json({ success: false, message: 'Service unavailable' });
        const record = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: friendId }, { requesterId: friendId, receiverId: userId }], status: 'accepted' }
        }));
        if (!record) return res.status(404).json({ success: false, message: 'Friendship not found' });

        record.isRestricted = false;
        record.updatedAt = new Date();
        await record.save();
        return res.json({ success: true, message: 'Friend unrestricted' });
    } catch (e) {
        console.error('[Friends DELETE /:friendId/restrict]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to unrestrict friend' });
    }
}));



// ===== CSV EXPORT (P3 FIX) =====
// Export friend list as CSV — basic privacy: only includes data the user owns.
router.get('/export/csv', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend || !User) return res.status(503).json({ success: false, message: 'Service unavailable' });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }], status: 'accepted' },
            attributes: ['requesterId', 'receiverId', 'category', 'notes', 'acceptedAt', 'closenessLevel', 'isBusiness', 'expiresAt'],
            raw: true
        }));

        const friendIds = friendships.map(f => {
            const rid = parseInt(f.requesterId || f.requester_id);
            return rid === parseInt(userId) ? parseInt(f.receiverId || f.receiver_id) : rid;
        }).filter(Boolean);

        const users = friendIds.length > 0
            ? await withTimeout(User.findAll({ where: { id: { [Op.in]: friendIds } }, attributes: ['id', 'username', 'firstName', 'lastName', 'status'], raw: true }))
            : [];

        const userMap = new Map(users.map(u => [u.id, u]));

        const escape = (v) => {
            if (v == null) return '';
            const s = String(v);
            return s.includes(',') || s.includes('"') || s.includes('
') ? `"${s.replace(/"/g, '""')}"` : s;
        };

        const rows = [['Username', 'First Name', 'Last Name', 'Category', 'Business Contact', 'Friends Since', 'Closeness Level', 'Notes']];
        friendships.forEach(f => {
            const rid = parseInt(f.requesterId || f.requester_id);
            const friendId = rid === parseInt(userId) ? parseInt(f.receiverId || f.receiver_id) : rid;
            const u = userMap.get(friendId);
            if (!u) return;
            rows.push([
                escape(u.username), escape(u.firstName), escape(u.lastName),
                escape(f.category || 'friend'), escape(f.isBusiness ? 'Yes' : 'No'),
                escape(f.acceptedAt ? new Date(f.acceptedAt).toISOString().split('T')[0] : ''),
                escape(f.closenessLevel || 0), escape(f.notes || '')
            ]);
        });

        const csv = rows.map(r => r.join(',')).join('
');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="friends-${userId}-${Date.now()}.csv"`);
        return res.send(csv);
    } catch (e) {
        console.error('[Friends GET /export/csv]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to export' });
    }
}));

// ===== PHONE CONTACTS MATCHING (P2 FIX) =====
// Frontend sends hashed phone numbers; backend finds matching users.
// Phones are hashed client-side with SHA-256 before sending (never send raw numbers).
router.post('/contacts/match', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { phoneHashes } = req.body;
        if (!Array.isArray(phoneHashes) || phoneHashes.length === 0)
            return res.status(400).json({ success: false, message: 'phoneHashes array required' });

        // Limit to 200 contacts per call to prevent abuse
        const hashes = phoneHashes.slice(0, 200).map(h => String(h).toLowerCase().trim());

        if (!User) return res.json({ success: true, data: { matches: [] } });

        // Users must have opted in to phone-based discovery (phone_discoverable = true)
        // For now we match on hashed_phone column if it exists; fall back to empty.
        const matchedUsers = await withTimeout(User.findAll({
            where: {
                id: { [Op.ne]: userId },
                hashedPhone: { [Op.in]: hashes }
            },
            attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status'],
            limit: 200
        })).catch(() => []);

        // Exclude already-friends and blocked
        let excludedIds = new Set();
        if (Friend && matchedUsers.length > 0) {
            try {
                const rels = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }] },
                    attributes: ['requesterId', 'receiverId'], raw: true, limit: 500
                }));
                rels.forEach(f => {
                    const r = parseInt(f.requesterId || f.requester_id);
                    const rc = parseInt(f.receiverId || f.receiver_id);
                    excludedIds.add(r === parseInt(userId) ? rc : r);
                });
            } catch (_) {}
        }

        const matches = matchedUsers
            .filter(u => !excludedIds.has(u.id))
            .map(u => ({ ...formatUser(u), source: 'phone_contact' }));

        return res.json({ success: true, data: { matches, total: matches.length } });
    } catch (e) {
        console.error('[Friends POST /contacts/match]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to match contacts' });
    }
}));

// ===== PRIVACY SETTINGS (P3 FIX) =====
// GET/PUT friend-specific privacy: who can send requests, who can see my friends list.
router.get('/privacy', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const Settings = User?.sequelize?.models?.Settings || null;
        if (!Settings) return res.json({ success: true, data: { whoCanSendFriendRequests: 'everyone', whoCanSeeMyFriends: 'everyone', anniversaryNotifications: true } });

        const settings = await withTimeout(Settings.findOne({ where: { userId }, attributes: ['privacy'] }));
        const privacy = settings?.privacy || {};

        return res.json({
            success: true,
            data: {
                whoCanSendFriendRequests: privacy.whoCanSendFriendRequests || 'everyone',
                whoCanSeeMyFriends:       privacy.whoCanSeeMyFriends       || 'everyone',
                anniversaryNotifications: privacy.anniversaryNotifications !== false
            }
        });
    } catch (e) {
        console.error('[Friends GET /privacy]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to get privacy settings' });
    }
}));

router.put('/privacy', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const allowed = ['everyone', 'friends_of_friends', 'nobody'];
        const whoCanSend  = allowed.includes(req.body.whoCanSendFriendRequests) ? req.body.whoCanSendFriendRequests : null;
        const whoCanSee   = allowed.includes(req.body.whoCanSeeMyFriends)       ? req.body.whoCanSeeMyFriends       : null;
        const anniversary = req.body.anniversaryNotifications != null ? Boolean(req.body.anniversaryNotifications) : null;

        const Settings = User?.sequelize?.models?.Settings || null;
        if (!Settings) return res.status(503).json({ success: false, message: 'Settings service unavailable' });

        let settings = await withTimeout(Settings.findOne({ where: { userId } }));
        if (!settings) return res.status(404).json({ success: false, message: 'Settings not found' });

        const privacy = { ...(settings.privacy || {}) };
        if (whoCanSend  !== null) privacy.whoCanSendFriendRequests = whoCanSend;
        if (whoCanSee   !== null) privacy.whoCanSeeMyFriends       = whoCanSee;
        if (anniversary !== null) privacy.anniversaryNotifications  = anniversary;

        settings.privacy = privacy;
        settings.changed('privacy', true); // force JSONB dirty
        await settings.save();

        return res.json({ success: true, data: privacy });
    } catch (e) {
        console.error('[Friends PUT /privacy]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to update privacy settings' });
    }
}));

// ===== ENFORCE FRIEND-REQUEST PRIVACY (P3 FIX) =====
// Middleware-style helper called inside the send-request route to check privacy settings.
// (Injected into the send-request handler below via the _checkFriendRequestPrivacy helper)
async function _checkFriendRequestPrivacy(senderId, receiverId) {
    try {
        const Settings = User?.sequelize?.models?.Settings;
        if (!Settings) return true; // no settings table yet — allow

        const receiverSettings = await withTimeout(Settings.findOne({ where: { userId: receiverId }, attributes: ['privacy'] }));
        const privacy = receiverSettings?.privacy || {};
        const policy  = privacy.whoCanSendFriendRequests || 'everyone';

        if (policy === 'nobody') return false;
        if (policy === 'everyone') return true;

        if (policy === 'friends_of_friends') {
            // Check if sender is a friend-of-a-friend of receiver
            const receiverFriends = await withTimeout(Friend.findAll({
                where: { [Op.or]: [{ requesterId: receiverId }, { receiverId: receiverId }], status: 'accepted' },
                attributes: ['requesterId', 'receiverId'], raw: true, limit: 500
            }));
            const receiverFriendIds = new Set(receiverFriends.map(f => {
                const r = parseInt(f.requesterId || f.requester_id);
                return r === parseInt(receiverId) ? parseInt(f.receiverId || f.receiver_id) : r;
            }));
            // Is sender a friend of any of receiver's friends?
            if (receiverFriendIds.has(parseInt(senderId))) return true; // direct friend (shouldn't happen here)
            const senderFriends = await withTimeout(Friend.findAll({
                where: { [Op.or]: [{ requesterId: senderId }, { receiverId: senderId }], status: 'accepted' },
                attributes: ['requesterId', 'receiverId'], raw: true, limit: 500
            }));
            const senderFriendIds = new Set(senderFriends.map(f => {
                const r = parseInt(f.requesterId || f.requester_id);
                return r === parseInt(senderId) ? parseInt(f.receiverId || f.receiver_id) : r;
            }));
            // Intersection of senderFriendIds and receiverFriendIds > 0 → friends of friends
            for (const id of senderFriendIds) {
                if (receiverFriendIds.has(id)) return true;
            }
            return false;
        }
        return true;
    } catch (_) {
        return true; // fail open
    }
}

// ===== QR CODE FRIEND REQUEST =====
// Accept fr
// Accept friend request by QR code token
router.post('/qr/connect', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { token, targetUserId } = req.body;
        if (!token && !targetUserId) return res.status(400).json({ success: false, message: 'Token or targetUserId required' });

        let targetId = parseInt(targetUserId);

        // If token is provided, decode it to get the target user ID
        // QR token format from front-end: base64 encoded JSON with userId
        if (token && !targetUserId) {
            try {
                const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
                targetId = parseInt(decoded.userId || decoded.id);
            } catch (e) {
                return res.status(400).json({ success: false, message: 'Invalid QR token' });
            }
        }

        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid target user ID' });
        if (targetId === userId) return res.status(400).json({ success: false, message: 'Cannot connect to yourself' });

        const targetUser = await withTimeout(User.findByPk(targetId, { attributes: ['id', 'username'] }));
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const existing = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId }, { requesterId: targetId, receiverId: userId }] }
        }));

        if (existing) {
            if (existing.status === 'accepted') return res.json({ success: true, message: 'Already friends', data: { alreadyFriends: true } });
            if (existing.status === 'pending') {
                existing.status = 'accepted'; existing.acceptedAt = new Date(); await existing.save();
                return res.json({ success: true, message: 'Friend request accepted via QR', data: { friendship: existing } });
            }
            if (existing.status === 'blocked') return res.status(400).json({ success: false, message: 'Cannot connect to blocked user' });
        }

        const friendRequest = await Friend.create({ requesterId: userId, receiverId: targetId, status: 'pending', createdAt: new Date(), updatedAt: new Date() });
        return res.status(201).json({ success: true, message: 'Friend request sent via QR', data: { request: friendRequest } });
    } catch (e) {
        console.error('[Friends POST /qr/connect]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to connect via QR' });
    }
}));

// ========================================================
// WILDCARD ROUTES — MUST BE LAST
// ========================================================

// ===== BLOCK USER /:friendId/block =====
router.post('/:friendId/block', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid user ID' });
        if (targetId === userId) return res.status(400).json({ success: false, message: 'Cannot block yourself' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        let friendship = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId }, { requesterId: targetId, receiverId: userId }] }
        }));

        if (friendship) {
            friendship.status = 'blocked'; friendship.blockedAt = new Date();
            // Normalize so blocker is always requester
            friendship.requesterId = userId; friendship.receiverId = targetId;
            await friendship.save();
        } else {
            friendship = await Friend.create({ requesterId: userId, receiverId: targetId, status: 'blocked', blockedAt: new Date() });
        }

        return res.json({ success: true, data: { friendship }, message: 'User blocked successfully' });
    } catch (e) {
        console.error('[Friends POST /:id/block]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to block user' });
    }
}));

// ===== UNBLOCK USER =====
router.post('/:friendId/unblock', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid user ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendship = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'blocked' }, { requesterId: targetId, receiverId: userId, status: 'blocked' }] }
        }));

        if (!friendship) return res.status(404).json({ success: false, message: 'Blocked user not found' });

        await friendship.destroy();
        return res.json({ success: true, message: 'User unblocked successfully' });
    } catch (e) {
        console.error('[Friends POST /:id/unblock]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to unblock user' });
    }
}));

// ===== PIN FRIEND =====
router.post('/:friendId/pin', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendship = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
        }));

        if (!friendship) return res.status(404).json({ success: false, message: 'Friend not found' });
        friendship.isPinned = true; await friendship.save();
        return res.json({ success: true, message: 'Friend pinned successfully' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to pin friend' });
    }
}));

// ===== UNPIN FRIEND =====
router.post('/:friendId/unpin', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendship = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
        }));

        if (!friendship) return res.status(404).json({ success: false, message: 'Friend not found' });
        friendship.isPinned = false; await friendship.save();
        return res.json({ success: true, message: 'Friend unpinned successfully' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to unpin friend' });
    }
}));

// ===== MUTE FRIEND =====
router.post('/:friendId/mute', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        const { duration = 30 } = req.body;
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendship = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
        }));

        if (!friendship) return res.status(404).json({ success: false, message: 'Friend not found' });
        friendship.isMuted = true; friendship.mutedUntil = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
        await friendship.save();
        return res.json({ success: true, data: { mutedUntil: friendship.mutedUntil }, message: `Friend muted for ${duration} days` });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to mute friend' });
    }
}));

// ===== UNMUTE FRIEND =====
router.post('/:friendId/unmute', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendship = await withTimeout(Friend.findOne({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
        }));

        if (!friendship) return res.status(404).json({ success: false, message: 'Friend not found' });
        friendship.isMuted = false; friendship.mutedUntil = null; await friendship.save();
        return res.json({ success: true, message: 'Friend unmuted successfully' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to unmute friend' });
    }
}));

// ===== CANCEL SENT FRIEND REQUEST =====
// FIX: This route was missing. Frontend calls DELETE /api/friends/requests/:requestId
// but no handler existed — every cancel attempt returned 404, leaving DB records stale.
router.delete('/requests/:requestId', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const requestId = parseId(req.params.requestId);
        if (requestId === null) return res.status(400).json({ success: false, message: 'Invalid request ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        // Only the original sender (requesterId) may cancel their own pending request
        const friendRequest = await withTimeout(Friend.findOne({
            where: { id: requestId, requesterId: userId, status: 'pending' }
        }));

        if (!friendRequest) {
            return res.status(404).json({
                success: false,
                message: 'Pending friend request not found or not authorized to cancel'
            });
        }

        const receiverId = friendRequest.receiverId;
        await friendRequest.destroy();

        // Notify receiver so their "Incoming Requests" list clears immediately
        const io = req.io || (req.app && req.app.get('io'));
        if (io) {
            const cancelPayload = { requestId, senderId: userId, receiverId, cancelled: true, timestamp: new Date().toISOString() };
            io.to(`user:${receiverId}`).emit('friend:rejected', cancelPayload);
            io.to(`user_${receiverId}`).emit('friend:rejected', cancelPayload);
        }

        return res.json({ success: true, message: 'Friend request cancelled successfully' });
    } catch (e) {
        console.error('[Friends DELETE /requests/:requestId]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel friend request' });
    }
}));

// ===== REMOVE FRIEND (DELETE) =====
router.delete('/:friendId', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const targetId = parseId(req.params.friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
        }));

        if (!friendships.length) return res.status(404).json({ success: false, message: 'Friend not found' });

        await Promise.all(friendships.map(f => f.destroy()));

        // FIX: Emit friend:removed to BOTH users so both clients update their lists in real-time.
        // Previously only the initiator's optimistic update was used — the removed user's client
        // never received a socket event and kept showing the removed person as a friend.
        const io = req.io || (req.app && req.app.get('io'));
        if (io) {
            // Tell the removed friend that userId removed them
            const removedPayload   = { friendId: userId,   removedBy: userId };
            // Tell the initiator's other tabs/devices that targetId was removed
            const initiatorPayload = { friendId: targetId, removedBy: userId };

            io.to(`user:${targetId}`).emit('friend:removed', removedPayload);
            io.to(`user_${targetId}`).emit('friend:removed', removedPayload);
            io.to(`user:${userId}`).emit('friend:removed', initiatorPayload);
            io.to(`user_${userId}`).emit('friend:removed', initiatorPayload);
        }

        return res.json({ success: true, message: 'Friend removed successfully' });
    } catch (e) {
        console.error('[Friends DELETE /:friendId]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to remove friend' });
    }
}));

// ===== GET FRIEND DETAILS /:friendId — MUST BE LAST GET =====
router.get('/:friendId', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { friendId } = req.params;
        const targetId = parseId(friendId);
        if (targetId === null) return res.status(400).json({ success: false, message: 'Invalid friend ID' });

        const friend = await withTimeout(User.findByPk(targetId, { attributes: ['id','username','avatar','firstName','lastName','bio','status','lastSeen'] }));
        if (!friend) return res.status(404).json({ success: false, message: 'User not found' });

        let isFriend = false, friendship = null;
        if (Friend) {
            try {
                friendship = await withTimeout(Friend.findOne({
                    where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
                }));
                isFriend = !!friendship;
            } catch (e) { /* non-fatal */ }
        }

        if (!isFriend) return res.status(400).json({ success: false, message: 'This user is not in your friends list' });

        return res.json({
            success: true,
            data: {
                friend: formatUser(friend),
                friendship: friendship ? { id: friendship.id, isPinned: friendship.isPinned || false, isMuted: friendship.isMuted || false, mutedUntil: friendship.mutedUntil || null, createdAt: friendship.createdAt, acceptedAt: friendship.acceptedAt } : null
            }
        });
    } catch (e) {
        console.error('[Friends GET /:friendId]', e.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch friend details' });
    }
}));

module.exports = router;