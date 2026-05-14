const friendService = require('../services/friendService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// Resolve Socket.IO without hard-coupling to server.js.
function getIO() {
    if (global.io) return global.io;
    try { return require('../services/webSocketService').io || require('../services/webSocketService').io || null; } catch (_) { return null; }
}

class FriendController {
    async sendFriendRequest(req, res, next) {
        try {
            const userId = req.user.id;
            const { receiverId, notes } = req.body;

            if (String(userId) === String(receiverId)) {
                throw new AppError('Cannot send friend request to yourself', 400);
            }

            const friendRequest = await friendService.sendFriendRequest(userId, receiverId, notes);

            res.status(201).json({
                success: true,
                message: 'Friend request sent successfully',
                data: { friendRequest }
            });

            // Emit real-time notification to the receiver AFTER responding (non-blocking)
            try {
                const io = getIO();
                if (io) {
                    // FIX: Always include full sender profile in the socket payload so the
                    // receiver's friend-core.js can populate the incoming-request card
                    // immediately without a separate API lookup.
                    let senderProfile = {
                        id:          req.user.id,
                        username:    req.user.username    || '',
                        displayName: req.user.displayName || req.user.username || '',
                        avatar:      req.user.avatar      || null,
                    };

                    // Attempt to load full profile fields (firstName/lastName/status) so the
                    // receiver's initials avatar and full display name are correct.
                    try {
                        const db   = require('../models');
                        const User = db.User || db.Users;
                        if (User) {
                            const senderUser = await User.findByPk(req.user.id, {
                                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
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
                                    status:      u.status     || 'offline',
                                    lastSeen:    u.lastSeen   || null,
                                };
                            }
                        }
                    } catch (_) { /* non-fatal — use what we have from req.user */ }

                    const payload = {
                        id:             friendRequest.id,
                        requesterId:    userId,
                        receiverId:     receiverId,
                        status:         'pending',
                        createdAt:      friendRequest.createdAt,
                        // Flat fields for backwards-compat with older friend-core versions
                        senderName:     senderProfile.displayName,
                        senderUsername: senderProfile.username,
                        senderAvatar:   senderProfile.avatar,
                        // Full nested user object so friend-core.js FRIEND_REQUEST_RECEIVED
                        // handler can directly populate the card without a cache lookup.
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
            const userId   = req.user.id;
            const { requestId, action } = req.body;

            const friendRequest = await friendService.respondToFriendRequest(requestId, userId, action);

            res.json({
                success: true,
                message: `Friend request ${action}ed successfully`,
                data:    { friendRequest }
            });

            // Emit real-time notification AFTER responding (non-blocking)
            try {
                const io = getIO();
                if (io) {
                    const originalRequesterId = friendRequest.requesterId;

                    if (action === 'accept') {
                        // Full profile of the user who ACCEPTED (receiver)
                        const accepterInfo = {
                            id:          req.user.id,
                            username:    req.user.username    || '',
                            displayName: req.user.displayName || req.user.username || '',
                            avatar:      req.user.avatar      || null,
                        };

                        // FIX: Notify the ORIGINAL SENDER (requester) with full accepter profile
                        // so their client can immediately populate caches without a round-trip.
                        const senderPayload = {
                            requestId:       requestId,
                            friendId:        userId,           // the accepter's ID — new friend for the sender
                            acceptedById:    userId,
                            user:            accepterInfo,     // FIX: full profile was missing before
                            friend:          accepterInfo,     // alias for friend-core.js compatibility
                            acceptedAt:      new Date().toISOString(),
                        };

                        io.to(`user:${originalRequesterId}`).emit('friend:accepted', senderPayload);
                        io.to(`user_${originalRequesterId}`).emit('friend:accepted', senderPayload);

                        // Also notify the accepter (multi-tab / multi-device sync).
                        // Look up the original sender's profile so the accepter's cache fills immediately.
                        let requesterInfo = { id: originalRequesterId };
                        try {
                            const db   = require('../models');
                            const User = db.User || db.Users;
                            if (User) {
                                const requesterUser = await User.findByPk(originalRequesterId, {
                                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                                });
                                if (requesterUser) {
                                    const u = requesterUser.toJSON ? requesterUser.toJSON() : requesterUser;
                                    requesterInfo = {
                                        id:          u.id,
                                        username:    u.username    || '',
                                        displayName: ([u.firstName, u.lastName].filter(Boolean).join(' ').trim()) || u.username || '',
                                        avatar:      u.avatar      || null,
                                        status:      u.status      || 'offline',
                                        lastSeen:    u.lastSeen    || null,
                                    };
                                }
                            }
                        } catch (_) { /* non-fatal */ }

                        const accepterPayload = {
                            requestId:    requestId,
                            friendId:     originalRequesterId,  // the sender's ID — new friend for the accepter
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
            const userId = req.user.id;
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
            const userId   = req.user.id;
            const requests = await friendService.getPendingRequests(userId);
            res.json({ success: true, data: { requests, count: requests.length } });
        } catch (error) {
            logger.error('Get pending requests controller error:', error);
            next(error);
        }
    }

    async getSentRequests(req, res, next) {
        try {
            const userId   = req.user.id;
            const requests = await friendService.getSentRequests(userId);
            res.json({ success: true, data: { requests, count: requests.length } });
        } catch (error) {
            logger.error('Get sent requests controller error:', error);
            next(error);
        }
    }

    async getBlockedUsers(req, res, next) {
        try {
            const userId       = req.user.id;
            const blockedUsers = await friendService.getBlockedUsers(userId);
            res.json({ success: true, data: { blockedUsers, count: blockedUsers.length } });
        } catch (error) {
            logger.error('Get blocked users controller error:', error);
            next(error);
        }
    }

    async unfriend(req, res, next) {
        try {
            const userId   = req.user.id;
            // FIX: Support both integer and UUID/string IDs. parseInt() returns NaN for UUIDs.
            const rawId    = req.params.friendId;
            const friendId = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

            await friendService.unfriend(userId, friendId);

            res.json({ success: true, message: 'Friend removed successfully' });

            // FIX: Emit real-time removal event to BOTH sides so their caches update instantly.
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
            const userId  = req.user.id;
            const rawId   = req.params.targetId;
            const targetId = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

            if (String(userId) === String(targetId)) {
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
            const userId  = req.user.id;
            const rawId   = req.params.targetId;
            const targetId = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

            await friendService.unblockUser(userId, targetId);
            res.json({ success: true, message: 'User unblocked successfully' });
        } catch (error) {
            logger.error('Unblock user controller error:', error);
            next(error);
        }
    }

    async checkFriendship(req, res, next) {
        try {
            const userId  = req.user.id;
            const rawId   = req.params.targetId;
            const targetId = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

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
            const userId = req.user.id;
            const count  = await friendService.getFriendsCount(userId);
            res.json({ success: true, data: { count } });
        } catch (error) {
            logger.error('Get friends count controller error:', error);
            next(error);
        }
    }

    async getMutualFriends(req, res, next) {
        try {
            const userId      = req.user.id;
            const rawId       = req.params.targetId;
            const targetId    = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;
            const mutualFriends = await friendService.getMutualFriends(userId, targetId);
            res.json({ success: true, data: { mutualFriends, count: mutualFriends.length } });
        } catch (error) {
            logger.error('Get mutual friends controller error:', error);
            next(error);
        }
    }

    async getNearbyUsers(req, res, next) {
        try {
            const userId               = req.user.id;
            const { lat, lng, radius = 5000 } = req.query;
            const result               = await friendService.getNearbyUsers(userId, { lat, lng, radius });
            res.json({ success: true, data: { users: result.users, count: result.count, mode: result.mode } });
        } catch (error) {
            logger.error('Get nearby users controller error:', error);
            next(error);
        }
    }

    // FIX: New endpoint — called by NearbyManager._updatePresence() to push user's
    // current location to the DB so they appear in other users' nearby queries.
    async updatePresence(req, res, next) {
        try {
            const userId = req.user.id;
            const { lat, lng, status = 'online' } = req.body;
            if (!lat || !lng) return res.json({ success: true, skipped: true });
            // Update the user's lat/lng in the DB (best-effort, non-fatal if columns missing)
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
            } catch (_) { /* non-fatal */ }
            res.json({ success: true });
        } catch (error) {
            logger.error('Update presence controller error:', error);
            next(error);
        }
    }
}

module.exports = new FriendController();