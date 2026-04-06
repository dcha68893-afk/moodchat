// services/friendService.js
// Full implementation — matches Friend model column names and associations exactly.
// Version: 2.0.0 - Fixed naming consistency (requesterId, receiverId only)
// NO snake_case in ORM queries - all camelCase

'use strict';

const { Op } = require('sequelize');
const db = require('../models');

const User   = db.User   || db.Users;
const Friend = db.Friend || db.Friends;

// ─── helpers ──────────────────────────────────────────────────────────────────

const USER_ATTRS = ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen'];

function formatUser(user) {
    if (!user) return null;
    const u = user.toJSON ? user.toJSON() : user;
    return {
        id:          u.id,
        username:    u.username    || '',
        avatar:      u.avatar      || null,
        displayName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username,
        firstName:   u.firstName   || '',
        lastName:    u.lastName    || '',
        status:      u.status      || 'offline',
        lastActive:  u.lastSeen    || null
    };
}

// Includes for both sides of a friendship
const FRIEND_INCLUDES = [
    { model: User, as: 'friendRequesterUser', attributes: USER_ATTRS, required: false },
    { model: User, as: 'friendReceiverUser',  attributes: USER_ATTRS, required: false }
];

// ─── service methods ───────────────────────────────────────────────────────────

/**
 * Send a friend request from requesterId → receiverId.
 * If a pending request already exists in the other direction, auto-accept.
 */
async function sendFriendRequest(requesterId, receiverId, notes = '') {
    if (requesterId === receiverId) {
        throw Object.assign(new Error('Cannot send friend request to yourself'), { status: 400 });
    }

    const targetUser = await User.findByPk(receiverId, { attributes: ['id', 'username'] });
    if (!targetUser) {
        throw Object.assign(new Error('User not found'), { status: 404 });
    }

    // Check for any existing relationship
    const existing = await Friend.findOne({
        where: {
            [Op.or]: [
                { requesterId: requesterId, receiverId: receiverId },
                { requesterId: receiverId,  receiverId: requesterId }
            ]
        }
    });

    if (existing) {
        if (existing.status === 'accepted') {
            throw Object.assign(new Error('Already friends'), { status: 400 });
        }
        if (existing.status === 'pending') {
            if (existing.requesterId === requesterId) {
                throw Object.assign(new Error('Friend request already sent'), { status: 400 });
            }
            // Reverse pending request — auto-accept
            existing.status     = 'accepted';
            existing.acceptedAt = new Date();
            existing.updatedAt  = new Date();
            await existing.save();
            return existing;
        }
        if (existing.status === 'blocked') {
            throw Object.assign(new Error('Cannot send request to blocked user'), { status: 400 });
        }
    }

    const friendRequest = await Friend.create({
        requesterId:  requesterId,
        receiverId:   receiverId,
        status:       'pending',
        notes:        notes || null,
        createdAt:    new Date(),
        updatedAt:    new Date()
    });

    return friendRequest;
}

/**
 * Accept or reject a pending friend request.
 * action: 'accept' | 'reject'
 */
async function respondToFriendRequest(requestId, receiverId, action) {
    const friendRequest = await Friend.findOne({
        where: { id: requestId, receiverId: receiverId, status: 'pending' }
    });

    if (!friendRequest) {
        throw Object.assign(new Error('Friend request not found'), { status: 404 });
    }

    if (action === 'accept') {
        friendRequest.status     = 'accepted';
        friendRequest.acceptedAt = new Date();
        friendRequest.updatedAt  = new Date();
        await friendRequest.save();
    } else if (action === 'reject') {
        await friendRequest.destroy();
    } else {
        throw Object.assign(new Error('Invalid action — must be accept or reject'), { status: 400 });
    }

    return friendRequest;
}

/**
 * Get all accepted friends for a user.
 */
async function getFriends(userId, status = 'accepted') {
    const friendships = await Friend.findAll({
        where: {
            [Op.or]: [
                { requesterId: userId, status: status },
                { receiverId:  userId, status: status }
            ]
        },
        include: FRIEND_INCLUDES,
        limit: 500
    });

    return friendships
        .map(f => {
            const friendUser = f.requesterId === userId
                ? f.friendReceiverUser
                : f.friendRequesterUser;
            return formatUser(friendUser);
        })
        .filter(f => f && f.id);
}

/**
 * Get pending incoming friend requests for a user.
 */
async function getPendingRequests(userId) {
    const requests = await Friend.findAll({
        where: { receiverId: userId, status: 'pending' },
        include: [
            { model: User, as: 'friendRequesterUser', attributes: USER_ATTRS, required: false }
        ],
        order: [['createdAt', 'DESC']],
        limit: 200
    });

    return requests
        .map(r => ({
            id:        r.id,
            user:      formatUser(r.friendRequesterUser),
            status:    r.status,
            notes:     r.notes,
            createdAt: r.createdAt
        }))
        .filter(r => r.user);
}

/**
 * Get pending sent friend requests by a user.
 */
async function getSentRequests(userId) {
    const requests = await Friend.findAll({
        where: { requesterId: userId, status: 'pending' },
        include: [
            { model: User, as: 'friendReceiverUser', attributes: USER_ATTRS, required: false }
        ],
        order: [['createdAt', 'DESC']],
        limit: 200
    });

    return requests
        .map(r => ({
            id:        r.id,
            user:      formatUser(r.friendReceiverUser),
            status:    r.status,
            notes:     r.notes,
            createdAt: r.createdAt
        }))
        .filter(r => r.user);
}

/**
 * Get users blocked by userId.
 */
async function getBlockedUsers(userId) {
    const blocked = await Friend.findAll({
        where: { requesterId: userId, status: 'blocked' },
        include: [
            { model: User, as: 'friendReceiverUser', attributes: USER_ATTRS, required: false }
        ],
        limit: 200
    });

    return blocked
        .map(b => formatUser(b.friendReceiverUser))
        .filter(u => u && u.id);
}

/**
 * Remove a friendship between userId and friendId.
 */
async function unfriend(userId, friendId) {
    const friendship = await Friend.findOne({
        where: {
            status: 'accepted',
            [Op.or]: [
                { requesterId: userId, receiverId: friendId },
                { requesterId: friendId, receiverId: userId }
            ]
        }
    });

    if (!friendship) {
        throw Object.assign(new Error('Friendship not found'), { status: 404 });
    }

    await friendship.destroy();
}

/**
 * Block targetId from userId's perspective.
 * Creates or updates the friendship row to status=blocked.
 */
async function blockUser(userId, targetId) {
    let friendship = await Friend.findOne({
        where: {
            [Op.or]: [
                { requesterId: userId, receiverId: targetId },
                { requesterId: targetId, receiverId: userId }
            ]
        }
    });

    if (friendship) {
        friendship.status    = 'blocked';
        friendship.blockedAt = new Date();
        friendship.updatedAt = new Date();
        // Ensure the blocker is always the requester so unblock check is consistent
        friendship.requesterId = userId;
        friendship.receiverId  = targetId;
        await friendship.save();
    } else {
        friendship = await Friend.create({
            requesterId: userId,
            receiverId:  targetId,
            status:      'blocked',
            blockedAt:   new Date(),
            createdAt:   new Date(),
            updatedAt:   new Date()
        });
    }

    return friendship;
}

/**
 * Unblock targetId — removes the blocked row entirely.
 */
async function unblockUser(userId, targetId) {
    const friendship = await Friend.findOne({
        where: {
            [Op.or]: [
                { requesterId: userId, receiverId: targetId, status: 'blocked' },
                { requesterId: targetId, receiverId: userId, status: 'blocked' }
            ]
        }
    });

    if (!friendship) {
        throw Object.assign(new Error('Blocked user not found'), { status: 404 });
    }

    await friendship.destroy();
}

/**
 * Returns true if userId1 and userId2 are accepted friends.
 */
async function areFriends(userId1, userId2) {
    const count = await Friend.count({
        where: {
            status: 'accepted',
            [Op.or]: [
                { requesterId: userId1, receiverId: userId2 },
                { requesterId: userId2, receiverId: userId1 }
            ]
        }
    });
    return count > 0;
}

/**
 * Returns true if userId1 has blocked userId2 (or vice-versa).
 */
async function isBlocked(userId1, userId2) {
    const count = await Friend.count({
        where: {
            status: 'blocked',
            [Op.or]: [
                { requesterId: userId1, receiverId: userId2 },
                { requesterId: userId2, receiverId: userId1 }
            ]
        }
    });
    return count > 0;
}

/**
 * Return total accepted-friend count for userId.
 */
async function getFriendsCount(userId) {
    return await Friend.count({
        where: {
            status: 'accepted',
            [Op.or]: [
                { requesterId: userId },
                { receiverId:  userId }
            ]
        }
    });
}

/**
 * Return users who are friends with both userId and targetId.
 */
async function getMutualFriends(userId, targetId) {
    // Collect friend-id sets for each user then intersect.
    const [userFriendships, targetFriendships] = await Promise.all([
        Friend.findAll({
            where: {
                status: 'accepted',
                [Op.or]: [
                    { requesterId: userId },
                    { receiverId:  userId }
                ]
            },
            attributes: ['requesterId', 'receiverId']
        }),
        Friend.findAll({
            where: {
                status: 'accepted',
                [Op.or]: [
                    { requesterId: targetId },
                    { receiverId:  targetId }
                ]
            },
            attributes: ['requesterId', 'receiverId']
        })
    ]);

    const friendIdsOf = (list, self) =>
        new Set(list.map(f => f.requesterId === self ? f.receiverId : f.requesterId));

    const userFriendIds   = friendIdsOf(userFriendships,   userId);
    const targetFriendIds = friendIdsOf(targetFriendships, targetId);

    const mutualIds = [...userFriendIds].filter(id => targetFriendIds.has(id));

    if (mutualIds.length === 0) return [];

    const users = await User.findAll({
        where: { id: { [Op.in]: mutualIds } },
        attributes: USER_ATTRS
    });

    return users.map(formatUser).filter(u => u && u.id);
}

/**
 * Check if a pending friend request exists between two users
 */
async function hasPendingRequest(userId1, userId2) {
    const request = await Friend.findOne({
        where: {
            status: 'pending',
            [Op.or]: [
                { requesterId: userId1, receiverId: userId2 },
                { requesterId: userId2, receiverId: userId1 }
            ]
        }
    });
    return !!request;
}

/**
 * Get friend request by ID
 */
async function getFriendRequestById(requestId) {
    const request = await Friend.findByPk(requestId, {
        include: FRIEND_INCLUDES
    });
    
    if (!request) {
        throw Object.assign(new Error('Friend request not found'), { status: 404 });
    }
    
    return request;
}

/**
 * Cancel a sent friend request
 */
async function cancelFriendRequest(requestId, requesterId) {
    const request = await Friend.findOne({
        where: {
            id: requestId,
            requesterId: requesterId,
            status: 'pending'
        }
    });
    
    if (!request) {
        throw Object.assign(new Error('Friend request not found or already responded'), { status: 404 });
    }
    
    await request.destroy();
}

/**
 * Get friendship status between two users
 */
async function getFriendshipStatus(userId1, userId2) {
    const friendship = await Friend.findOne({
        where: {
            [Op.or]: [
                { requesterId: userId1, receiverId: userId2 },
                { requesterId: userId2, receiverId: userId1 }
            ]
        }
    });
    
    if (!friendship) {
        return { status: 'none', friendship: null };
    }
    
    let relationship = 'none';
    if (friendship.status === 'accepted') {
        relationship = 'friends';
    } else if (friendship.status === 'pending') {
        if (friendship.requesterId === userId1) {
            relationship = 'request_sent';
        } else {
            relationship = 'request_received';
        }
    } else if (friendship.status === 'blocked') {
        relationship = 'blocked';
    }
    
    return {
        status: relationship,
        friendship: friendship.toJSON ? friendship.toJSON() : friendship
    };
}

// ─── exports ───────────────────────────────────────────────────────────────────

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
    hasPendingRequest,
    getFriendRequestById,
    cancelFriendRequest,
    getFriendshipStatus
};