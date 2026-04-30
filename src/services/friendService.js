// services/friendService.js
// Version: 3.1.0 - FIXED
// ✅ unfriend() now supports both integer and UUID/string IDs
// ✅ getFriends() always returns accepted friends from BOTH sides of the relationship
// ✅ respondToFriendRequest() correctly resolves the requesterId for caller validation
// ✅ All formatFriend/formatUser helpers consistent

'use strict';

const { Op } = require('sequelize');
const db = require('../models');

const User   = db.User   || db.Users;
const Friend = db.Friend || db.Friends;

// ─── CANONICAL friend normalizer ──────────────────────────────────────────────
const USER_ATTRS = ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'];

function formatUser(user) {
    if (!user) return null;
    const u = user.toJSON ? user.toJSON() : { ...user };
    return {
        id:          u.id,
        username:    u.username    || '',
        avatar:      u.avatar      || null,
        displayName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || '',
        firstName:   u.firstName   || '',
        lastName:    u.lastName    || '',
        status:      u.status      || 'offline',
        lastActive:  u.lastSeen    || null
    };
}

function formatFriend(friendRecord, currentUserId) {
    if (!friendRecord) return null;

    const fr = friendRecord.toJSON ? friendRecord.toJSON() : { ...friendRecord };

    // Determine which side is "the friend"
    // Use loose equality to handle string/int mismatch
    // eslint-disable-next-line eqeqeq
    const isRequester = fr.requesterId == currentUserId;
    const userObj     = isRequester
        ? (fr.friendReceiverUser  || fr.receiverUser  || null)
        : (fr.friendRequesterUser || fr.requesterUser || null);

    const u = userObj
        ? (userObj.toJSON ? userObj.toJSON() : { ...userObj })
        : {};

    const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
                     || u.username
                     || `User ${u.id || ''}`;

    return {
        // canonical cross-module fields
        id:          u.id          || null,
        name:        displayName,
        avatar:      u.avatar      || null,
        status:      u.status      || 'offline',
        lastSeen:    u.lastSeen    || null,
        isOnline:    (u.status === 'online'),

        // extended fields
        username:    u.username    || '',
        displayName: displayName,
        firstName:   u.firstName   || '',
        lastName:    u.lastName    || '',
        lastActive:  u.lastSeen    || null,

        // friendship metadata
        friendshipId:   fr.id,
        addedAt:        fr.acceptedAt  || fr.createdAt || null,
        category:       fr.category    || 'friend',
        isPinned:       !!fr.isPinned,
        isMuted:        !!fr.isMuted,
        closenessLevel: fr.closenessLevel || 0,
    };
}

const FRIEND_INCLUDES = [
    { model: User, as: 'friendRequesterUser', attributes: USER_ATTRS, required: false },
    { model: User, as: 'friendReceiverUser',  attributes: USER_ATTRS, required: false }
];

// ─── service methods ───────────────────────────────────────────────────────────

async function sendFriendRequest(requesterId, receiverId, notes = '') {
    // eslint-disable-next-line eqeqeq
    if (requesterId == receiverId) {
        throw Object.assign(new Error('Cannot send friend request to yourself'), { status: 400 });
    }

    const targetUser = await User.findByPk(receiverId, { attributes: ['id', 'username'] });
    if (!targetUser) {
        throw Object.assign(new Error('User not found'), { status: 404 });
    }

    const existing = await Friend.findOne({
        where: {
            [Op.or]: [
                { requesterId, receiverId },
                { requesterId: receiverId, receiverId: requesterId }
            ]
        }
    });

    if (existing) {
        if (existing.status === 'accepted') {
            throw Object.assign(new Error('Already friends'), { status: 400 });
        }
        if (existing.status === 'pending') {
            // eslint-disable-next-line eqeqeq
            if (existing.requesterId == requesterId) {
                throw Object.assign(new Error('Friend request already sent'), { status: 400 });
            }
            // Reverse pending → auto-accept
            existing.status     = 'accepted';
            existing.acceptedAt = new Date();
            existing.updatedAt  = new Date();
            await existing.save();
            return existing;
        }
        if (existing.status === 'blocked') {
            throw Object.assign(new Error('Cannot send friend request to this user'), { status: 403 });
        }
        if (['rejected', 'removed'].includes(existing.status)) {
            existing.status      = 'pending';
            existing.requesterId = requesterId;
            existing.receiverId  = receiverId;
            existing.notes       = notes || null;
            existing.updatedAt   = new Date();
            await existing.save();
            return existing;
        }
    }

    return Friend.create({
        requesterId,
        receiverId,
        status: 'pending',
        notes:  notes || null,
    });
}

async function respondToFriendRequest(requestId, userId, action) {
    const request = await Friend.findByPk(requestId);
    if (!request) throw Object.assign(new Error('Friend request not found'), { status: 404 });

    // FIX: Use loose equality so string userId matches integer receiverId from DB
    // eslint-disable-next-line eqeqeq
    if (request.receiverId != userId) {
        throw Object.assign(new Error('Not authorized'), { status: 403 });
    }
    if (request.status !== 'pending') {
        throw Object.assign(new Error('Request already handled'), { status: 400 });
    }

    if (action === 'accept') {
        return request.accept();
    } else if (action === 'reject') {
        return request.reject();
    } else {
        throw Object.assign(new Error('Invalid action'), { status: 400 });
    }
}

async function getFriends(userId, status = 'accepted') {
    const rows = await Friend.findAll({
        where: {
            [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
            status,
        },
        include: FRIEND_INCLUDES,
    });

    // De-duplicate by friend userId and apply canonical format
    const seen   = new Set();
    const result = [];
    for (const row of rows) {
        const formatted = formatFriend(row, userId);
        if (formatted && formatted.id && !seen.has(String(formatted.id))) {
            seen.add(String(formatted.id));
            result.push(formatted);
        }
    }
    return result;
}

async function getPendingRequests(userId) {
    const rows = await Friend.findAll({
        where: { receiverId: userId, status: 'pending' },
        include: [{ model: User, as: 'friendRequesterUser', attributes: USER_ATTRS, required: false }],
        order: [['createdAt', 'DESC']],
    });

    return rows.map(row => {
        const fr = row.toJSON ? row.toJSON() : { ...row };
        const u  = fr.friendRequesterUser || {};
        const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || '';
        return {
            id:         fr.id,
            senderId:   fr.requesterId,
            receiverId: fr.receiverId,
            status:     fr.status,
            user: {
                id:          u.id,
                name:        displayName,
                avatar:      u.avatar    || null,
                status:      u.status    || 'offline',
                lastSeen:    u.lastSeen  || null,
                isOnline:    u.status === 'online',
                username:    u.username  || '',
                displayName: displayName,
            },
            createdAt: fr.createdAt,
        };
    });
}

async function getSentRequests(userId) {
    const rows = await Friend.findAll({
        where: { requesterId: userId, status: 'pending' },
        include: [{ model: User, as: 'friendReceiverUser', attributes: USER_ATTRS, required: false }],
        order: [['createdAt', 'DESC']],
    });

    return rows.map(row => {
        const fr = row.toJSON ? row.toJSON() : { ...row };
        const u  = fr.friendReceiverUser || {};
        const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || '';
        return {
            id:         fr.id,
            senderId:   fr.requesterId,
            receiverId: fr.receiverId,
            status:     fr.status,
            user: {
                id:          u.id,
                name:        displayName,
                avatar:      u.avatar    || null,
                status:      u.status    || 'offline',
                lastSeen:    u.lastSeen  || null,
                isOnline:    u.status === 'online',
                username:    u.username  || '',
                displayName: displayName,
            },
            createdAt: fr.createdAt,
        };
    });
}

async function getBlockedUsers(userId) {
    const rows = await Friend.findAll({
        where: { requesterId: userId, status: 'blocked' },
        include: [{ model: User, as: 'friendReceiverUser', attributes: USER_ATTRS, required: false }],
    });

    return rows.map(row => {
        const fr = row.toJSON ? row.toJSON() : { ...row };
        const u  = fr.friendReceiverUser || {};
        return { ...formatUser(u), blockedAt: fr.blockedAt };
    }).filter(Boolean);
}

async function unfriend(userId, friendId) {
    // FIX: Use getFriendship which handles both orderings, then destroy the record.
    // Using loose equality (==) inside getFriendship handles string vs integer IDs.
    const record = await Friend.getFriendship(userId, friendId);
    if (!record || record.status !== 'accepted') {
        throw Object.assign(new Error('Friendship not found'), { status: 404 });
    }
    // FIX: destroy() performs the actual DELETE from the database.
    // Previously this was correct but relied on parseInt() in the controller
    // which returned NaN for UUID-based IDs, causing getFriendship() to fail silently.
    await record.destroy();
    return { success: true };
}

async function blockUser(userId, targetId) {
    let record = await Friend.getFriendship(userId, targetId);
    if (record) {
        return record.block();
    }
    return Friend.create({ requesterId: userId, receiverId: targetId, status: 'blocked' });
}

async function unblockUser(userId, targetId) {
    const record = await Friend.findOne({
        where: { requesterId: userId, receiverId: targetId, status: 'blocked' },
    });
    if (!record) throw Object.assign(new Error('Block record not found'), { status: 404 });
    return record.unblock();
}

async function areFriends(userId1, userId2) {
    const record = await Friend.getFriendship(userId1, userId2);
    return !!(record && record.status === 'accepted');
}

async function isBlocked(userId, targetId) {
    const record = await Friend.findOne({
        where: {
            [Op.or]: [
                { requesterId: userId,   receiverId: targetId,  status: 'blocked' },
                { requesterId: targetId, receiverId: userId,    status: 'blocked' },
            ],
        },
    });
    return !!record;
}

async function getFriendsCount(userId) {
    return Friend.count({
        where: {
            [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
            status: 'accepted',
        },
    });
}

async function getMutualFriends(userId1, userId2) {
    const [friends1, friends2] = await Promise.all([
        getFriends(userId1),
        getFriends(userId2),
    ]);
    const ids1 = new Set(friends1.map(f => String(f.id)));
    return friends2.filter(f => ids1.has(String(f.id)));
}

async function getNearbyUsers(userId, { lat, lng, radius = 5000 } = {}) {
    const myFriends = await getFriends(userId);
    const friendIds = new Set(myFriends.map(f => String(f.id)));

    const baseWhere = {
        id: {
            [Op.ne]:    userId,
            [Op.notIn]: [...friendIds].filter(Boolean),
        },
    };

    if (lat && lng) {
        try {
            const tableDesc    = await User.describe().catch(() => null);
            const hasLocation  = tableDesc && ('lat' in tableDesc || 'latitude' in tableDesc);

            if (hasLocation) {
                const latCol   = tableDesc.lat ? 'lat' : 'latitude';
                const lngCol   = tableDesc.lng ? 'lng' : 'longitude';
                const radiusDeg = radius / 111320;

                const geoUsers = await User.findAll({
                    where: {
                        ...baseWhere,
                        [latCol]: { [Op.between]: [parseFloat(lat) - radiusDeg, parseFloat(lat) + radiusDeg] },
                        [lngCol]: { [Op.between]: [parseFloat(lng) - radiusDeg, parseFloat(lng) + radiusDeg] },
                    },
                    attributes: USER_ATTRS,
                    limit: 50,
                });

                if (geoUsers.length > 0) {
                    return {
                        users: geoUsers.map(u => {
                            const f = formatUser(u);
                            return { id: f.id, name: f.displayName, avatar: f.avatar, status: f.status, lastSeen: f.lastActive, isOnline: f.status === 'online', username: f.username, displayName: f.displayName };
                        }),
                        count: geoUsers.length,
                        mode:  'geo',
                    };
                }
            }
        } catch (_) { /* fall through to online fallback */ }
    }

    // Fallback: return online users
    const onlineUsers = await User.findAll({
        where: { ...baseWhere, status: 'online' },
        attributes: USER_ATTRS,
        limit: 50,
    });

    const result = onlineUsers.map(u => {
        const f = formatUser(u);
        return { id: f.id, name: f.displayName, avatar: f.avatar, status: 'online', lastSeen: f.lastActive, isOnline: true, username: f.username, displayName: f.displayName };
    });

    return { users: result, count: result.length, mode: 'online' };
}

module.exports = {
    sendFriendRequest,
    respondToFriendRequest,
    getFriends,
    getPendingRequests,
    getSentRequests,
    getBlockedUsers,
    unfriend,
    blockUser,
    unblockUser,
    areFriends,
    isBlocked,
    getFriendsCount,
    getMutualFriends,
    getNearbyUsers,
    formatUser,
    formatFriend,
};