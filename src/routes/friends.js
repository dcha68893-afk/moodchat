const path = require('path');
const express = require('express');
const router = express.Router();

// ===== SAFE MODEL IMPORT =====
let db, User, Friend, Chat, Message, Call, Group, GroupMember, Invite;
try {
    db = require('../models');
    User = db.User || db.Users;
    Friend = db.Friend || db.Friends;
    Chat = db.Chat || db.Chats;
    Message = db.Message || db.Messages;
    Call = db.Call || db.Calls;
    Group = db.Group || db.Groups;
    GroupMember = db.GroupMember || db.GroupMembers;
    Invite = db.Invite || db.Invites;
    console.log('[Friends Route] Models loaded - User:', !!User, 'Friend:', !!Friend, 'Invite:', !!Invite);
} catch (error) {
    console.error('[Friends Route] Error loading models:', error.message);
    db = null;
}

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');

console.log('✅ Friends routes initialized');

// Helper function to format user data
const formatUser = (user) => {
    if (!user) return null;
    const userData = user.toJSON ? user.toJSON() : user;
    const displayName = [userData.firstName, userData.lastName].filter(Boolean).join(' ').trim() || userData.username;
    return {
        id: userData.id,
        username: userData.username || '',
        avatar: userData.avatar || null,
        displayName: displayName,
        firstName: userData.firstName || '',
        lastName: userData.lastName || '',
        bio: userData.bio || '',
        status: userData.status || 'offline',
        lastActive: userData.lastSeen || null
    };
};

// Helper function to get user ID with validation
const getUserId = (req) => {
    if (!req.user) {
        console.error('[Friends] req.user is undefined!');
        return null;
    }
    return req.user.userId || req.user.id;
};

// Helper function to get user with timeout
const withTimeout = (promise, timeoutMs = 5000) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Query timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
    });
};

// ===== SAFE MODEL CHECK MIDDLEWARE =====
const ensureModels = (req, res, next) => {
    if (!User) {
        console.error('[Friends Route] User model not available');
        return res.status(503).json({
            success: false,
            message: 'Service temporarily unavailable',
            code: 'MODEL_UNAVAILABLE'
        });
    }
    next();
};

router.use(ensureModels);

// ===== GET FRIENDS LIST (ALIAS) =====
router.get(
    '/list',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: []
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ]
                    },
                    include: [
                        {
                            model: User,
                            as: 'friendRequesterUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                            required: false
                        },
                        {
                            model: User,
                            as: 'friendReceiverUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                            required: false
                        }
                    ],
                    limit: 200
                }));

                const friends = (friendships || []).map(f => {
                    if (f.requesterId === userId) {
                        return formatUser(f.friendReceiverUser);
                    }
                    return formatUser(f.friendRequesterUser);
                }).filter(f => f && f.id);

                return res.json({
                    success: true,
                    data: {
                        friends: friends || []
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Friend table query error:', dbError.message);
                return res.json({
                    success: true,
                    data: {
                        friends: []
                    }
                });
            }
        } catch (error) {
            console.error('Error in friends list endpoint:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch friends list'
            });
        }
    })
);

// ===== PING ENDPOINT (PUBLIC) =====
router.get(
    '/ping',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            return res.json({ 
                success: true, 
                route: "friends", 
                timestamp: new Date().toISOString(),
                status: 'online'
            });
        } catch (error) {
            console.error('Ping error:', error.message);
            return res.status(500).json({ 
                success: false, 
                message: error.message 
            });
        }
    })
);

// ===== GET FRIENDS LIST =====
router.get(
    '/',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            console.log('[Friends] Fetching friends for user:', userId);

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: { friends: [] }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId'],
                    raw: true,
                    limit: 200
                }));

                if (!friendships || friendships.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: { friends: [] }
                    });
                }

                const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId).filter(id => id && id !== userId);

                if (friendIds.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: { friends: [] }
                    });
                }

                const friends = await withTimeout(User.findAll({
                    where: { id: { [Op.in]: friendIds } },
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                    limit: 200
                }));

                const formattedFriends = (friends || []).map(friend => formatUser(friend));

                return res.status(200).json({
                    success: true,
                    data: { friends: formattedFriends }
                });
            } catch (dbError) {
                console.error('[Friends] Database error:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Database error fetching friends'
                });
            }
        } catch (error) {
            console.error('[Friends] Error fetching friends:', error.message);
            return res.status(200).json({
                success: true,
                data: { friends: [] }
            });
        }
    })
);

// ===== GET INCOMING FRIEND REQUESTS =====
router.get(
    '/incoming',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        requests: []
                    }
                });
            }

            try {
                const requests = await withTimeout(Friend.findAll({
                    where: {
                        receiverId: userId,
                        status: 'pending'
                    },
                    include: [{
                        model: User,
                        as: 'friendRequesterUser',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                        required: false
                    }],
                    limit: 100,
                    order: [['createdAt', 'DESC']]
                }));

                const formattedRequests = (requests || []).map(req => ({
                    id: req.id,
                    user: formatUser(req.friendRequesterUser),
                    status: req.status,
                    createdAt: req.createdAt
                })).filter(r => r.user);

                return res.status(200).json({
                    success: true,
                    data: {
                        requests: formattedRequests
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Incoming requests error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        requests: []
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching incoming friend requests:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    requests: []
                }
            });
        }
    })
);

// ===== GET SENT FRIEND REQUESTS =====
router.get(
    '/sent',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        requests: []
                    }
                });
            }

            try {
                const requests = await withTimeout(Friend.findAll({
                    where: {
                        requesterId: userId,
                        status: 'pending'
                    },
                    include: [{
                        model: User,
                        as: 'friendReceiverUser',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                        required: false
                    }],
                    limit: 100,
                    order: [['createdAt', 'DESC']]
                }));

                const formattedRequests = (requests || []).map(req => ({
                    id: req.id,
                    user: formatUser(req.friendReceiverUser),
                    status: req.status,
                    createdAt: req.createdAt
                })).filter(r => r.user);

                return res.status(200).json({
                    success: true,
                    data: {
                        requests: formattedRequests
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Sent requests error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        requests: []
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching sent friend requests:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    requests: []
                }
            });
        }
    })
);

// ===== GET PENDING REQUESTS (BOTH INCOMING AND OUTGOING) =====
router.get(
    '/pending',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        incoming: [],
                        outgoing: [],
                        total: 0
                    }
                });
            }

            try {
                const [incomingRequests, outgoingRequests] = await Promise.all([
                    withTimeout(Friend.findAll({
                        where: { receiverId: userId, status: 'pending' },
                        include: [{
                            model: User,
                            as: 'friendRequesterUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                            required: false
                        }],
                        limit: 100
                    })),
                    withTimeout(Friend.findAll({
                        where: { requesterId: userId, status: 'pending' },
                        include: [{
                            model: User,
                            as: 'friendReceiverUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                            required: false
                        }],
                        limit: 100
                    }))
                ]);

                const formattedIncoming = (incomingRequests || []).map(req => ({
                    id: req.id,
                    user: formatUser(req.friendRequesterUser),
                    status: req.status,
                    createdAt: req.createdAt
                })).filter(r => r.user);

                const formattedOutgoing = (outgoingRequests || []).map(req => ({
                    id: req.id,
                    user: formatUser(req.friendReceiverUser),
                    status: req.status,
                    createdAt: req.createdAt
                })).filter(r => r.user);

                return res.status(200).json({
                    success: true,
                    data: {
                        incoming: formattedIncoming,
                        outgoing: formattedOutgoing,
                        total: formattedIncoming.length + formattedOutgoing.length
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Pending requests error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        incoming: [],
                        outgoing: [],
                        total: 0
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching pending requests:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    incoming: [],
                    outgoing: [],
                    total: 0
                }
            });
        }
    })
);

// ===== GET ACCEPTED FRIENDS =====
router.get(
    '/accepted',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: [],
                        total: 0
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId'],
                    raw: true,
                    limit: 200
                }));

                if (!friendships || friendships.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: {
                            friends: [],
                            total: 0
                        }
                    });
                }

                const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId).filter(id => id && id !== userId);

                if (friendIds.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: {
                            friends: [],
                            total: 0
                        }
                    });
                }

                const friends = await withTimeout(User.findAll({
                    where: { id: { [Op.in]: friendIds } },
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'],
                    limit: 200
                }));

                const formattedFriends = (friends || []).map(friend => formatUser(friend));

                return res.status(200).json({
                    success: true,
                    data: {
                        friends: formattedFriends,
                        total: formattedFriends.length
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Accepted friends error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: [],
                        total: 0
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching accepted friends:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    friends: [],
                    total: 0
                }
            });
        }
    })
);

// ===== GET BLOCKED USERS =====
router.get(
    '/blocked',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        blocked: [],
                        total: 0
                    }
                });
            }

            try {
                const blockedRelations = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'blocked' },
                            { receiverId: userId, status: 'blocked' }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId'],
                    raw: true,
                    limit: 100
                }));

                if (!blockedRelations || blockedRelations.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: {
                            blocked: [],
                            total: 0
                        }
                    });
                }

                const blockedIds = blockedRelations.map(f => f.requesterId === userId ? f.receiverId : f.requesterId).filter(id => id && id !== userId);

                if (blockedIds.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: {
                            blocked: [],
                            total: 0
                        }
                    });
                }

                const blockedUsers = await withTimeout(User.findAll({
                    where: { id: { [Op.in]: blockedIds } },
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                    limit: 100
                }));

                const formattedBlocked = (blockedUsers || []).map(user => formatUser(user));

                return res.status(200).json({
                    success: true,
                    data: {
                        blocked: formattedBlocked,
                        total: formattedBlocked.length
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Blocked users error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        blocked: [],
                        total: 0
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching blocked users:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    blocked: [],
                    total: 0
                }
            });
        }
    })
);

// ===== GET INVITES =====
router.get(
    '/invites',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (Invite) {
                try {
                    const invites = await withTimeout(Invite.findAll({
                        where: {
                            [Op.or]: [
                                { invitedById: userId },
                                { invitedUserId: userId }
                            ]
                        },
                        include: [
                            {
                                model: User,
                                as: 'invitedBy',
                                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                                required: false
                            },
                            {
                                model: User,
                                as: 'invitedUser',
                                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                                required: false
                            }
                        ],
                        limit: 100,
                        order: [['createdAt', 'DESC']]
                    }));

                    const formattedInvites = (invites || []).map(invite => ({
                        id: invite.id,
                        invitedBy: formatUser(invite.invitedBy),
                        invitedUser: formatUser(invite.invitedUser),
                        status: invite.status || 'pending',
                        createdAt: invite.createdAt,
                        expiresAt: invite.expiresAt
                    }));

                    return res.status(200).json({
                        success: true,
                        data: {
                            invites: formattedInvites,
                            total: formattedInvites.length
                        }
                    });
                } catch (inviteError) {
                    console.log('[Friends Route] Invite model query error:', inviteError.message);
                }
            }

            return res.status(200).json({
                success: true,
                data: {
                    invites: [],
                    total: 0,
                    message: 'Invites feature not fully implemented yet'
                }
            });
        } catch (error) {
            console.error('Error fetching invites:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    invites: [],
                    total: 0
                }
            });
        }
    })
);

// ===== SEND FRIEND REQUEST (URL param) =====
router.post(
    '/request/:userId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { userId: targetUserId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(targetUserId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid user ID'
                });
            }

            if (targetId === userId) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot send friend request to yourself',
                    code: 'SELF_REQUEST'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const targetUser = await withTimeout(User.findByPk(targetId, {
                    attributes: ['id', 'username']
                }));
                
                if (!targetUser) {
                    return res.status(404).json({
                        success: false,
                        message: 'User not found'
                    });
                }

                const existingFriendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId },
                            { requesterId: targetId, receiverId: userId }
                        ]
                    }
                }));

                if (existingFriendship) {
                    if (existingFriendship.status === 'accepted') {
                        return res.status(400).json({
                            success: false,
                            message: 'You are already friends with this user'
                        });
                    } else if (existingFriendship.status === 'pending') {
                        if (existingFriendship.requesterId === userId) {
                            return res.status(400).json({
                                success: false,
                                message: 'Friend request already sent'
                            });
                        } else {
                            existingFriendship.status = 'accepted';
                            existingFriendship.acceptedAt = new Date();
                            await existingFriendship.save();
                            
                            return res.status(200).json({
                                success: true,
                                data: {
                                    friendship: existingFriendship
                                },
                                message: 'Friend request accepted automatically'
                            });
                        }
                    } else if (existingFriendship.status === 'blocked') {
                        return res.status(400).json({
                            success: false,
                            message: 'Cannot send friend request to blocked user'
                        });
                    }
                }

                const friendRequest = await Friend.create({
                    requesterId: userId,
                    receiverId: targetId,
                    status: 'pending',
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                return res.status(201).json({
                    success: true,
                    data: {
                        request: {
                            id: friendRequest.id,
                            requesterId: friendRequest.requesterId,
                            receiverId: friendRequest.receiverId,
                            status: friendRequest.status,
                            createdAt: friendRequest.createdAt
                        }
                    },
                    message: 'Friend request sent successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error sending request:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send friend request',
                    code: 'DB_ERROR'
                });
            }
        } catch (error) {
            console.error('Error sending friend request:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to send friend request'
            });
        }
    })
);

// ===== SEND FRIEND REQUEST (body-based) =====
router.post(
    '/requests/send',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const receiverId = parseInt(req.body.receiverId || req.body.userId || req.body.targetId);
            if (isNaN(receiverId)) {
                return res.status(400).json({ success: false, message: 'receiverId is required' });
            }

            if (receiverId === userId) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot send friend request to yourself',
                    code: 'SELF_REQUEST'
                });
            }

            if (!Friend) {
                return res.status(503).json({ success: false, message: 'Friend service temporarily unavailable' });
            }

            try {
                const targetUser = await withTimeout(User.findByPk(receiverId, { attributes: ['id', 'username'] }));
                if (!targetUser) {
                    return res.status(404).json({ success: false, message: 'User not found' });
                }

                const existing = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: receiverId },
                            { requesterId: receiverId, receiverId: userId }
                        ]
                    }
                }));

                if (existing) {
                    if (existing.status === 'accepted') {
                        return res.status(400).json({ success: false, message: 'Already friends with this user' });
                    }
                    if (existing.status === 'pending') {
                        if (existing.receiverId === userId) {
                            existing.status = 'accepted';
                            existing.acceptedAt = new Date();
                            existing.updatedAt = new Date();
                            await existing.save();
                            return res.status(200).json({
                                success: true,
                                data: { request: existing },
                                message: 'Friend request accepted automatically'
                            });
                        }
                        return res.status(400).json({ success: false, message: 'Friend request already sent' });
                    }
                    if (existing.status === 'blocked') {
                        return res.status(400).json({ success: false, message: 'Cannot send request to blocked user' });
                    }
                }

                const friendRequest = await Friend.create({
                    requesterId: userId,
                    receiverId: receiverId,
                    status: 'pending',
                    notes: req.body.note || null,
                    category: req.body.category || null,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                return res.status(201).json({
                    success: true,
                    data: {
                        request: {
                            id: friendRequest.id,
                            requesterId: friendRequest.requesterId,
                            receiverId: friendRequest.receiverId,
                            status: friendRequest.status,
                            createdAt: friendRequest.createdAt
                        }
                    },
                    message: 'Friend request sent successfully'
                });

            } catch (dbError) {
                console.error('[Friends] DB error sending request via /requests/send:', dbError.message);
                return res.status(500).json({ success: false, message: 'Failed to send friend request' });
            }
        } catch (error) {
            console.error('[Friends] Error in /requests/send:', error.message);
            return res.status(500).json({ success: false, message: 'Failed to send friend request' });
        }
    })
);

// ===== ACCEPT FRIEND REQUEST =====
router.post(
    '/requests/:requestId/accept',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { requestId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendRequest = await withTimeout(Friend.findOne({
                    where: {
                        id: requestId,
                        receiverId: userId,
                        status: 'pending'
                    }
                }));

                if (!friendRequest) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend request not found'
                    });
                }

                friendRequest.status = 'accepted';
                friendRequest.acceptedAt = new Date();
                await friendRequest.save();

                // Create chat for the new friends using raw SQL
                const sequelize = req.app.locals.db;
                
                if (sequelize) {
                    try {
                        // Check if chat already exists
                        const existingChat = await sequelize.query(
                            `SELECT c.id FROM chats c
                             JOIN chat_participants cp1 ON cp1."chatId" = c.id AND cp1."userId" = :user1Id
                             JOIN chat_participants cp2 ON cp2."chatId" = c.id AND cp2."userId" = :user2Id
                             WHERE c.type = 'direct' LIMIT 1`,
                            {
                                replacements: { user1Id: userId, user2Id: friendRequest.requesterId },
                                type: sequelize.QueryTypes.SELECT
                            }
                        );

                        let chatId;
                        
                        if (existingChat && existingChat.length > 0) {
                            chatId = existingChat[0].id;
                        } else {
                            // Create new chat
                            const newChat = await sequelize.query(
                                `INSERT INTO chats (type, "createdBy", "createdAt", "updatedAt")
                                 VALUES ('direct', :createdBy, NOW(), NOW())
                                 RETURNING id`,
                                {
                                    replacements: { createdBy: userId },
                                    type: sequelize.QueryTypes.INSERT
                                }
                            );
                            
                            chatId = newChat[0][0].id;
                            
                            // Add participants
                            await sequelize.query(
                                `INSERT INTO chat_participants ("chatId", "userId", "joinedAt", "createdAt", "updatedAt")
                                 VALUES (:chatId, :user1Id, NOW(), NOW(), NOW()),
                                        (:chatId, :user2Id, NOW(), NOW(), NOW())`,
                                {
                                    replacements: { chatId, user1Id: userId, user2Id: friendRequest.requesterId }
                                }
                            );
                        }
                        
                        console.log('[Friends] Chat created/updated for friends:', chatId);
                    } catch (chatError) {
                        console.error('[Friends] Chat creation error (non-critical):', chatError.message);
                    }
                }

                return res.status(200).json({
                    success: true,
                    data: {
                        friendship: friendRequest
                    },
                    message: 'Friend request accepted successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error accepting request:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to accept friend request'
                });
            }
        } catch (error) {
            console.error('Error accepting friend request:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to accept friend request'
            });
        }
    })
);

// ===== REJECT FRIEND REQUEST =====
router.post(
    '/requests/:requestId/reject',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { requestId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendRequest = await withTimeout(Friend.findOne({
                    where: {
                        id: requestId,
                        receiverId: userId,
                        status: 'pending'
                    }
                }));

                if (!friendRequest) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend request not found'
                    });
                }

                await friendRequest.destroy();

                return res.status(200).json({
                    success: true,
                    message: 'Friend request rejected successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error rejecting request:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to reject friend request'
                });
            }
        } catch (error) {
            console.error('Error rejecting friend request:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to reject friend request'
            });
        }
    })
);

// ===== REMOVE FRIEND =====
router.delete(
    '/:friendId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId, status: 'accepted' },
                            { requesterId: targetId, receiverId: userId, status: 'accepted' }
                        ]
                    }
                }));

                if (friendships.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend not found'
                    });
                }

                await Promise.all(friendships.map(f => f.destroy()));

                return res.status(200).json({
                    success: true,
                    message: 'Friend removed successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error removing friend:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to remove friend'
                });
            }
        } catch (error) {
            console.error('Error removing friend:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to remove friend'
            });
        }
    })
);

// ===== BLOCK USER =====
router.post(
    '/:friendId/block',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid user ID'
                });
            }

            if (targetId === userId) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot block yourself'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                let friendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId },
                            { requesterId: targetId, receiverId: userId }
                        ]
                    }
                }));

                if (friendship) {
                    friendship.status = 'blocked';
                    friendship.blockedAt = new Date();
                    await friendship.save();
                } else {
                    friendship = await Friend.create({
                        requesterId: userId,
                        receiverId: targetId,
                        status: 'blocked',
                        blockedAt: new Date()
                    });
                }

                return res.status(200).json({
                    success: true,
                    data: {
                        friendship
                    },
                    message: 'User blocked successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error blocking user:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to block user'
                });
            }
        } catch (error) {
            console.error('Error blocking user:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to block user'
            });
        }
    })
);

// ===== UNBLOCK USER =====
router.post(
    '/:friendId/unblock',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid user ID'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId, status: 'blocked' },
                            { requesterId: targetId, receiverId: userId, status: 'blocked' }
                        ]
                    }
                }));

                if (!friendship) {
                    return res.status(404).json({
                        success: false,
                        message: 'Blocked user not found'
                    });
                }

                await friendship.destroy();

                return res.status(200).json({
                    success: true,
                    message: 'User unblocked successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error unblocking user:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to unblock user'
                });
            }
        } catch (error) {
            console.error('Error unblocking user:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to unblock user'
            });
        }
    })
);

// ===== PIN FRIEND =====
router.post(
    '/:friendId/pin',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId, status: 'accepted' },
                            { requesterId: targetId, receiverId: userId, status: 'accepted' }
                        ]
                    }
                }));

                if (!friendship) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend not found'
                    });
                }

                friendship.isPinned = true;
                await friendship.save();

                return res.status(200).json({
                    success: true,
                    message: 'Friend pinned successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error pinning friend:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to pin friend'
                });
            }
        } catch (error) {
            console.error('Error pinning friend:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to pin friend'
            });
        }
    })
);

// ===== UNPIN FRIEND =====
router.post(
    '/:friendId/unpin',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId, status: 'accepted' },
                            { requesterId: targetId, receiverId: userId, status: 'accepted' }
                        ]
                    }
                }));

                if (!friendship) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend not found'
                    });
                }

                friendship.isPinned = false;
                await friendship.save();

                return res.status(200).json({
                    success: true,
                    message: 'Friend unpinned successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error unpinning friend:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to unpin friend'
                });
            }
        } catch (error) {
            console.error('Error unpinning friend:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to unpin friend'
            });
        }
    })
);

// ===== MUTE FRIEND =====
router.post(
    '/:friendId/mute',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            const { duration = 30 } = req.body;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId, status: 'accepted' },
                            { requesterId: targetId, receiverId: userId, status: 'accepted' }
                        ]
                    }
                }));

                if (!friendship) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend not found'
                    });
                }

                friendship.isMuted = true;
                friendship.mutedUntil = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
                await friendship.save();

                return res.status(200).json({
                    success: true,
                    data: {
                        mutedUntil: friendship.mutedUntil
                    },
                    message: `Friend muted for ${duration} days`
                });
            } catch (dbError) {
                console.error('[Friends] Database error muting friend:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to mute friend'
                });
            }
        } catch (error) {
            console.error('Error muting friend:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to mute friend'
            });
        }
    })
);

// ===== UNMUTE FRIEND =====
router.post(
    '/:friendId/unmute',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { friendId } = req.params;
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            if (!Friend) {
                return res.status(503).json({
                    success: false,
                    message: 'Friend service temporarily unavailable'
                });
            }

            try {
                const friendship = await withTimeout(Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetId, status: 'accepted' },
                            { requesterId: targetId, receiverId: userId, status: 'accepted' }
                        ]
                    }
                }));

                if (!friendship) {
                    return res.status(404).json({
                        success: false,
                        message: 'Friend not found'
                    });
                }

                friendship.isMuted = false;
                friendship.mutedUntil = null;
                await friendship.save();

                return res.status(200).json({
                    success: true,
                    message: 'Friend unmuted successfully'
                });
            } catch (dbError) {
                console.error('[Friends] Database error unmuting friend:', dbError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to unmute friend'
                });
            }
        } catch (error) {
            console.error('Error unmuting friend:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to unmute friend'
            });
        }
    })
);

// ===== GET PINNED FRIENDS =====
router.get(
    '/pinned',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: []
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ],
                        isPinned: true
                    },
                    include: [
                        {
                            model: User,
                            as: 'friendRequesterUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen'],
                            required: false
                        },
                        {
                            model: User,
                            as: 'friendReceiverUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen'],
                            required: false
                        }
                    ],
                    limit: 100
                }));

                const friends = friendships.map(f => {
                    if (f.requesterId === userId) return formatUser(f.friendReceiverUser);
                    return formatUser(f.friendRequesterUser);
                }).filter(f => f && f.id);

                return res.status(200).json({
                    success: true,
                    data: {
                        friends: friends || []
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Pinned friends query error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: []
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching pinned friends:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    friends: []
                }
            });
        }
    })
);

// ===== GET MUTED FRIENDS =====
router.get(
    '/muted',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: []
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ],
                        isMuted: true
                    },
                    include: [
                        {
                            model: User,
                            as: 'friendRequesterUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen'],
                            required: false
                        },
                        {
                            model: User,
                            as: 'friendReceiverUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen'],
                            required: false
                        }
                    ],
                    limit: 100
                }));

                const friends = friendships.map(f => {
                    if (f.requesterId === userId) return formatUser(f.friendReceiverUser);
                    return formatUser(f.friendRequesterUser);
                }).filter(f => f && f.id);

                return res.status(200).json({
                    success: true,
                    data: {
                        friends: friends || []
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Muted friends query error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        friends: []
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching muted friends:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    friends: []
                }
            });
        }
    })
);

// ===== GET SYNCED CONTACTS =====
router.get(
    '/synced',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        synced: false,
                        contacts: []
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ]
                    },
                    include: [
                        {
                            model: User,
                            as: 'friendRequesterUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen'],
                            required: false
                        },
                        {
                            model: User,
                            as: 'friendReceiverUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen'],
                            required: false
                        }
                    ],
                    limit: 200
                }));

                const contacts = friendships.map(f => {
                    if (f.requesterId === userId) return formatUser(f.friendReceiverUser);
                    return formatUser(f.friendRequesterUser);
                }).filter(f => f && f.id);

                return res.status(200).json({
                    success: true,
                    data: {
                        synced: true,
                        contacts: contacts || []
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Synced contacts query error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        synced: false,
                        contacts: []
                    }
                });
            }
        } catch (error) {
            console.error('Error syncing contacts:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    synced: false,
                    contacts: []
                }
            });
        }
    })
);

// ===== GET FRIEND STATISTICS =====
router.get(
    '/stats',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        total: 0,
                        online: 0,
                        offline: 0,
                        recentlyActive: 0,
                        pinned: 0,
                        muted: 0
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ]
                    },
                    attributes: ['requesterId', 'receiverId', 'isPinned', 'isMuted'],
                    raw: true,
                    limit: 500
                }));
                
                if (!friendships || friendships.length === 0) {
                    return res.status(200).json({
                        success: true,
                        data: {
                            total: 0,
                            online: 0,
                            offline: 0,
                            recentlyActive: 0,
                            pinned: 0,
                            muted: 0
                        }
                    });
                }

                const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId).filter(id => id && id !== userId);
                
                let onlineCount = 0;
                let recentlyActiveCount = 0;
                const pinnedCount = friendships.filter(f => f.isPinned).length;
                const mutedCount = friendships.filter(f => f.isMuted).length;
                
                if (friendIds.length > 0) {
                    const friends = await withTimeout(User.findAll({
                        where: { id: { [Op.in]: friendIds } },
                        attributes: ['status', 'lastSeen'],
                        limit: 500
                    }));
                    
                    onlineCount = friends.filter(f => f.status === 'online').length;
                    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
                    recentlyActiveCount = friends.filter(f => f.lastSeen && new Date(f.lastSeen) > thirtyMinutesAgo).length;
                }
                
                return res.status(200).json({
                    success: true,
                    data: {
                        total: friendIds.length,
                        online: onlineCount,
                        offline: friendIds.length - onlineCount,
                        recentlyActive: recentlyActiveCount,
                        pinned: pinnedCount,
                        muted: mutedCount
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Stats query error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        total: 0,
                        online: 0,
                        offline: 0,
                        recentlyActive: 0,
                        pinned: 0,
                        muted: 0
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching friend statistics:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    total: 0,
                    online: 0,
                    offline: 0,
                    recentlyActive: 0,
                    pinned: 0,
                    muted: 0
                }
            });
        }
    })
);

// ===== GET FRIEND SUGGESTIONS =====
router.get(
    '/suggestions',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const { limit = 10 } = req.query;
            const maxLimit = Math.min(parseInt(limit), 50);

            let excludedIds = [userId];
            
            if (Friend) {
                try {
                    const friendships = await withTimeout(Friend.findAll({
                        where: {
                            [Op.or]: [
                                { requesterId: userId },
                                { receiverId: userId }
                            ]
                        },
                        attributes: ['requesterId', 'receiverId'],
                        raw: true,
                        limit: 500
                    }));
                    const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);
                    excludedIds = [...excludedIds, ...friendIds];
                } catch (dbError) {
                    console.log('[Friends Route] Suggestions friend query error:', dbError.message);
                }
            }

            const suggestions = await withTimeout(User.findAll({
                where: {
                    id: {
                        [Op.notIn]: excludedIds
                    }
                },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'bio'],
                limit: maxLimit,
                order: [['createdAt', 'DESC']]
            }));

            const formattedSuggestions = (suggestions || []).map(user => formatUser(user));

            return res.status(200).json({
                success: true,
                data: {
                    suggestions: formattedSuggestions || []
                }
            });
        } catch (error) {
            console.error('Error fetching friend suggestions:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    suggestions: []
                }
            });
        }
    })
);

// ===== GET CONTACTS (ALIAS FOR FRIENDS) =====
router.get(
    '/contacts',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (!Friend) {
                return res.status(200).json({
                    success: true,
                    data: {
                        contacts: []
                    }
                });
            }

            try {
                const friendships = await withTimeout(Friend.findAll({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, status: 'accepted' },
                            { receiverId: userId, status: 'accepted' }
                        ]
                    },
                    include: [
                        {
                            model: User,
                            as: 'friendRequesterUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                            required: false
                        },
                        {
                            model: User,
                            as: 'friendReceiverUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                            required: false
                        }
                    ],
                    limit: 200
                }));

                const contacts = friendships.map(f => {
                    if (f.requesterId === userId) return formatUser(f.friendReceiverUser);
                    return formatUser(f.friendRequesterUser);
                }).filter(f => f && f.id);

                return res.status(200).json({
                    success: true,
                    data: {
                        contacts: contacts || []
                    }
                });
            } catch (dbError) {
                console.log('[Friends Route] Contacts query error:', dbError.message);
                return res.status(200).json({
                    success: true,
                    data: {
                        contacts: []
                    }
                });
            }
        } catch (error) {
            console.error('Error fetching contacts:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch contacts'
            });
        }
    })
);

// ===== SEARCH NEW USERS =====
router.get(
    '/search/new',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const { query, page = 1, limit = 20 } = req.query;

            if (!query || query.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Search query must be at least 2 characters'
                });
            }

            const pageNum = Math.max(1, parseInt(page));
            const limitNum = Math.min(100, parseInt(limit));
            const offset = (pageNum - 1) * limitNum;
            
            let excludedIds = [userId];
            
            if (Friend) {
                try {
                    const friendships = await withTimeout(Friend.findAll({
                        where: {
                            [Op.or]: [
                                { requesterId: userId },
                                { receiverId: userId }
                            ]
                        },
                        attributes: ['requesterId', 'receiverId'],
                        raw: true,
                        limit: 500
                    }));
                    const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);
                    excludedIds = [...excludedIds, ...friendIds];
                } catch (dbError) {
                    console.log('[Friends Route] Search friend query error:', dbError.message);
                }
            }

            const searchRegex = `%${query}%`;

            const { count, rows: users } = await withTimeout(User.findAndCountAll({
                where: {
                    id: { [Op.notIn]: excludedIds },
                    [Op.or]: [
                        { username: { [Op.iLike]: searchRegex } },
                        { firstName: { [Op.iLike]: searchRegex } },
                        { lastName: { [Op.iLike]: searchRegex } }
                    ]
                },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'],
                order: [['username', 'ASC']],
                offset,
                limit: limitNum
            }));

            const formattedUsers = (users || []).map(user => formatUser(user));

            return res.status(200).json({
                success: true,
                data: {
                    users: formattedUsers || [],
                    pagination: {
                        total: count || 0,
                        page: pageNum,
                        limit: limitNum,
                        pages: count ? Math.ceil(count / limitNum) : 0
                    }
                }
            });
        } catch (error) {
            console.error('Error searching users:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to search users'
            });
        }
    })
);

// ===== GET ALL USERS (PAGINATED) =====
router.get(
    '/users/all',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const { limit = 50, page = 1, search } = req.query;
            const pageNum = Math.max(1, parseInt(page));
            const limitNum = Math.min(200, parseInt(limit));
            const offset = (pageNum - 1) * limitNum;
            
            const whereCondition = { id: { [Op.ne]: userId } };
            
            if (search && search.trim().length >= 2) {
                const searchRegex = `%${search}%`;
                whereCondition[Op.or] = [
                    { username: { [Op.iLike]: searchRegex } },
                    { firstName: { [Op.iLike]: searchRegex } },
                    { lastName: { [Op.iLike]: searchRegex } }
                ];
            }

            const { count, rows: users } = await withTimeout(User.findAndCountAll({
                where: whereCondition,
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                limit: limitNum,
                offset,
                order: [['username', 'ASC']]
            }));

            const formattedUsers = (users || []).map(user => formatUser(user));

            res.status(200).json({
                success: true,
                data: {
                    users: formattedUsers || [],
                    pagination: {
                        total: count,
                        page: pageNum,
                        limit: limitNum,
                        pages: Math.ceil(count / limitNum)
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching all users:', error.message);
            res.status(200).json({ 
                success: true, 
                data: {
                    users: []
                } 
            });
        }
    })
);

// ===== EXPORT FRIENDS =====
router.get(
    '/export',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const { format = 'json' } = req.query;

            let friendsData = [];

            if (Friend) {
                try {
                    const friendships = await withTimeout(Friend.findAll({
                        where: {
                            [Op.or]: [
                                { requesterId: userId, status: 'accepted' },
                                { receiverId: userId, status: 'accepted' }
                            ]
                        },
                        include: [
                            { model: User, as: 'friendRequesterUser', attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen', 'bio'], required: false },
                            { model: User, as: 'friendReceiverUser', attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen', 'bio'], required: false }
                        ],
                        limit: 1000
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
                } catch (dbError) {
                    console.log('[Friends Route] Export query error:', dbError.message);
                }
            }

            if (format === 'csv') {
                const fields = ['id', 'username', 'firstName', 'lastName', 'status', 'lastActive', 'bio'];
                const csv = [
                    fields.join(','),
                    ...friendsData.map(friend =>
                        fields.map(field => `"${(friend[field] || '').toString().replace(/"/g, '""')}"`).join(',')
                    )
                ].join('\n');

                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename=friends_${new Date().toISOString().split('T')[0]}.csv`);
                return res.send(csv);
            }

            return res.status(200).json({
                success: true,
                data: {
                    exportedAt: new Date().toISOString(),
                    count: friendsData.length,
                    friends: friendsData
                }
            });
        } catch (error) {
            console.error('Error exporting friends:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to export friends'
            });
        }
    })
);

// ===== GET FRIENDS GROUPS/USER (ALIAS) =====
router.get(
    '/groups/user',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            if (Group && GroupMember) {
                try {
                    const memberships = await withTimeout(GroupMember.findAll({
                        where: { userId: userId },
                        include: [{
                            model: Group,
                            as: 'group',
                            attributes: ['id', 'name', 'avatar', 'description', 'createdBy', 'createdAt']
                        }],
                        limit: 100
                    }));

                    const groups = memberships.map(m => ({
                        id: m.group?.id,
                        name: m.group?.name,
                        avatar: m.group?.avatar,
                        description: m.group?.description,
                        role: m.role,
                        joinedAt: m.createdAt
                    })).filter(g => g.id);

                    return res.status(200).json({
                        success: true,
                        data: {
                            groups: groups
                        }
                    });
                } catch (groupError) {
                    console.log('[Friends Route] Groups query error:', groupError.message);
                }
            }

            return res.status(200).json({
                success: true,
                data: {
                    groups: []
                }
            });
        } catch (error) {
            console.error('Error fetching groups:', error.message);
            return res.status(200).json({
                success: true,
                data: {
                    groups: []
                }
            });
        }
    })
);

// ===== GET USER BY ID =====
router.get(
    '/user/:userId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const requesterId = getUserId(req);
            if (!requesterId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const targetId = parseInt(req.params.userId);
            if (isNaN(targetId)) {
                return res.status(400).json({ success: false, message: 'Invalid user ID' });
            }

            const targetUser = await withTimeout(User.findByPk(targetId, {
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
            }));

            if (!targetUser) {
                return res.status(404).json({ success: false, message: 'User not found' });
            }

            let friendshipStatus = null;
            if (Friend) {
                try {
                    const existing = await withTimeout(Friend.findOne({
                        where: {
                            [Op.or]: [
                                { requesterId: requesterId, receiverId: targetId },
                                { requesterId: targetId, receiverId: requesterId }
                            ]
                        }
                    }));
                    friendshipStatus = existing ? existing.status : null;
                } catch (e) { /* non-fatal */ }
            }

            const u = targetUser.toJSON ? targetUser.toJSON() : targetUser;
            return res.status(200).json({
                success: true,
                data: {
                    user: {
                        id: u.id,
                        username: u.username || '',
                        avatar: u.avatar || null,
                        displayName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username,
                        firstName: u.firstName || '',
                        lastName: u.lastName || '',
                        status: u.status || 'offline',
                        lastActive: u.lastSeen || null,
                        friendshipStatus
                    }
                }
            });
        } catch (error) {
            console.error('[Friends] Error in GET /user/:userId:', error.message);
            return res.status(500).json({ success: false, message: 'Failed to fetch user' });
        }
    })
);

// ===== SEARCH USERS (alias for /search/new) =====
router.get(
    '/search',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }
            const query = (req.query.q || req.query.query || '').trim();
            if (!query || query.length < 2) {
                return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
            }
            const searchRegex = `%${query}%`;
            const users = await withTimeout(User.findAll({
                where: {
                    id: { [Op.ne]: userId },
                    [Op.or]: [
                        { username: { [Op.iLike]: searchRegex } },
                        { firstName: { [Op.iLike]: searchRegex } },
                        { lastName: { [Op.iLike]: searchRegex } }
                    ]
                },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'bio'],
                limit: Math.min(100, parseInt(req.query.limit) || 20),
                order: [['username', 'ASC']]
            }));
            return res.status(200).json({
                success: true,
                data: { users: (users || []).map(u => formatUser(u)) }
            });
        } catch (error) {
            console.error('[Friends] Search error:', error.message);
            return res.status(500).json({ success: false, message: 'Search failed' });
        }
    })
);

// ===== INCOMING REQUESTS ALIAS =====
router.get(
    '/requests/incoming',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }
            if (!Friend) {
                return res.status(200).json({ success: true, data: { requests: [] } });
            }
            const requests = await withTimeout(Friend.findAll({
                where: { receiverId: userId, status: 'pending' },
                include: [{ model: User, as: 'friendRequesterUser', attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'], required: false }],
                limit: 100,
                order: [['createdAt', 'DESC']]
            }));
            const formattedRequests = (requests || []).map(r => ({
                id: r.id,
                senderId: r.requesterId,
                user: formatUser(r.friendRequesterUser),
                status: r.status,
                notes: r.notes,
                createdAt: r.createdAt
            })).filter(r => r.user);
            return res.status(200).json({ success: true, data: { requests: formattedRequests } });
        } catch (error) {
            console.error('[Friends] /requests/incoming error:', error.message);
            return res.status(500).json({ success: false, message: 'Failed to fetch incoming requests' });
        }
    })
);

// ===== SENT REQUESTS ALIAS =====
router.get(
    '/requests/sent',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }
            if (!Friend) {
                return res.status(200).json({ success: true, data: { requests: [] } });
            }
            const requests = await withTimeout(Friend.findAll({
                where: { requesterId: userId, status: 'pending' },
                include: [{ model: User, as: 'friendReceiverUser', attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'], required: false }],
                limit: 100,
                order: [['createdAt', 'DESC']]
            }));
            const formattedRequests = (requests || []).map(r => ({
                id: r.id,
                receiverId: r.receiverId,
                user: formatUser(r.friendReceiverUser),
                status: r.status,
                notes: r.notes,
                createdAt: r.createdAt
            })).filter(r => r.user);
            return res.status(200).json({ success: true, data: { requests: formattedRequests } });
        } catch (error) {
            console.error('[Friends] /requests/sent error:', error.message);
            return res.status(500).json({ success: false, message: 'Failed to fetch sent requests' });
        }
    })
);

// ===== GET FRIEND DETAILS BY ID =====
router.get(
    '/:friendId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }

            const { friendId } = req.params;
            
            const specialStrings = ['pinned', 'muted', 'list', 'ping', 'stats', 'suggestions', 'export', 'blocked', 'search', 'incoming', 'sent', 'synced', 'users', 'all', 'contacts', 'accepted', 'pending', 'requests', 'invites', 'nearby'];
            if (specialStrings.includes(friendId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            const targetId = parseInt(friendId);
            if (isNaN(targetId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid friend ID'
                });
            }

            const friend = await withTimeout(User.findByPk(targetId, {
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen']
            }));

            if (!friend) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            let isFriend = false;
            let friendship = null;
            if (Friend) {
                try {
                    friendship = await withTimeout(Friend.findOne({
                        where: {
                            [Op.or]: [
                                { requesterId: userId, receiverId: targetId, status: 'accepted' },
                                { requesterId: targetId, receiverId: userId, status: 'accepted' }
                            ]
                        }
                    }));
                    isFriend = !!friendship;
                } catch (dbError) {
                    console.log('[Friends Route] Friend check error:', dbError.message);
                    isFriend = false;
                }
            }

            if (!isFriend) {
                return res.status(400).json({
                    success: false,
                    message: 'This user is not in your friends list'
                });
            }

            return res.status(200).json({
                success: true,
                data: {
                    friend: formatUser(friend),
                    friendship: friendship ? {
                        id: friendship.id,
                        isPinned: friendship.isPinned || false,
                        isMuted: friendship.isMuted || false,
                        mutedUntil: friendship.mutedUntil || null,
                        createdAt: friendship.createdAt,
                        acceptedAt: friendship.acceptedAt
                    } : null
                }
            });
        } catch (error) {
            console.error('Error fetching friend details:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch friend details'
            });
        }
    })
);

// ===== NEARBY USERS =====
router.get(
    '/nearby',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const { lat, lng, radius = 5000 } = req.query;

            let excludeIds = [userId];
            if (Friend) {
                try {
                    const friendships = await withTimeout(Friend.findAll({
                        where: {
                            status: 'accepted',
                            [Op.or]: [
                                { requesterId: userId },
                                { receiverId: userId }
                            ]
                        },
                        attributes: ['requesterId', 'receiverId'],
                        raw: true
                    }));
                    friendships.forEach(f => {
                        excludeIds.push(f.requesterId === userId ? f.receiverId : f.requesterId);
                    });
                } catch (e) { /* non-fatal */ }
            }

            let whereClause = { id: { [Op.notIn]: excludeIds } };

            const hasCoords = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
            const userAttrs = User.rawAttributes || {};
            const hasLocationCols = !!(userAttrs.latitude && userAttrs.longitude);

            if (hasCoords && hasLocationCols) {
                const latF = parseFloat(lat);
                const lngF = parseFloat(lng);
                const radM = Math.min(50000, parseInt(radius));
                const radDeg = radM / 111320;
                whereClause.latitude = { [Op.between]: [latF - radDeg, latF + radDeg] };
                whereClause.longitude = { [Op.between]: [lngF - radDeg * 1.5, lngF + radDeg * 1.5] };
            } else {
                whereClause.status = { [Op.in]: ['online', 'away'] };
            }

            const users = await withTimeout(User.findAll({
                where: whereClause,
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'],
                limit: 30,
                order: [['lastSeen', 'DESC']]
            }));

            const formatted = (users || []).map(u => {
                const d = u.toJSON ? u.toJSON() : u;
                return {
                    id: d.id,
                    username: d.username || '',
                    avatar: d.avatar || null,
                    displayName: [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.username,
                    status: d.status || 'offline',
                    lastActive: d.lastSeen || null
                };
            });

            return res.status(200).json({
                success: true,
                data: {
                    users: formatted,
                    count: formatted.length,
                    mode: (hasCoords && hasLocationCols) ? 'location' : 'online'
                }
            });
        } catch (error) {
            console.error('[Friends] Error in GET /nearby:', error.message);
            return res.status(200).json({ success: true, data: { users: [], count: 0, mode: 'none' } });
        }
    })
);

// ===== MODULE EXPORTS - MUST BE AT THE VERY END =====
module.exports = router;