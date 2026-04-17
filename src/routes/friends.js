const path = require('path');
const express = require('express');
const router = express.Router();

// ===== SAFE MODEL IMPORT =====
let db, User, Friend, Chat, Message, Call, Group, GroupMember, Invite;
try {
    db = require('../models');
    // Use proper model access patterns
    User = db.models?.Users || db.User || db.Users;
    Friend = db.models?.Friends || db.Friend || db.Friends;
    Chat = db.models?.Chats || db.Chat || db.Chats;
    Message = db.models?.Messages || db.Message || db.Messages;
    Call = db.models?.Calls || db.Call || db.Calls;
    Group = db.models?.Groups || db.Group || db.Groups;
    GroupMember = db.models?.GroupMembers || db.GroupMember || db.GroupMembers;
    Invite = db.models?.Invites || db.Invite || db.Invites;
    console.log('[Friends Route] Models loaded - User:', !!User, 'Friend:', !!Friend, 'Invite:', !!Invite);
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

// 🔴 BUG 3 FIX: getUserId now always returns integer for consistent DB comparison
const getUserId = (req) => {
    if (!req.user) { 
        console.error('[Friends] req.user is undefined! Auth middleware may not be working');
        return null; 
    }
    const id = req.user.userId || req.user.id;
    // Return as integer for consistent DB comparison
    return id ? parseInt(id, 10) : null;
};

const withTimeout = (promise, timeoutMs = 8000) => {
    let tid;
    const t = new Promise((_, reject) => { tid = setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs); });
    return Promise.race([promise, t]).finally(() => { if (tid) clearTimeout(tid); });
};

const ensureModels = (req, res, next) => {
    if (!User) {
        return res.status(503).json({ success: false, message: 'Service temporarily unavailable', code: 'MODEL_UNAVAILABLE' });
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
router.get('/search/new', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { query, page = 1, limit = 20 } = req.query;
        if (!query || query.trim().length < 1) return res.status(400).json({ success: false, message: 'Search query required' });

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, parseInt(limit));
        const offset = (pageNum - 1) * limitNum;

        const s = `%${query.trim().toLowerCase()}%`;
        const { count, rows: users } = await withTimeout(User.findAndCountAll({
            where: {
                id: { [Op.ne]: userId },
                [Op.or]: [
                    Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('username')),  { [Op.like]: s }),
                    Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('firstName')), { [Op.like]: s }),
                    Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('lastName')),  { [Op.like]: s })
                ]
            },
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'],
            order: [['username', 'ASC']], offset, limit: limitNum
        }));

        return res.json({
            success: true,
            data: {
                users: (users || []).map(formatUser),
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

// ===== STATS =====
router.get('/stats', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        if (!Friend) return res.json({ success: true, data: { total: 0, online: 0, offline: 0, recentlyActive: 0, pinned: 0, muted: 0 } });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, status: 'accepted' }, { receiverId: userId, status: 'accepted' }] },
            attributes: ['requesterId', 'receiverId', 'isPinned', 'isMuted'], raw: true, limit: 500
        }));

        if (!friendships || !friendships.length) return res.json({ success: true, data: { total: 0, online: 0, offline: 0, recentlyActive: 0, pinned: 0, muted: 0 } });

        // 🔴 BUG 3 FIX: Handle both camelCase and snake_case from raw queries
        const friendIds = friendships.map(f => {
            const rid = f.requesterId || f.requester_id;
            const rcid = f.receiverId || f.receiver_id;
            return rid === userId ? rcid : rid;
        }).filter(id => id && id !== userId);

        const pinnedCount = friendships.filter(f => f.isPinned || f.is_pinned).length;
        const mutedCount  = friendships.filter(f => f.isMuted  || f.is_muted).length;

        let onlineCount = 0, recentlyActiveCount = 0;
        if (friendIds.length) {
            const friends = await withTimeout(User.findAll({ where: { id: { [Op.in]: friendIds } }, attributes: ['status', 'lastSeen'], limit: 500 }));
            onlineCount = friends.filter(f => f.status === 'online').length;
            const ago30 = new Date(Date.now() - 30 * 60 * 1000);
            recentlyActiveCount = friends.filter(f => f.lastSeen && new Date(f.lastSeen) > ago30).length;
        }

        return res.json({ success: true, data: { total: friendIds.length, online: onlineCount, offline: friendIds.length - onlineCount, recentlyActive: recentlyActiveCount, pinned: pinnedCount, muted: mutedCount } });
    } catch (e) {
        console.error('[Friends GET /stats]', e.message);
        return res.json({ success: true, data: { total: 0, online: 0, offline: 0, recentlyActive: 0, pinned: 0, muted: 0 } });
    }
}));

// ===== SUGGESTIONS =====
router.get('/suggestions', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const maxLimit = Math.min(parseInt(req.query.limit) || 10, 50);
        let excludedIds = [userId];

        if (Friend) {
            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: { [Op.or]: [{ requesterId: userId }, { receiverId: userId }] },
                    attributes: ['requesterId', 'receiverId'], raw: true, limit: 500
                }));
                friendships.forEach(f => {
                    const rid = f.requesterId || f.requester_id;
                    const rcid = f.receiverId || f.receiver_id;
                    excludedIds.push(rid === userId ? rcid : rid);
                });
            } catch (e) { /* non-fatal */ }
        }

        const suggestions = await withTimeout(User.findAll({
            where: { id: { [Op.notIn]: excludedIds } },
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'bio'],
            limit: maxLimit, order: [['createdAt', 'DESC']]
        }));

        return res.json({ success: true, data: { suggestions: (suggestions || []).map(formatUser) } });
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

        const targetId = parseInt(req.params.userId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid user ID' });

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

        const receiverId = parseInt(req.body.receiverId || req.body.userId || req.body.targetId);
        if (isNaN(receiverId)) return res.status(400).json({ success: false, message: 'receiverId is required' });
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
            notes: req.body.note || null, category: req.body.category || null,
            createdAt: new Date(), updatedAt: new Date()
        });

        return res.status(201).json({
            success: true,
            data: { request: { id: friendRequest.id, requesterId: friendRequest.requesterId, receiverId: friendRequest.receiverId, status: friendRequest.status, createdAt: friendRequest.createdAt } },
            message: 'Friend request sent successfully'
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
                id: parseInt(req.params.requestId), 
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

        // 🔴 BUG 2 FIX: Add Socket.IO notifications to update both users in real-time
        const io = req.io || (req.app && req.app.get('io'));
        if (io) {
            const payload = {
                friendshipId: friendRequest.id,
                friendship: {
                    ...friendRequest.toJSON(),
                    status: 'accepted'
                }
            };
            io.to(`user_${friendRequest.requesterId}`).emit('friend:accepted', payload);
            io.to(`user_${userId}`).emit('friend:accepted', payload);
        }

        return res.json({ success: true, data: { friendship: friendRequest }, message: 'Friend request accepted successfully' });
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
        const friendRequest = await withTimeout(Friend.findOne({ where: { id: parseInt(req.params.requestId), receiverId: userId, status: 'pending' } }));
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

        const targetId = parseInt(req.params.userId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid user ID' });
        if (targetId === userId) return res.status(400).json({ success: false, message: 'Cannot send friend request to yourself', code: 'SELF_REQUEST' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const targetUser = await withTimeout(User.findByPk(targetId, { attributes: ['id', 'username'] }));
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

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

// ===== QR CODE FRIEND REQUEST =====
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

        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid target user ID' });
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

        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid user ID' });
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

        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid user ID' });
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
        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
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
        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
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
        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
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
        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
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

// ===== REMOVE FRIEND (DELETE) =====
router.delete('/:friendId', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
        const targetId = parseInt(req.params.friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid friend ID' });
        if (!Friend) return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });

        const friendships = await withTimeout(Friend.findAll({
            where: { [Op.or]: [{ requesterId: userId, receiverId: targetId, status: 'accepted' }, { requesterId: targetId, receiverId: userId, status: 'accepted' }] }
        }));

        if (!friendships.length) return res.status(404).json({ success: false, message: 'Friend not found' });

        await Promise.all(friendships.map(f => f.destroy()));
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
        const targetId = parseInt(friendId);
        if (isNaN(targetId)) return res.status(400).json({ success: false, message: 'Invalid friend ID' });

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
