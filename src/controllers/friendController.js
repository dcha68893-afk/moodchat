const friendService = require('../services/friendService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// Canonicalize IDs coming from the Friends selection/request path.
// Some clients can accidentally serialize the same numeric user ID twice as
// "1::1". That is a transport/selection artifact, not a PostgreSQL ID.
// ROOT-CAUSE FIX (ALL-FRIEND-FEATURES-BROKEN, Sep 17): the previous version of
// this function THREW a 400 "Invalid <field>" for any ID that wasn't a bare
// digit string or a repeated "N::N" digit string. That's stricter than every
// other ID-handling path in this codebase (see friendService.js's unfriend()/
// getFriendship() comments — "supports both integer and UUID/string IDs" —
// and the old parseInt()-returned-NaN-for-non-integer-IDs bug they document),
// and it ran on req.user.id/receiverId/friendId/targetId in literally every
// controller method here. Any ID that didn't happen to be a clean digit
// string made that ENTIRE request 400, across every friend endpoint at once —
// which is exactly the "all features in Friend module not working" symptom.
// Now: still repair the known "N::N" duplicate-ID artifact, still fast-path
// plain integers, but never hard-fail on anything else — fall back to passing
// the trimmed original value through, same as the tolerant pattern already
// used elsewhere in this codebase (loose/`==` comparison, Sequelize `where`
// clauses that accept either type). Only reject truly empty/missing IDs.
function normalizeFriendUserId(rawId, fieldName = 'userId') {
    if (rawId === undefined || rawId === null) {
        throw new AppError(`Invalid ${fieldName}`, 400);
    }

    const value = String(rawId).trim();
    if (!value) throw new AppError(`Invalid ${fieldName}`, 400);

    // Normal canonical integer ID.
    if (/^\d+$/.test(value)) return parseInt(value, 10);

    // Repair the specific duplicated-ID representation produced by the Friends
    // selection path: "N::N" -> N. Never collapse "N::M" because that could
    // silently select the wrong account.
    const parts = value.split('::').map(part => part.trim());
    if (parts.length > 1 && parts.every(part => /^\d+$/.test(part))) {
        const first = parseInt(parts[0], 10);
        if (parts.every(part => parseInt(part, 10) === first)) return first;
    }

    // Anything else (a UUID/string ID, or an "N::M" composite we can't safely
    // collapse) — don't fail the request. Pass it through unchanged and let
    // Sequelize/getFriendship's existing type-tolerant comparisons handle it,
    // exactly as this codebase did before today's over-strict rewrite.
    return value;
}

function getIO() {
    if (global.io) return global.io;
    try { return require('../services/webSocketService').io || null; } catch (_) { return null; }
}

class FriendController {
    async sendFriendRequest(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const receiverId = normalizeFriendUserId(req.body.receiverId, 'receiver ID');
            const { notes } = req.body;

            if (userId === receiverId) {
                throw new AppError('Cannot send friend request to yourself', 400);
            }

            const friendRequest = await friendService.sendFriendRequest(userId, receiverId, notes);

            res.status(201).json({
                success: true,
                message: 'Friend request sent successfully',
                data: { friendRequest }
            });

            try {
                const io = getIO();
                if (io) {
                    let senderProfile = {
                        id: userId,
                        username:    req.user.username    || '',
                        displayName: req.user.displayName || req.user.username || '',
                        avatar:      req.user.avatar      || null,
                        coverPhoto:  req.user.coverPhoto  || null,
                    };

                    try {
                        const db   = require('../models');
                        const User = db.User || db.Users;
                        if (User) {
                            const senderUser = await User.findByPk(userId, {
                                attributes: ['id', 'username', 'avatar', 'coverPhoto', 'firstName', 'lastName', 'status', 'lastSeen']
                            });
                            if (senderUser) {
                                const u = senderUser.toJSON ? senderUser.toJSON() : senderUser;
                                senderProfile = {
                                    id:          u.id,
                                    username:    u.username   || '',
                                    displayName: ([u.firstName, u.lastName].filter(Boolean).join(' ').trim()) || u.username || '',
                                    firstName:   u.firstName  || '',
                                    lastName:    u.lastName   || '',
                                    avatar:      u.avatar     || null,
                                    coverPhoto:  u.coverPhoto || null,
                                    status:      u.status     || 'offline',
                                    lastSeen:    u.lastSeen   || null,
                                };
                            }
                        }
                    } catch (_) {}

                    const payload = {
                        id:             friendRequest.id,
                        requesterId:    userId,
                        receiverId:     receiverId,
                        status:         'pending',
                        createdAt:      friendRequest.createdAt,
                        senderName:     senderProfile.displayName,
                        senderUsername: senderProfile.username,
                        senderAvatar:   senderProfile.avatar,
                        user:           senderProfile,
                    };

                    io.to(`user:${receiverId}`).emit('friend:request', payload);
                    io.to(`user_${receiverId}`).emit('friend:request', payload);
                }
            } catch (emitErr) {
                logger.warn('sendFriendRequest: realtime emit failed (non-fatal):', emitErr.message);
            }
        } catch (error) {
            logger.error('Send friend request controller error:', error);
            next(error);
        }
    }

    async respondToFriendRequest(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const { requestId, action } = req.body;

            const friendRequest = await friendService.respondToFriendRequest(requestId, userId, action);

            res.json({
                success: true,
                message: `Friend request ${action}ed successfully`,
                data: { friendRequest }
            });

            try {
                const io = getIO();
                if (io) {
                    const originalRequesterId = normalizeFriendUserId(friendRequest.requesterId, 'requester ID');

                    if (action === 'accept') {
                        const accepterInfo = {
                            id:          userId,
                            username:    req.user.username    || '',
                            displayName: req.user.displayName || req.user.username || '',
                            avatar:      req.user.avatar      || null,
                            coverPhoto:  req.user.coverPhoto  || null,
                        };

                        const senderPayload = {
                            requestId:       requestId,
                            friendId:        userId,
                            acceptedById:    userId,
                            user:            accepterInfo,
                            friend:          accepterInfo,
                            acceptedAt:      new Date().toISOString(),
                        };

                        io.to(`user:${originalRequesterId}`).emit('friend:accepted', senderPayload);
                        io.to(`user_${originalRequesterId}`).emit('friend:accepted', senderPayload);

                        let requesterInfo = { id: originalRequesterId };
                        try {
                            const db   = require('../models');
                            const User = db.User || db.Users;
                            if (User) {
                                const requesterUser = await User.findByPk(originalRequesterId, {
                                    attributes: ['id', 'username', 'avatar', 'coverPhoto', 'firstName', 'lastName', 'status', 'lastSeen']
                                });
                                if (requesterUser) {
                                    const u = requesterUser.toJSON ? requesterUser.toJSON() : requesterUser;
                                    requesterInfo = {
                                        id:          u.id,
                                        username:    u.username    || '',
                                        displayName: ([u.firstName, u.lastName].filter(Boolean).join(' ').trim()) || u.username || '',
                                        avatar:      u.avatar      || null,
                                        coverPhoto:  u.coverPhoto  || null,
                                        status:      u.status      || 'offline',
                                        lastSeen:    u.lastSeen    || null,
                                    };
                                }
                            }
                        } catch (_) {}

                        const accepterPayload = {
                            requestId:    requestId,
                            friendId:     originalRequesterId,
                            acceptedById: userId,
                            user:         requesterInfo,
                            friend:       requesterInfo,
                            acceptedAt:   new Date().toISOString(),
                        };

                        io.to(`user:${userId}`).emit('friend:accepted', accepterPayload);
                        io.to(`user_${userId}`).emit('friend:accepted', accepterPayload);

                    } else if (action === 'reject') {
                        const rejectedPayload = { requestId, friendId: userId };
                        io.to(`user:${originalRequesterId}`).emit('friend:rejected', rejectedPayload);
                        io.to(`user_${originalRequesterId}`).emit('friend:rejected', rejectedPayload);
                    }
                }
            } catch (emitErr) {
                logger.warn('respondToFriendRequest: realtime emit failed (non-fatal):', emitErr.message);
            }
        } catch (error) {
            logger.error('Respond to friend request controller error:', error);
            next(error);
        }
    }

    async getFriends(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const { status = 'accepted' } = req.query;
            const friends = await friendService.getFriends(userId, status);
            res.json({ success: true, data: { friends, count: friends.length } });
        } catch (error) {
            logger.error('Get friends controller error:', error);
            next(error);
        }
    }

    async getPendingRequests(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const requests = await friendService.getPendingRequests(userId);
            res.json({ success: true, data: { requests, count: requests.length } });
        } catch (error) {
            logger.error('Get pending requests controller error:', error);
            next(error);
        }
    }

    async getSentRequests(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const requests = await friendService.getSentRequests(userId);
            res.json({ success: true, data: { requests, count: requests.length } });
        } catch (error) {
            logger.error('Get sent requests controller error:', error);
            next(error);
        }
    }

    async getBlockedUsers(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const blockedUsers = await friendService.getBlockedUsers(userId);
            res.json({ success: true, data: { blockedUsers, count: blockedUsers.length } });
        } catch (error) {
            logger.error('Get blocked users controller error:', error);
            next(error);
        }
    }

    async unfriend(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const friendId = normalizeFriendUserId(req.params.friendId, 'friend ID');

            await friendService.unfriend(userId, friendId);

            res.json({ success: true, message: 'Friend removed successfully' });

            try {
                const io = getIO();
                if (io) {
                    const payloadForFriend = { friendId: userId };
                    const payloadForSelf   = { friendId };

                    io.to(`user:${friendId}`).emit('friend:removed', payloadForFriend);
                    io.to(`user_${friendId}`).emit('friend:removed', payloadForFriend);

                    io.to(`user:${userId}`).emit('friend:removed', payloadForSelf);
                    io.to(`user_${userId}`).emit('friend:removed', payloadForSelf);
                }
            } catch (emitErr) {
                logger.warn('unfriend: realtime emit failed (non-fatal):', emitErr.message);
            }
        } catch (error) {
            logger.error('Unfriend controller error:', error);
            next(error);
        }
    }

    async blockUser(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const targetId = normalizeFriendUserId(req.params.targetId, 'target ID');

            if (userId === targetId) {
                throw new AppError('Cannot block yourself', 400);
            }

            await friendService.blockUser(userId, targetId);
            res.json({ success: true, message: 'User blocked successfully' });
        } catch (error) {
            logger.error('Block user controller error:', error);
            next(error);
        }
    }

    async unblockUser(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const targetId = normalizeFriendUserId(req.params.targetId, 'target ID');

            await friendService.unblockUser(userId, targetId);
            res.json({ success: true, message: 'User unblocked successfully' });
        } catch (error) {
            logger.error('Unblock user controller error:', error);
            next(error);
        }
    }

    async checkFriendship(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const targetId = normalizeFriendUserId(req.params.targetId, 'target ID');

            const [areFriends, isBlocked] = await Promise.all([
                friendService.areFriends(userId, targetId),
                friendService.isBlocked(userId, targetId),
            ]);

            res.json({ success: true, data: { areFriends, isBlocked } });
        } catch (error) {
            logger.error('Check friendship controller error:', error);
            next(error);
        }
    }

    async getFriendsCount(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const count = await friendService.getFriendsCount(userId);
            res.json({ success: true, data: { count } });
        } catch (error) {
            logger.error('Get friends count controller error:', error);
            next(error);
        }
    }

    async getMutualFriends(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const targetId = normalizeFriendUserId(req.params.targetId, 'target ID');
            const mutualFriends = await friendService.getMutualFriends(userId, targetId);
            res.json({ success: true, data: { mutualFriends, count: mutualFriends.length } });
        } catch (error) {
            logger.error('Get mutual friends controller error:', error);
            next(error);
        }
    }

    async getNearbyUsers(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const { lat, lng, radius = 5000 } = req.query;
            const result = await friendService.getNearbyUsers(userId, { lat, lng, radius });
            res.json({ success: true, data: { users: result.users, count: result.count, mode: result.mode } });
        } catch (error) {
            logger.error('Get nearby users controller error:', error);
            next(error);
        }
    }

    async updatePresence(req, res, next) {
        try {
            const userId = normalizeFriendUserId(req.user.id, 'user ID');
            const { lat, lng, status = 'online' } = req.body;
            if (!lat || !lng) return res.json({ success: true, skipped: true });
            try {
                const db = require('../models');
                const User = db.User || db.Users;
                if (User) {
                    const tableDesc = await User.describe().catch(() => null);
                    if (tableDesc) {
                        const updates = { status };
                        if ('lat' in tableDesc)       updates.lat       = parseFloat(lat);
                        if ('latitude' in tableDesc)  updates.latitude  = parseFloat(lat);
                        if ('lng' in tableDesc)       updates.lng       = parseFloat(lng);
                        if ('longitude' in tableDesc) updates.longitude = parseFloat(lng);
                        if (Object.keys(updates).length > 1) {
                            await User.update(updates, { where: { id: userId } });
                        }
                    }
                }
            } catch (_) {}
            res.json({ success: true });
        } catch (error) {
            logger.error('Update presence controller error:', error);
            next(error);
        }
    }
}

module.exports = new FriendController();