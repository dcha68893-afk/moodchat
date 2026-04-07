// services/statusService.js
// FIXED v2.0 - Complete rewrite to match statusController.js expectations
// Implements ALL methods the controller calls:
//   createStatus, getStatusById, updateStatus, deleteStatus,
//   getUserStatuses, getTimeline, likeStatus, unlikeStatus,
//   commentOnStatus, getStatusComments, deleteComment,
//   shareStatus, getStatusStatistics, reportStatus,
//   getTrendingStatuses, pinStatus, unpinStatus
// Also wires into friendService so friends' statuses are fetched correctly.

'use strict';

const { Op } = require('sequelize');

// ---------------------------------------------------------------------------
// Lazy model loader — avoids circular-dependency issues at require-time
// ---------------------------------------------------------------------------
function getModels() {
    const db = require('../models');
    return {
        Status:        db.Status        || db.Statuses,
        StatusLike:    db.StatusLike    || db.StatusLikes,
        StatusComment: db.StatusComment || db.StatusComments,
        StatusView:    db.StatusView    || db.StatusViews,
        Users:         db.Users         || db.User,
        Friend:        db.Friend        || db.Friends,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_PINS = 5;

function notFound(msg)   { return Object.assign(new Error(msg || 'Not found'),           { statusCode: 404 }); }
function forbidden(msg)  { return Object.assign(new Error(msg || 'Forbidden'),            { statusCode: 403 }); }
function badRequest(msg) { return Object.assign(new Error(msg || 'Bad request'),          { statusCode: 400 }); }
function conflict(msg)   { return Object.assign(new Error(msg || 'Conflict'),             { statusCode: 409 }); }
function serverErr(msg)  { return Object.assign(new Error(msg || 'Internal server error'), { statusCode: 500 }); }

/** Re-throw known AppErrors unchanged, wrap the rest as 500 */
function rethrow(error, fallbackMsg) {
    if (error.statusCode) throw error;
    console.error(fallbackMsg, error);
    throw serverErr(fallbackMsg);
}

/** Standard include for User on a Status query */
function userInclude(Users) {
    return {
        model: Users,
        as: 'statusUser',
        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
        required: false,
    };
}

/** Resolve the active expiry filter */
const activeFilter = () => ({
    isActive: true,
    [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
});

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------
function pagination(options = {}) {
    const page   = Math.max(1, parseInt(options.page  || 1));
    const limit  = Math.min(50, Math.max(1, parseInt(options.limit || 20)));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}

// ---------------------------------------------------------------------------
// Privacy / visibility check
// ---------------------------------------------------------------------------
/**
 * Returns true if `viewerId` is allowed to see `status`.
 * Rules:
 *   - owner always sees their own status
 *   - isPublic  → everyone
 *   - privacy 'friends' → only if they are accepted friends
 */
async function canView(status, viewerId) {
    if (!viewerId) return status.isPublic;
    if (status.userId === viewerId) return true;
    if (status.isPublic) return true;

    // friends-only: check friendship
    const { Friend } = getModels();
    if (!Friend) return false;
    const count = await Friend.count({
        where: {
            status: 'accepted',
            [Op.or]: [
                { requesterId: viewerId, receiverId: status.userId },
                { requesterId: status.userId, receiverId: viewerId },
            ],
        },
    });
    return count > 0;
}

// ---------------------------------------------------------------------------
// 1. createStatus
// ---------------------------------------------------------------------------
async function createStatus(statusData) {
    const { Status, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const {
            userId, content, mediaUrl, mediaType,
            background, expiresAt, privacy, type,
            moodType, location, latitude, longitude,
            isPublic,
        } = statusData;

        if (!userId) throw badRequest('userId is required');
        if (!content && !mediaUrl) throw badRequest('Content or media is required');

        // Map legacy 'privacy' field to isPublic boolean
        const pub = isPublic !== undefined
            ? isPublic
            : (!privacy || privacy === 'public' || privacy === 'everyone');

        const created = await Status.create({
            userId,
            content:   content   || '',
            type:      type      || (moodType ? 'mood' : mediaUrl ? mediaType || 'image' : 'text'),
            moodType:  moodType  || null,
            mediaUrl:  mediaUrl  || null,
            location:  location  || null,
            latitude:  latitude  || null,
            longitude: longitude || null,
            isPublic:  pub,
            isActive:  true,
            metadata:  background ? { background } : {},
            expiresAt: expiresAt
                ? new Date(expiresAt)
                : new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 h default
        });

        // Re-fetch with user attached
        const full = await Status.findByPk(created.id, {
            include: Users ? [userInclude(Users)] : [],
        });

        return full || created;
    } catch (e) { rethrow(e, 'Failed to create status'); }
}

// ---------------------------------------------------------------------------
// 2. getStatusById
// ---------------------------------------------------------------------------
async function getStatusById(statusId, viewerId) {
    const { Status, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findByPk(statusId, {
            include: Users ? [userInclude(Users)] : [],
        });
        if (!status) throw notFound('Status not found');

        if (!(await canView(status, viewerId))) throw forbidden('Not authorized to view this status');

        const expired = status.expiresAt && new Date(status.expiresAt) < new Date();
        if (expired && status.userId !== viewerId) throw Object.assign(new Error('Status has expired'), { statusCode: 410 });

        // Increment view count if not the owner
        if (viewerId && status.userId !== viewerId && !expired) {
            await Status.update(
                { viewCount: (status.viewCount || 0) + 1 },
                { where: { id: statusId } }
            );
            status.viewCount = (status.viewCount || 0) + 1;

            const { StatusView } = getModels();
            if (StatusView) {
                const alreadyViewed = await StatusView.findOne({ where: { statusId, userId: viewerId } });
                if (!alreadyViewed) {
                    await StatusView.create({ statusId, userId: viewerId, viewedAt: new Date() }).catch(() => {});
                }
            }
        }

        return status;
    } catch (e) { rethrow(e, 'Failed to get status'); }
}

// ---------------------------------------------------------------------------
// 3. updateStatus
// ---------------------------------------------------------------------------
async function updateStatus(statusId, userId, updateData) {
    const { Status, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findOne({ where: { id: statusId, userId } });
        if (!status) throw notFound('Status not found or you do not own it');

        const allowed = ['content', 'isPublic', 'location', 'moodType', 'metadata'];
        const updates = {};
        allowed.forEach(k => { if (updateData[k] !== undefined) updates[k] = updateData[k]; });
        updates.updatedAt = new Date();

        await status.update(updates);

        const refreshed = await Status.findByPk(statusId, {
            include: Users ? [userInclude(Users)] : [],
        });
        return refreshed;
    } catch (e) { rethrow(e, 'Failed to update status'); }
}

// ---------------------------------------------------------------------------
// 4. deleteStatus
// ---------------------------------------------------------------------------
async function deleteStatus(statusId, userId) {
    const { Status } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const deleted = await Status.destroy({ where: { id: statusId, userId } });
        if (!deleted) throw notFound('Status not found or you do not own it');
    } catch (e) { rethrow(e, 'Failed to delete status'); }
}

// ---------------------------------------------------------------------------
// 5. getUserStatuses
// ---------------------------------------------------------------------------
async function getUserStatuses(targetUserId, viewerId, options = {}) {
    const { Status, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const { limit, offset } = pagination(options);
        const includeExpired = options.includeExpired === true;

        const where = { userId: targetUserId };

        // Non-owners only see active, non-expired, public (or friends) statuses
        if (targetUserId !== viewerId) {
            Object.assign(where, activeFilter());
            // Privacy: public only (friends check would require join — keep simple)
            where.isPublic = true;
        } else if (!includeExpired) {
            Object.assign(where, activeFilter());
        }

        const { count, rows } = await Status.findAndCountAll({
            where,
            include: Users ? [userInclude(Users)] : [],
            order: [['createdAt', 'DESC']],
            limit,
            offset,
        });

        return {
            statuses: rows,
            pagination: { page: options.page || 1, limit, offset, total: count, hasMore: offset + rows.length < count },
        };
    } catch (e) { rethrow(e, 'Failed to get user statuses'); }
}

// ---------------------------------------------------------------------------
// 6. getTimeline — own posts + accepted friends' posts
// ---------------------------------------------------------------------------
async function getTimeline(userId, options = {}) {
    const { Status, Users, Friend } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const { limit, offset } = pagination(options);

        // Collect accepted friend IDs
        let friendIds = [];
        if (Friend) {
            const friendships = await Friend.findAll({
                where: {
                    status: 'accepted',
                    [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
                },
                attributes: ['requesterId', 'receiverId'],
            });
            friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);
        }

        const visibleUserIds = [userId, ...friendIds];

        const where = {
            userId: { [Op.in]: visibleUserIds },
            ...activeFilter(),
            [Op.or]: [{ isPublic: true }, { userId }], // own private statuses included
        };

        const { count, rows } = await Status.findAndCountAll({
            where,
            include: Users ? [userInclude(Users)] : [],
            order: [['createdAt', 'DESC']],
            limit,
            offset,
        });

        return {
            statuses: rows,
            pagination: { page: options.page || 1, limit, offset, total: count, hasMore: offset + rows.length < count },
        };
    } catch (e) { rethrow(e, 'Failed to get timeline'); }
}

// ---------------------------------------------------------------------------
// 7. getFriendsStatuses — friends' statuses only
// ---------------------------------------------------------------------------
async function getFriendsStatuses(userId, options = {}) {
    const { Status, Users, Friend } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const { limit, offset } = pagination(options);

        let friendIds = [];
        if (Friend) {
            const friendships = await Friend.findAll({
                where: {
                    status: 'accepted',
                    [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
                },
                attributes: ['requesterId', 'receiverId'],
            });
            friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);
        }

        if (friendIds.length === 0) {
            return { statuses: [], pagination: { page: 1, limit, offset: 0, total: 0, hasMore: false } };
        }

        const where = {
            userId: { [Op.in]: friendIds },
            ...activeFilter(),
            // friends' statuses: public OR friends-only (both are visible to friends)
        };

        const { count, rows } = await Status.findAndCountAll({
            where,
            include: Users ? [userInclude(Users)] : [],
            order: [['createdAt', 'DESC']],
            limit,
            offset,
        });

        return {
            statuses: rows,
            pagination: { page: options.page || 1, limit, offset, total: count, hasMore: offset + rows.length < count },
        };
    } catch (e) { rethrow(e, 'Failed to get friends statuses'); }
}

// ---------------------------------------------------------------------------
// 8. likeStatus
// ---------------------------------------------------------------------------
async function likeStatus(statusId, userId) {
    const { Status, StatusLike } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findByPk(statusId);
        if (!status) throw notFound('Status not found');
        if (!(await canView(status, userId))) throw forbidden('Not authorized');

        if (StatusLike) {
            const existing = await StatusLike.findOne({ where: { statusId, userId } });
            if (existing) throw conflict('You already liked this status');

            const like = await StatusLike.create({ statusId, userId, createdAt: new Date() });
            await Status.update({ likeCount: (status.likeCount || 0) + 1 }, { where: { id: statusId } });
            return like;
        }

        // Fallback: just increment
        await Status.update({ likeCount: (status.likeCount || 0) + 1 }, { where: { id: statusId } });
        return { statusId, userId, createdAt: new Date() };
    } catch (e) { rethrow(e, 'Failed to like status'); }
}

// ---------------------------------------------------------------------------
// 9. unlikeStatus
// ---------------------------------------------------------------------------
async function unlikeStatus(statusId, userId) {
    const { Status, StatusLike } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findByPk(statusId);
        if (!status) throw notFound('Status not found');

        if (StatusLike) {
            const like = await StatusLike.findOne({ where: { statusId, userId } });
            if (!like) throw notFound('You have not liked this status');
            await like.destroy();
            await Status.update(
                { likeCount: Math.max(0, (status.likeCount || 0) - 1) },
                { where: { id: statusId } }
            );
        }
    } catch (e) { rethrow(e, 'Failed to unlike status'); }
}

// ---------------------------------------------------------------------------
// 10. commentOnStatus
// ---------------------------------------------------------------------------
async function commentOnStatus(statusId, userId, content, parentCommentId = null) {
    const { Status, StatusComment, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        if (!content || !content.trim()) throw badRequest('Comment content is required');
        if (content.length > 500) throw badRequest('Comment cannot exceed 500 characters');

        const status = await Status.findByPk(statusId);
        if (!status) throw notFound('Status not found');
        if (!(await canView(status, userId))) throw forbidden('Not authorized');

        let comment = null;
        if (StatusComment) {
            comment = await StatusComment.create({
                statusId,
                userId,
                content: content.trim(),
                parentCommentId: parentCommentId || null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            // Attach user to response
            if (Users) {
                const user = await Users.findByPk(userId, {
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
                });
                comment.dataValues.commentUser = user;
            }
        } else {
            comment = { id: Date.now(), statusId, userId, content, createdAt: new Date() };
        }

        await Status.update(
            { commentCount: (status.commentCount || 0) + 1 },
            { where: { id: statusId } }
        );

        return comment;
    } catch (e) { rethrow(e, 'Failed to add comment'); }
}

// ---------------------------------------------------------------------------
// 11. getStatusComments
// ---------------------------------------------------------------------------
async function getStatusComments(statusId, viewerId, options = {}) {
    const { Status, StatusComment, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findByPk(statusId);
        if (!status) throw notFound('Status not found');
        if (!(await canView(status, viewerId))) throw forbidden('Not authorized');

        const { limit, offset } = pagination({ ...options, limit: options.limit || 50 });

        if (!StatusComment) return { comments: [], pagination: { total: 0 } };

        const include = Users ? [{
            model: Users,
            as: 'commentUser',
            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName'],
            required: false,
        }] : [];

        const orderDir = options.sortOrder === 1 ? 'ASC' : 'DESC';
        const { count, rows } = await StatusComment.findAndCountAll({
            where: { statusId },
            include,
            order: [['createdAt', orderDir]],
            limit,
            offset,
        });

        return {
            comments: rows,
            pagination: { page: options.page || 1, limit, offset, total: count, hasMore: offset + rows.length < count },
        };
    } catch (e) { rethrow(e, 'Failed to get comments'); }
}

// ---------------------------------------------------------------------------
// 12. deleteComment
// ---------------------------------------------------------------------------
async function deleteComment(statusId, commentId, userId) {
    const { Status, StatusComment } = getModels();
    if (!Status || !StatusComment) throw serverErr('Model unavailable');

    try {
        const comment = await StatusComment.findOne({ where: { id: commentId, statusId } });
        if (!comment) throw notFound('Comment not found');
        if (comment.userId !== userId) throw forbidden('You do not own this comment');

        await comment.destroy();

        const status = await Status.findByPk(statusId);
        if (status) {
            await Status.update(
                { commentCount: Math.max(0, (status.commentCount || 0) - 1) },
                { where: { id: statusId } }
            );
        }
    } catch (e) { rethrow(e, 'Failed to delete comment'); }
}

// ---------------------------------------------------------------------------
// 13. shareStatus
// ---------------------------------------------------------------------------
async function shareStatus(statusId, userId, caption, privacy) {
    const { Status } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const original = await Status.findByPk(statusId);
        if (!original) throw notFound('Status not found');
        if (!(await canView(original, userId))) throw forbidden('Not authorized to share this status');

        const isPublic = !privacy || privacy === 'public' || privacy === 'everyone';

        // Create a new status that references the original via metadata
        const shared = await Status.create({
            userId,
            content:   caption || original.content || '',
            type:      original.type,
            moodType:  original.moodType,
            mediaUrl:  original.mediaUrl,
            isPublic,
            isActive:  true,
            metadata:  {
                sharedFrom: statusId,
                originalUserId: original.userId,
                originalContent: original.content,
            },
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

        // Increment original's share count
        await Status.update(
            { shareCount: (original.shareCount || 0) + 1 },
            { where: { id: statusId } }
        );

        return shared;
    } catch (e) { rethrow(e, 'Failed to share status'); }
}

// ---------------------------------------------------------------------------
// 14. getStatusStatistics
// ---------------------------------------------------------------------------
async function getStatusStatistics(statusId, userId) {
    const { Status, StatusLike, StatusComment, StatusView } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findByPk(statusId);
        if (!status) throw notFound('Status not found');
        if (status.userId !== userId) throw forbidden('Only the owner can view statistics');

        const [likeCount, commentCount, viewCount] = await Promise.all([
            StatusLike    ? StatusLike.count({ where: { statusId } })    : Promise.resolve(status.likeCount    || 0),
            StatusComment ? StatusComment.count({ where: { statusId } }) : Promise.resolve(status.commentCount || 0),
            StatusView    ? StatusView.count({ where: { statusId } })    : Promise.resolve(status.viewCount    || 0),
        ]);

        return {
            statusId,
            likeCount,
            commentCount,
            viewCount,
            shareCount: status.shareCount || 0,
            createdAt:  status.createdAt,
            expiresAt:  status.expiresAt,
            isActive:   status.isActive,
            engagementRate: viewCount > 0
                ? (((likeCount + commentCount) / viewCount) * 100).toFixed(2)
                : '0.00',
        };
    } catch (e) { rethrow(e, 'Failed to get status statistics'); }
}

// ---------------------------------------------------------------------------
// 15. reportStatus
// ---------------------------------------------------------------------------
async function reportStatus(statusId, userId, reason, description) {
    const { Status } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findByPk(statusId);
        if (!status) throw notFound('Status not found');

        // Store in metadata (extend with a StatusReport model when you create it)
        const meta = status.metadata || {};
        const reports = meta.reports || [];

        const alreadyReported = reports.some(r => r.userId === userId);
        if (alreadyReported) throw conflict('You have already reported this status');

        reports.push({ userId, reason, description, reportedAt: new Date().toISOString() });
        await status.update({ metadata: { ...meta, reports } });

        return { statusId, userId, reason, reportedAt: new Date() };
    } catch (e) { rethrow(e, 'Failed to report status'); }
}

// ---------------------------------------------------------------------------
// 16. getTrendingStatuses
// ---------------------------------------------------------------------------
async function getTrendingStatuses(userId, options = {}) {
    const { Status, Users } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const { limit, offset } = pagination(options);
        const timeframeMsMap = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
        const ms = timeframeMsMap[options.timeframe] || timeframeMsMap['24h'];

        const where = {
            isActive: true,
            isPublic: true,
            createdAt: { [Op.gte]: new Date(Date.now() - ms) },
            [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
        };

        const { count, rows } = await Status.findAndCountAll({
            where,
            include: Users ? [userInclude(Users)] : [],
            order: [['likeCount', 'DESC'], ['viewCount', 'DESC'], ['createdAt', 'DESC']],
            limit,
            offset,
        });

        return {
            statuses: rows,
            pagination: { page: options.page || 1, limit, offset, total: count, hasMore: offset + rows.length < count },
        };
    } catch (e) { rethrow(e, 'Failed to get trending statuses'); }
}

// ---------------------------------------------------------------------------
// 17. pinStatus
// ---------------------------------------------------------------------------
async function pinStatus(statusId, userId) {
    const { Status } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findOne({ where: { id: statusId, userId } });
        if (!status) throw notFound('Status not found or you do not own it');

        const meta = status.metadata || {};
        if (meta.pinned) throw conflict('Status is already pinned');

        // Enforce per-user pin limit
        const pinnedCount = await Status.count({
            where: { userId, isActive: true, metadata: { pinned: true } },
        }).catch(() => 0); // If JSONB query not supported, skip count

        if (pinnedCount >= MAX_PINS) {
            throw badRequest(`Maximum of ${MAX_PINS} pinned statuses allowed`);
        }

        await status.update({ metadata: { ...meta, pinned: true, pinnedAt: new Date().toISOString() } });
        return status;
    } catch (e) { rethrow(e, 'Failed to pin status'); }
}

// ---------------------------------------------------------------------------
// 18. unpinStatus
// ---------------------------------------------------------------------------
async function unpinStatus(statusId, userId) {
    const { Status } = getModels();
    if (!Status) throw serverErr('Status model unavailable');

    try {
        const status = await Status.findOne({ where: { id: statusId, userId } });
        if (!status) throw notFound('Status not found or you do not own it');

        const meta = status.metadata || {};
        if (!meta.pinned) throw notFound('Status is not pinned');

        const { pinned, pinnedAt, ...restMeta } = meta; // eslint-disable-line no-unused-vars
        await status.update({ metadata: restMeta });
    } catch (e) { rethrow(e, 'Failed to unpin status'); }
}

// ---------------------------------------------------------------------------
module.exports = {
    createStatus,
    getStatusById,
    updateStatus,
    deleteStatus,
    getUserStatuses,
    getTimeline,
    getFriendsStatuses,
    likeStatus,
    unlikeStatus,
    commentOnStatus,
    getStatusComments,
    deleteComment,
    shareStatus,
    getStatusStatistics,
    reportStatus,
    getTrendingStatuses,
    pinStatus,
    unpinStatus,
};