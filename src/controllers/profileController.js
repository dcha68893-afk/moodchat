const profileService = require('../services/profileService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
// FIX (FOLLOW/UNFOLLOW/FOLLOWERS/FOLLOWING WERE STUBS): followUser/unfollowUser always
// returned success without writing anything, and getFollowers/getFollowing always returned
// an empty list — there was no Follow model at all. This is the real, persisted version,
// backed by the new Follow model (src/models/Follow.js). Also used by the Vibes "Following"
// tab (src/routes/status.js) so it shows genuinely different content from "Friends".
const db = require('../models');
const getFollowModel = () => (db.models && db.models.Follow) || db.Follow || null;
const getUsersModel = () => (db.models && db.models.Users) || db.Users || db.User || null;
const getBlockModel = () => (db.models && db.models.UserBlock) || db.UserBlock || null;
const notificationService = require('../services/notificationService');

class ProfileController {
  async getProfile(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const profile = await profileService.getProfile(userId, currentUserId);

      res.status(200).json({
        success: true,
        message: 'Profile retrieved successfully',
        data: {
          profile
        }
      });
    } catch (error) {
      logger.error('Get profile controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else if (error.message.includes('blocked')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get profile', 500));
      }
    }
  }

  async updateProfile(req, res, next) {
    try {
      const userId = req.user.id;
      const updateData = req.body;

      if (!updateData || typeof updateData !== 'object') {
        throw new AppError('Update data is required', 400);
      }

      const profile = await profileService.updateProfile(userId, updateData);

      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: {
          profile
        }
      });
    } catch (error) {
      logger.error('Update profile controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to update profile', 500));
      }
    }
  }

  async uploadProfilePicture(req, res, next) {
    try {
      const userId = req.user.id;
      
      if (!req.file) {
        throw new AppError('Profile picture file is required', 400);
      }

      const profile = await profileService.updateProfilePicture(userId, req.file);

      res.status(200).json({
        success: true,
        message: 'Profile picture uploaded successfully',
        data: {
          profile,
          pictureUrl: profile.profilePicture
        }
      });
    } catch (error) {
      logger.error('Upload profile picture controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to upload profile picture', 500));
      }
    }
  }

  async uploadCoverPhoto(req, res, next) {
    try {
      const userId = req.user.id;
      
      if (!req.file) {
        throw new AppError('Cover photo file is required', 400);
      }

      const profile = await profileService.uploadCoverPhoto(userId, req.file);

      res.status(200).json({
        success: true,
        message: 'Cover photo uploaded successfully',
        data: {
          profile,
          coverUrl: profile.coverPhoto
        }
      });
    } catch (error) {
      logger.error('Upload cover photo controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to upload cover photo', 500));
      }
    }
  }

  async deleteProfilePicture(req, res, next) {
    try {
      const userId = req.user.id;

      const profile = await profileService.deleteProfilePicture(userId);

      res.status(200).json({
        success: true,
        message: 'Profile picture deleted successfully',
        data: {
          profile
        }
      });
    } catch (error) {
      logger.error('Delete profile picture controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to delete profile picture', 500));
      }
    }
  }

  async deleteCoverPhoto(req, res, next) {
    try {
      const userId = req.user.id;

      const profile = await profileService.deleteCoverPhoto(userId);

      res.status(200).json({
        success: true,
        message: 'Cover photo deleted successfully',
        data: {
          profile
        }
      });
    } catch (error) {
      logger.error('Delete cover photo controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to delete cover photo', 500));
      }
    }
  }

  async updateProfilePrivacy(req, res, next) {
    try {
      const userId = req.user.id;
      const { privacySettings } = req.body;

      if (!privacySettings || typeof privacySettings !== 'object') {
        throw new AppError('Privacy settings are required', 400);
      }

      const profile = await profileService.updatePrivacySettings(userId, privacySettings);

      res.status(200).json({
        success: true,
        message: 'Profile privacy updated successfully',
        data: {
          profile,
          privacy: profile
        }
      });
    } catch (error) {
      logger.error('Update profile privacy controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to update profile privacy', 500));
      }
    }
  }

  async changePassword(req, res, next) {
    try {
      const userId = req.user.id;
      const passwordData = req.body;

      const result = await profileService.changePassword(userId, passwordData);

      res.status(200).json({
        success: true,
        message: 'Password changed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Change password controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to change password', 500));
      }
    }
  }

  async getProfileViews(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        timeframe = '30d',
        groupBy = 'day'
      } = req.query;

      res.status(200).json({
        success: true,
        message: 'Profile views retrieved successfully',
        data: {
          views: [],
          totalViews: 0,
          timeframe,
          groupBy
        }
      });
    } catch (error) {
      logger.error('Get profile views controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get profile views', 500));
      }
    }
  }

  async getProfileVisitors(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        startDate,
        endDate,
        sortBy = 'visitedAt',
        sortOrder = 'desc'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      res.status(200).json({
        success: true,
        message: 'Profile visitors retrieved successfully',
        data: {
          visitors: [],
          total: 0,
          page: options.page,
          limit: options.limit,
          totalPages: 0
        }
      });
    } catch (error) {
      logger.error('Get profile visitors controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get profile visitors', 500));
      }
    }
  }

  async getProfileStatistics(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (userId !== currentUserId.toString() && !req.user.isAdmin) {
        throw new AppError('Not authorized to view this user\'s profile statistics', 403);
      }

      res.status(200).json({
        success: true,
        message: 'Profile statistics retrieved successfully',
        data: {
          statistics: {}
        }
      });
    } catch (error) {
      logger.error('Get profile statistics controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get profile statistics', 500));
      }
    }
  }

  async searchProfiles(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        query,
        page = 1, 
        limit = 20,
        onlineOnly = false,
        verifiedOnly = false,
        sortBy = 'relevance',
        sortOrder = 'desc'
      } = req.query;

      if (!query) {
        throw new AppError('Search query is required', 400);
      }

      const options = {
        query,
        page: parseInt(page),
        limit: parseInt(limit),
        onlineOnly: onlineOnly === 'true',
        verifiedOnly: verifiedOnly === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      if (options.page < 1 || options.limit < 1 || options.limit > 50) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      res.status(200).json({
        success: true,
        message: 'Profiles search completed successfully',
        data: {
          profiles: [],
          total: 0,
          page: options.page,
          limit: options.limit,
          totalPages: 0
        }
      });
    } catch (error) {
      logger.error('Search profiles controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to search profiles', 500));
      }
    }
  }

  async followUser(req, res, next) {
    try {
      const { userId } = req.params;
      const followerId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (userId === followerId.toString()) {
        throw new AppError('Cannot follow yourself', 400);
      }

      const Follow = getFollowModel();
      if (!Follow) throw new AppError('Follow is unavailable', 503);
      const Users = getUsersModel();
      if (Users) {
        const target = await Users.findByPk(Number(userId), { attributes: ['id'] });
        if (!target) throw new AppError('User not found', 404);
      }
      const Block = getBlockModel();
      if (Block && await Block.isBlockedEitherWay(followerId, userId)) {
        throw new AppError('Unable to follow this user', 403);
      }
      const [followRow, created] = await Follow.findOrCreate({ where: { followerId: Number(followerId), followingId: Number(userId) } });
      if (created) {
        const follower = Users ? await Users.findByPk(Number(followerId), { attributes: ['id','username','displayName','avatar'] }).catch(() => null) : null;
        await notificationService.createFromTemplate(Number(userId), 'follow_received', {
          followerId: Number(followerId),
          followerName: follower?.displayName || follower?.username || 'Someone',
          followerAvatar: follower?.avatar || null,
          followId: followRow?.id || null,
          actions: ['follow_back', 'dismiss']
        }).catch(error => logger.warn('Follow notification failed:', error.message));
      }
      const followerCount = await Follow.count({ where: { followingId: Number(userId) } });

      res.status(200).json({
        success: true,
        message: 'User followed successfully',
        data: {
          following: true,
          followerCount
        }
      });
    } catch (error) {
      logger.error('Follow user controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('already following')) {
        next(new AppError(error.message, 409));
      } else if (error.message.includes('blocked')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to follow user', 500));
      }
    }
  }

  async unfollowUser(req, res, next) {
    try {
      const { userId } = req.params;
      const followerId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const Follow = getFollowModel();
      if (!Follow) throw new AppError('Follow is unavailable', 503);
      await Follow.destroy({ where: { followerId: Number(followerId), followingId: Number(userId) } });
      const followerCount = await Follow.count({ where: { followingId: Number(userId) } });

      res.status(200).json({
        success: true,
        message: 'User unfollowed successfully',
        data: {
          following: false,
          followerCount
        }
      });
    } catch (error) {
      logger.error('Unfollow user controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not following')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to unfollow user', 500));
      }
    }
  }

  async getFollowers(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        mutualOnly = false,
        sortBy = 'followedAt',
        sortOrder = 'desc'
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        mutualOnly: mutualOnly === 'true',
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const Follow = getFollowModel();
      const Users = getUsersModel();
      if (!Follow || !Users) throw new AppError('Follow is unavailable', 503);
      const target = Number(userId);
      const total = await Follow.count({ where: { followingId: target } });
      const rows = await Follow.findAll({
        where: { followingId: target },
        order: [['createdAt', options.sortOrder === 1 ? 'ASC' : 'DESC']],
        offset: (options.page - 1) * options.limit,
        limit: options.limit
      });
      const ids = rows.map(r => r.followerId);
      const users = ids.length ? await Users.findAll({ where: { id: ids }, attributes: ['id', 'username', 'displayName', 'avatar'] }) : [];
      const byId = new Map(users.map(u => [u.id, u.toJSON()]));
      const followers = rows.map(r => ({ ...(byId.get(r.followerId) || { id: r.followerId }), followedAt: r.createdAt }));

      res.status(200).json({
        success: true,
        message: 'Followers retrieved successfully',
        data: {
          followers,
          total,
          page: options.page,
          limit: options.limit,
          totalPages: Math.ceil(total / options.limit)
        }
      });
    } catch (error) {
      logger.error('Get followers controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get followers', 500));
      }
    }
  }

  async getFollowing(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'followedAt',
        sortOrder = 'desc'
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const Follow = getFollowModel();
      const Users = getUsersModel();
      if (!Follow || !Users) throw new AppError('Follow is unavailable', 503);
      const source = Number(userId);
      const total = await Follow.count({ where: { followerId: source } });
      const rows = await Follow.findAll({
        where: { followerId: source },
        order: [['createdAt', options.sortOrder === 1 ? 'ASC' : 'DESC']],
        offset: (options.page - 1) * options.limit,
        limit: options.limit
      });
      const ids = rows.map(r => r.followingId);
      const users = ids.length ? await Users.findAll({ where: { id: ids }, attributes: ['id', 'username', 'displayName', 'avatar'] }) : [];
      const byId = new Map(users.map(u => [u.id, u.toJSON()]));
      const following = rows.map(r => ({ ...(byId.get(r.followingId) || { id: r.followingId }), followedAt: r.createdAt }));

      res.status(200).json({
        success: true,
        message: 'Following retrieved successfully',
        data: {
          following,
          total,
          page: options.page,
          limit: options.limit,
          totalPages: Math.ceil(total / options.limit)
        }
      });
    } catch (error) {
      logger.error('Get following controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get following', 500));
      }
    }
  }

  async getMutualConnections(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'commonCount',
        sortOrder = 'desc'
      } = req.query;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (userId === currentUserId.toString()) {
        throw new AppError('Cannot get mutual connections with yourself', 400);
      }

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      // FIX (getMutualConnections was a stub): this used to always return an empty
      // list regardless of who was asked about — never actually queried the Friend
      // table. Real implementation: pull each side's accepted-friend id set and
      // intersect them, same Friend.getUserFriends() helper used by /vibes and the
      // friends list elsewhere.
      const Friend = db.models && db.models.Friend;
      const Users = getUsersModel();
      if (!Friend || !Users) {
        return res.status(200).json({
          success: true,
          message: 'Mutual connections retrieved successfully',
          data: { connections: [], total: 0, page: options.page, limit: options.limit, totalPages: 0 }
        });
      }
      const targetUserId = parseInt(userId, 10);
      const target = await Users.findByPk(targetUserId, { attributes: ['id'] });
      if (!target) throw new AppError('User not found', 404);

      const [mine, theirs] = await Promise.all([
        Friend.getUserFriends(currentUserId, 'accepted'),
        Friend.getUserFriends(targetUserId, 'accepted')
      ]);
      const myFriendIds = new Set(mine.map(r => r.user && r.user.id).filter(Boolean));
      const mutualIds = [...new Set(theirs.map(r => r.user && r.user.id).filter(Boolean))]
        .filter(id => myFriendIds.has(id));

      const total = mutualIds.length;
      const totalPages = Math.ceil(total / options.limit) || 0;
      // sortBy is accepted for API compatibility, but with a flat mutual-friends
      // list (not a per-row shared-group count) the only meaningful field to sort
      // on is the person's name.
      const users = mutualIds.length
        ? await Users.findAll({ where: { id: mutualIds }, attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen'] })
        : [];
      const byId = new Map(users.map(u => [u.id, u.toJSON()]));
      const ordered = mutualIds
        .map(id => byId.get(id))
        .filter(Boolean)
        .sort((a, b) => options.sortOrder * String(a.username || '').localeCompare(String(b.username || '')));
      const start = (options.page - 1) * options.limit;
      const connections = ordered.slice(start, start + options.limit);

      res.status(200).json({
        success: true,
        message: 'Mutual connections retrieved successfully',
        data: {
          connections,
          total,
          page: options.page,
          limit: options.limit,
          totalPages
        }
      });
    } catch (error) {
      logger.error('Get mutual connections controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to get mutual connections', 500));
      }
    }
  }

  async blockUser(req, res, next) {
    try {
      const { userId } = req.params;
      const blockerId = req.user.id;
      const { reason } = req.body;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (userId === blockerId.toString()) {
        throw new AppError('Cannot block yourself', 400);
      }

      const Block = getBlockModel();
      if (!Block) throw new AppError('Blocking is unavailable', 503);
      const Follow = getFollowModel();
      await Block.findOrCreate({ where: { blockerId: Number(blockerId), blockedId: Number(userId) }, defaults: { reason: reason ? String(reason).slice(0, 300) : null } });
      // A block should also break any existing follow relationship in
      // either direction — otherwise a blocked user could still show up
      // in your Following feed (or you in theirs).
      if (Follow) {
        await Follow.destroy({ where: { followerId: Number(blockerId), followingId: Number(userId) } });
        await Follow.destroy({ where: { followerId: Number(userId), followingId: Number(blockerId) } });
      }

      res.status(200).json({
        success: true,
        message: 'User blocked successfully',
        data: {
          blocked: true
        }
      });
    } catch (error) {
      logger.error('Block user controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('already blocked')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to block user', 500));
      }
    }
  }

  async unblockUser(req, res, next) {
    try {
      const { userId } = req.params;
      const blockerId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const Block = getBlockModel();
      if (!Block) throw new AppError('Blocking is unavailable', 503);
      await Block.destroy({ where: { blockerId: Number(blockerId), blockedId: Number(userId) } });

      res.status(200).json({
        success: true,
        message: 'User unblocked successfully',
        data: {
          blocked: false
        }
      });
    } catch (error) {
      logger.error('Unblock user controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not blocked')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to unblock user', 500));
      }
    }
  }

  async getBlockedUsers(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        page = 1, 
        limit = 50,
        sortBy = 'blockedAt',
        sortOrder = 'desc'
      } = req.query;

      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder: sortOrder === 'desc' ? -1 : 1
      };

      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const Block = getBlockModel();
      const Users = getUsersModel();
      if (!Block || !Users) throw new AppError('Blocking is unavailable', 503);
      const total = await Block.count({ where: { blockerId: Number(userId) } });
      const rows = await Block.findAll({
        where: { blockerId: Number(userId) },
        order: [['createdAt', options.sortOrder === 1 ? 'ASC' : 'DESC']],
        offset: (options.page - 1) * options.limit,
        limit: options.limit
      });
      const ids = rows.map(r => r.blockedId);
      const users = ids.length ? await Users.findAll({ where: { id: ids }, attributes: ['id', 'username', 'displayName', 'avatar'] }) : [];
      const byId = new Map(users.map(u => [u.id, u.toJSON()]));
      const blockedUsers = rows.map(r => ({ ...(byId.get(r.blockedId) || { id: r.blockedId }), reason: r.reason || null, blockedAt: r.createdAt }));

      res.status(200).json({
        success: true,
        message: 'Blocked users retrieved successfully',
        data: {
          blockedUsers,
          total,
          page: options.page,
          limit: options.limit,
          totalPages: Math.ceil(total / options.limit)
        }
      });
    } catch (error) {
      logger.error('Get blocked users controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to get blocked users', 500));
      }
    }
  }

  async reportProfile(req, res, next) {
    try {
      const { userId } = req.params;
      const reporterId = req.user.id;
      const { reason, description, evidence } = req.body;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (!reason) {
        throw new AppError('Report reason is required', 400);
      }

      if (userId === reporterId.toString()) {
        throw new AppError('Cannot report yourself', 400);
      }

      // ROOT-CAUSE FIX (ADMIN-NEVER-GETS-USER-REPORTS): this used to return a
      // fake success response without saving the report ANYWHERE — not even
      // a console log, let alone anything an admin could ever see. Persists
      // a durable Notification for every admin user instead (see the
      // matching fix in src/routes/friends.js's notifyAdminsOfReport for the
      // full rationale — same approach, no new DB migration required).
      try {
        const db = require('../models');
        const User = db.models?.Users || db.models?.User || db.User || db.Users;
        const Notification = db.Notification || db.Notifications || db.models?.Notification || db.models?.Notifications;
        if (User) {
          const admins = await User.findAll({ where: { role: 'admin' }, attributes: ['id'] });
          if (Notification && admins.length) {
            await Promise.all(admins.map(a => Notification.create({
              userId: a.id,
              type: 'warning',
              title: 'New profile report',
              message: `${reason}${description ? ' — ' + String(description).slice(0, 140) : ''}`,
              metadata: { reportType: 'profile', reporterId, targetId: userId, reason, description: description || null, evidence: evidence || null, ts: new Date().toISOString() },
              isRead: false,
            }).catch(e => logger.error('[ProfileReport] Notification.create failed:', e.message))));
          }
        }
        if (global._wsService?.getIO) {
          try { global._wsService.getIO().to('admin:reports').emit('new_report', { reportType: 'profile', reporterId, targetId: userId, reason }); } catch (_) {}
        }
      } catch (notifyErr) {
        logger.error('[ProfileReport] admin notify failed:', notifyErr.message);
      }

      res.status(201).json({
        success: true,
        message: 'Profile reported successfully',
        data: {
          report: { reason, description, evidence }
        }
      });
    } catch (error) {
      logger.error('Report profile controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('already reported')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to report profile', 500));
      }
    }
  }

  async verifyProfile(req, res, next) {
    try {
      const { userId } = req.params;
      const adminId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (!req.user.isAdmin) {
        throw new AppError('Not authorized to verify profiles', 403);
      }

      res.status(200).json({
        success: true,
        message: 'Profile verified successfully',
        data: {
          verification: { verified: true }
        }
      });
    } catch (error) {
      logger.error('Verify profile controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('already verified')) {
        next(new AppError(error.message, 409));
      } else {
        next(new AppError('Failed to verify profile', 500));
      }
    }
  }

  async getVerificationStatus(req, res, next) {
    try {
      const { userId } = req.params;
      const currentUserId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      res.status(200).json({
        success: true,
        message: 'Verification status retrieved successfully',
        data: {
          verification: { status: 'unverified' },
          isVerified: false
        }
      });
    } catch (error) {
      logger.error('Get verification status controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else if (error.message.includes('not authorized') || error.message.includes('permission')) {
        next(new AppError(error.message, 403));
      } else {
        next(new AppError('Failed to get verification status', 500));
      }
    }
  }

  async exportProfileData(req, res, next) {
    try {
      const userId = req.user.id;
      const { 
        format = 'json',
        includeFollowers = true,
        includeFollowing = true,
        includePosts = false,
        includeMessages = false
      } = req.query;

      const exportData = {
        userId,
        exportedAt: new Date().toISOString(),
        profile: {},
        followers: includeFollowers ? [] : undefined,
        following: includeFollowing ? [] : undefined,
        posts: includePosts ? [] : undefined,
        messages: includeMessages ? [] : undefined
      };

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=profile_data_${userId}_${new Date().toISOString().split('T')[0]}.csv`);
        return res.send('userId,exportedAt\n' + userId + ',' + new Date().toISOString());
      } else if (format === 'json') {
        res.status(200).json({
          success: true,
          message: 'Profile data exported successfully',
          data: exportData
        });
      } else {
        throw new AppError('Invalid export format. Use "json" or "csv"', 400);
      }
    } catch (error) {
      logger.error('Export profile data controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to export profile data', 500));
      }
    }
  }
}

module.exports = new ProfileController();