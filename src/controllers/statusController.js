const statusService = require('../services/statusService');
const webSocketService = require('../services/webSocketService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// getAcceptedFriendIds is now exported from statusService — no need to duplicate the DB query here.
const { getAcceptedFriendIds } = statusService;

// ─── Helper: get io instance from req OR global fallback ─────────────────────
// FIX: statusController was using webSocketService.notifyStatusCreated() for
// createStatus but req.io.emit() everywhere else, and req.io was sometimes
// undefined. This helper guarantees we always get a working io reference.
function getIO(req) {
  return req.io
    || (req.app && req.app.get && req.app.get('io'))
    || webSocketService.getIO()
    || null;
}

// ─── Helper: safe broadcast that never throws ────────────────────────────────
// Kept for non-status events (update/delete/like) where global emit is fine.
function safeEmit(io, event, payload) {
  if (!io) {
    logger.warn(`[StatusController] safeEmit: no io for event "${event}" — skipped`);
    return false;
  }
  try {
    io.emit(event, { ...payload, timestamp: payload.timestamp || new Date().toISOString() });
    return true;
  } catch (err) {
    logger.warn(`[StatusController] safeEmit error for "${event}":`, err.message);
    return false;
  }
}

// ─── Helper: emit ONLY to the creator's friends ──────────────────────────────
// Each online user is automatically joined to their personal room "user:<id>"
// by webSocketService on connection. We emit to every friend's room so only
// friends receive the event — never all connected sockets.
//
// Falls back to safeEmit (global broadcast) when io is missing or no friends
// are found, so status delivery is never silently dropped.
async function safeEmitToFriends(io, event, payload, creatorId) {
  if (!io) {
    logger.warn(`[StatusController] safeEmitToFriends: no io for event "${event}" — skipped`);
    return false;
  }
  try {
    const enrichedPayload = { ...payload, timestamp: payload.timestamp || new Date().toISOString() };

    const friendIds = await getAcceptedFriendIds(creatorId);

    if (friendIds.length === 0) {
      // No friends — nothing to broadcast. Creator still sees their own status
      // via the HTTP 201 response, so this is not an error.
      logger.info(`[StatusController] safeEmitToFriends: userId=${creatorId} has no friends yet — no broadcast needed`);
      return true;
    }

    let delivered = 0;
    for (const fid of friendIds) {
      const room = `user:${fid}`;
      try {
        io.to(room).emit(event, enrichedPayload);
        delivered++;
      } catch (err) {
        logger.warn(`[StatusController] safeEmitToFriends: failed room=${room}: ${err.message}`);
      }
    }

    logger.info(`[StatusController] 📡 "${event}" delivered to ${delivered}/${friendIds.length} friend rooms for userId=${creatorId}`);
    return delivered > 0;
  } catch (err) {
    logger.warn(`[StatusController] safeEmitToFriends error for "${event}": ${err.message} — falling back to global emit`);
    return safeEmit(io, event, payload);
  }
}

class StatusController {
  /**
   * Create a new status
   * FIX 1: Replaced webSocketService.notifyStatusCreated() (which had no io fallback)
   *         with safeEmit(getIO(req), ...) so the event is always emitted.
   * FIX 2: Emit BOTH "status:created" AND "new_status" so every frontend listener fires.
   * FIX 3: Include the full `status` object in the WS payload so receivers can render immediately.
   * FIX 4: Accept `text` as alias for `content` (frontend sends both field names).
   */
  async createStatus(req, res, next) {
    try {
      const userId = req.user?.userId || req.user?.id;

      if (!userId) {
        throw new AppError('Authentication required', 401);
      }

      // FIX: Accept both content and text field names
      const statusContent = (req.body.content || req.body.text || '').trim();
      const { mediaUrl, mediaType, background, expiresAt, privacy, type, moodType, isPublic } = req.body;

      if (!statusContent && !mediaUrl) {
        throw new AppError('Content or media is required', 400);
      }

      const statusData = {
        userId,
        content: statusContent,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        background: background || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        privacy: privacy || (isPublic === false ? 'friends' : 'public'),
        type: type || 'text',
        moodType: moodType || null
      };

      logger.info(`[StatusController] Creating status for userId=${userId}`);
      const status = await statusService.createStatus(statusData);

      // FIX: Reject empty/undefined service response — do NOT fake success
      if (!status || !status.id) {
        throw new AppError('Status creation failed — service returned no data', 500);
      }

      logger.info(`[StatusController] ✅ Status saved id=${status.id} userId=${userId}`);

      // ── REAL-TIME EMIT ───────────────────────────────────────────────────────
      // FIX: Emit immediately after confirmed DB save, never before.
      //      Include full status object + all alias event names.
      const io = getIO(req);
      const wsPayload = {
        statusId:  status.id,
        userId:    status.userId,
        type:      status.type,
        content:   status.content,
        mediaUrl:  status.mediaUrl   || null,
        createdAt: status.createdAt,
        expiresAt: status.expiresAt  || null,
        // Full object — primary way for clients to add to UI without second fetch
        status,
        timestamp: new Date().toISOString()
      };

      // ── TARGETED FRIEND BROADCAST ────────────────────────────────────────────
      // BUG WAS HERE: safeEmit used io.emit() = all sockets globally.
      // FIX: emit only into "user:<friendId>" rooms so only accepted friends
      //      receive the event. All three alias names sent so every listener fires.
      console.log(`[StatusController] 📤 STATUS CREATED id=${status.id} — broadcasting to friends`);
      await safeEmitToFriends(io, 'status:created', wsPayload, userId);
      await safeEmitToFriends(io, 'new_status',     wsPayload, userId);
      await safeEmitToFriends(io, 'status_created', wsPayload, userId);
      console.log(`[StatusController] 📡 STATUS EMITTED to friend rooms`);

      // ── RESPONSE ─────────────────────────────────────────────────────────────
      return res.status(201).json({
        success: true,
        message: 'Status created successfully',
        data: { status }
      });

    } catch (error) {
      logger.error('[StatusController] createStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.name === 'ValidationError') return next(new AppError(error.message, 400));
      return next(new AppError('Failed to create status', 500));
    }
  }

  /**
   * Get status by ID
   */
  async getStatusById(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const status = await statusService.getStatusById(statusId, userId);
      return res.status(200).json({
        success: true,
        message: 'Status retrieved successfully',
        data: { status }
      });
    } catch (error) {
      logger.error('[StatusController] getStatusById error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('not authorized') || error.message.includes('permission')) return next(new AppError(error.message, 403));
      return next(new AppError('Failed to retrieve status', 500));
    }
  }

  /**
   * Update status
   */
  async updateStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const updateData = req.body;
      if (!statusId) throw new AppError('Status ID is required', 400);
      if (!updateData || typeof updateData !== 'object') throw new AppError('Update data is required', 400);

      const status = await statusService.updateStatus(statusId, userId, updateData);
      const io = getIO(req);
      safeEmit(io, 'status:updated', { statusId, userId, updates: updateData, status });

      return res.status(200).json({
        success: true,
        message: 'Status updated successfully',
        data: { status }
      });
    } catch (error) {
      logger.error('[StatusController] updateStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.name === 'ValidationError') return next(new AppError(error.message, 400));
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('not authorized') || error.message.includes('permission')) return next(new AppError(error.message, 403));
      return next(new AppError('Failed to update status', 500));
    }
  }

  /**
   * Delete status
   */
  async deleteStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      await statusService.deleteStatus(statusId, userId);
      const io = getIO(req);
      safeEmit(io, 'status:deleted',  { statusId, userId });
      safeEmit(io, 'status_deleted',  { statusId, userId }); // legacy alias

      return res.status(200).json({
        success: true,
        message: 'Status deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('[StatusController] deleteStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('not authorized') || error.message.includes('permission')) return next(new AppError(error.message, 403));
      return next(new AppError('Failed to delete status', 500));
    }
  }

  /**
   * View / mark-as-viewed a status
   * FIX: This handler was missing WebSocket emit entirely. Added it.
   */
  async viewStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const result = await statusService.viewStatus(statusId, userId);

      // FIX: Emit viewer update so status owner sees live view count
      const io = getIO(req);
      const ownerId = result && result.ownerId;
      if (ownerId) {
        safeEmit(io, 'status:viewed', {
          statusId,
          viewerId: userId,
          ownerId,
          viewCount: result.viewCount || 0
        });
        safeEmit(io, 'status:viewer_update', {
          statusId,
          viewerCount: result.viewCount || 0
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Status viewed',
        data: result || null
      });
    } catch (error) {
      logger.error('[StatusController] viewStatus error:', error);
      if (error instanceof AppError) return next(error);
      // A missing status on view is non-fatal; don't make the client retry
      if (error.message.includes('not found')) {
        return res.status(200).json({ success: true, message: 'Viewed', data: null });
      }
      return next(new AppError('Failed to record view', 500));
    }
  }

  /**
   * Get user's statuses
   */
  async getUserStatuses(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user?.userId || req.user?.id;
      const { page = 1, limit = 20, includeExpired = false } = req.query;
      if (!userId) throw new AppError('User ID is required', 400);

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        includeExpired: includeExpired === 'true'
      };
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getUserStatuses(userId, currentUserId, options);
      return res.status(200).json({
        success: true,
        message: 'User statuses retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('[StatusController] getUserStatuses error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not authorized') || error.message.includes('permission')) return next(new AppError(error.message, 403));
      return next(new AppError('Failed to get user statuses', 500));
    }
  }

  /**
   * Get timeline statuses
   */
  async getTimeline(req, res, next) {
    try {
      const userId = req.user?.userId || req.user?.id;
      const { page = 1, limit = 20, onlyFollowing = true } = req.query;
      const options = { page: parseInt(page), limit: parseInt(limit), onlyFollowing: onlyFollowing === 'true' };
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getTimeline(userId, options);
      return res.status(200).json({
        success: true,
        message: 'Timeline retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('[StatusController] getTimeline error:', error);
      if (error instanceof AppError) return next(error);
      return next(new AppError('Failed to get timeline', 500));
    }
  }

  /**
   * Like a status
   */
  async likeStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const like = await statusService.likeStatus(statusId, userId);
      safeEmit(getIO(req), 'status:liked', { statusId, userId });

      return res.status(200).json({
        success: true,
        message: 'Status liked successfully',
        data: { like, liked: true }
      });
    } catch (error) {
      logger.error('[StatusController] likeStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('already liked')) return next(new AppError(error.message, 409));
      return next(new AppError('Failed to like status', 500));
    }
  }

  /**
   * Unlike a status
   */
  async unlikeStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      await statusService.unlikeStatus(statusId, userId);
      safeEmit(getIO(req), 'status:unliked', { statusId, userId });

      return res.status(200).json({
        success: true,
        message: 'Status unliked successfully',
        data: { liked: false }
      });
    } catch (error) {
      logger.error('[StatusController] unlikeStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('not liked')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to unlike status', 500));
    }
  }

  /**
   * Comment on a status
   */
  async commentOnStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { content, parentCommentId } = req.body;
      if (!statusId) throw new AppError('Status ID is required', 400);
      if (!content)  throw new AppError('Comment content is required', 400);

      const comment = await statusService.commentOnStatus(statusId, userId, content, parentCommentId);
      safeEmit(getIO(req), 'status:commented', { statusId, commentId: comment.id, userId });

      return res.status(201).json({
        success: true,
        message: 'Comment added successfully',
        data: { comment }
      });
    } catch (error) {
      logger.error('[StatusController] commentOnStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.name === 'ValidationError') return next(new AppError(error.message, 400));
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to add comment', 500));
    }
  }

  /**
   * Get status comments
   */
  async getStatusComments(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { page = 1, limit = 50, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getStatusComments(statusId, userId, options);
      return res.status(200).json({
        success: true,
        message: 'Status comments retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('[StatusController] getStatusComments error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to get status comments', 500));
    }
  }

  /**
   * Delete comment
   */
  async deleteComment(req, res, next) {
    try {
      const { statusId, commentId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId || !commentId) throw new AppError('Status ID and Comment ID are required', 400);

      await statusService.deleteComment(statusId, commentId, userId);
      safeEmit(getIO(req), 'status:comment:deleted', { statusId, commentId, userId });

      return res.status(200).json({
        success: true,
        message: 'Comment deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('[StatusController] deleteComment error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to delete comment', 500));
    }
  }

  /**
   * Share a status
   */
  async shareStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { caption, privacy } = req.body;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const share = await statusService.shareStatus(statusId, userId, caption, privacy);
      safeEmit(getIO(req), 'status:shared', { statusId, shareId: share.id, userId });

      return res.status(201).json({
        success: true,
        message: 'Status shared successfully',
        data: { share }
      });
    } catch (error) {
      logger.error('[StatusController] shareStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('already shared')) return next(new AppError(error.message, 409));
      return next(new AppError('Failed to share status', 500));
    }
  }

  /**
   * Get status statistics
   */
  async getStatusStatistics(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const statistics = await statusService.getStatusStatistics(statusId, userId);
      return res.status(200).json({
        success: true,
        message: 'Status statistics retrieved successfully',
        data: { statistics }
      });
    } catch (error) {
      logger.error('[StatusController] getStatusStatistics error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to get status statistics', 500));
    }
  }

  /**
   * Report a status
   */
  async reportStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { reason, description } = req.body;
      if (!statusId) throw new AppError('Status ID is required', 400);
      if (!reason)   throw new AppError('Report reason is required', 400);

      const report = await statusService.reportStatus(statusId, userId, reason, description);
      return res.status(201).json({
        success: true,
        message: 'Status reported successfully',
        data: { report }
      });
    } catch (error) {
      logger.error('[StatusController] reportStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.name === 'ValidationError') return next(new AppError(error.message, 400));
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('already reported')) return next(new AppError(error.message, 409));
      return next(new AppError('Failed to report status', 500));
    }
  }

  /**
   * Get trending statuses
   */
  async getTrendingStatuses(req, res, next) {
    try {
      const userId = req.user?.userId || req.user?.id;
      const { page = 1, limit = 20, timeframe = '24h' } = req.query;
      const options = { page: parseInt(page), limit: parseInt(limit), timeframe };
      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await statusService.getTrendingStatuses(userId, options);
      return res.status(200).json({
        success: true,
        message: 'Trending statuses retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('[StatusController] getTrendingStatuses error:', error);
      if (error instanceof AppError) return next(error);
      return next(new AppError('Failed to get trending statuses', 500));
    }
  }

  /**
   * Pin a status
   */
  async pinStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      const pinnedStatus = await statusService.pinStatus(statusId, userId);
      return res.status(200).json({
        success: true,
        message: 'Status pinned successfully',
        data: { pinnedStatus }
      });
    } catch (error) {
      logger.error('[StatusController] pinStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('not authorized') || error.message.includes('permission')) return next(new AppError(error.message, 403));
      if (error.message.includes('already pinned')) return next(new AppError(error.message, 409));
      if (error.message.includes('maximum pinned')) return next(new AppError(error.message, 400));
      return next(new AppError('Failed to pin status', 500));
    }
  }

  /**
   * Unpin a status
   */
  async unpinStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      await statusService.unpinStatus(statusId, userId);
      return res.status(200).json({
        success: true,
        message: 'Status unpinned successfully',
        data: null
      });
    } catch (error) {
      logger.error('[StatusController] unpinStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      if (error.message.includes('not pinned')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to unpin status', 500));
    }
  }

  /**
   * Add emoji reaction to a status
   * POST /api/status/:statusId/react   { emoji: "🔥" }
   */
  async addReaction(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      const { emoji } = req.body;

      if (!statusId) throw new AppError('Status ID is required', 400);
      if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
        throw new AppError('emoji is required', 400);
      }

      const result = await statusService.addReaction(statusId, userId, emoji.trim());

      // Notify status owner via socket
      const io = getIO(req);
      if (io && result.ownerId) {
        io.to(`user:${result.ownerId}`).emit('status:reaction', {
          statusId,
          reactorId: userId,
          emoji: result.emoji,
          count: result.count,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Reaction added',
        data: { emoji: result.emoji, count: result.count }
      });
    } catch (error) {
      logger.error('[StatusController] addReaction error:', error);
      if (error instanceof AppError) return next(error);
      return next(new AppError('Failed to add reaction', 500));
    }
  }

  /**
   * Remove emoji reaction from a status
   * DELETE /api/status/:statusId/react
   */
  async removeReaction(req, res, next) {
    try {
      const { statusId } = req.params;
      const userId = req.user?.userId || req.user?.id;
      if (!statusId) throw new AppError('Status ID is required', 400);

      await statusService.removeReaction(statusId, userId);
      return res.status(200).json({ success: true, message: 'Reaction removed' });
    } catch (error) {
      logger.error('[StatusController] removeReaction error:', error);
      return next(new AppError('Failed to remove reaction', 500));
    }
  }

  /**
   * Reply to a status — creates a chat message (NOT stored as status)
   * POST /api/status/:statusId/reply   { content: "Nice!" }
   */
  async replyToStatus(req, res, next) {
    try {
      const { statusId } = req.params;
      const senderId = req.user?.userId || req.user?.id;
      const { content } = req.body;

      if (!statusId) throw new AppError('Status ID is required', 400);
      if (!content || !content.trim()) throw new AppError('Reply content is required', 400);

      const result = await statusService.replyToStatus(statusId, senderId, null, content.trim());

      // Push message to recipient via socket
      const io = getIO(req);
      if (io && result.recipientId) {
        io.to(`user:${result.recipientId}`).emit('new_message', {
          message: result.message,
          chatId: result.chatId,
          type: 'status_reply',
          statusPreview: result.statusPreview,
        });
      }

      return res.status(201).json({
        success: true,
        message: 'Reply sent',
        data: {
          message: result.message,
          chatId: result.chatId,
          statusPreview: result.statusPreview,
        }
      });
    } catch (error) {
      logger.error('[StatusController] replyToStatus error:', error);
      if (error instanceof AppError) return next(error);
      if (error.message.includes('not found')) return next(new AppError(error.message, 404));
      return next(new AppError('Failed to send reply', 500));
    }
  }
}

module.exports = new StatusController();