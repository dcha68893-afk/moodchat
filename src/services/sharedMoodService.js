const mongoose = require('mongoose');
const SharedMood = require('../models/SharedMood');
const User = require('../models/Users');
const Mood = require('../models/Mood');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

/**
 * Shared Mood Service
 * Handles sharing and discovery of user moods
 */
class SharedMoodService {
  /**
   * Share a mood with other users
   * @param {Object} shareData - Mood share data
   * @returns {Promise<Object>} Created mood share
   */
  async shareMood(shareData) {
    try {
      const { userId, moodId, visibility = 'friends', message, taggedUsers = [] } = shareData;

      // Validate required fields
      if (!userId || !moodId) {
        throw new ValidationError('User ID and mood ID are required');
      }

      // Validate visibility
      const validVisibilities = ['public', 'friends', 'private', 'specific'];
      if (!validVisibilities.includes(visibility)) {
        throw new ValidationError('Invalid visibility setting');
      }

      // Check if user exists
      const user = await User.findById(userId).select('_id username');
      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Check if mood exists and belongs to user
      const mood = await Mood.findById(moodId);
      if (!mood) {
        throw new NotFoundError('Mood not found');
      }

      if (mood.user.toString() !== userId) {
        throw new ForbiddenError('Mood does not belong to user');
      }

      // Check if mood is already shared
      const existingShare = await SharedMood.findOne({
        user: userId,
        mood: moodId,
        isActive: true,
      });

      if (existingShare) {
        throw new ValidationError('Mood is already shared');
      }

      // Validate tagged users if any
      if (taggedUsers.length > 0) {
        const validUsers = await User.find({
          _id: { $in: taggedUsers.map(id => new mongoose.Types.ObjectId(id)) },
        }).select('_id');

        if (validUsers.length !== taggedUsers.length) {
          throw new ValidationError('One or more tagged users not found');
        }
      }

      // Create shared mood record
      const sharedMood = new SharedMood({
        user: new mongoose.Types.ObjectId(userId),
        mood: new mongoose.Types.ObjectId(moodId),
        visibility,
        message: message || '',
        taggedUsers: taggedUsers.map(id => new mongoose.Types.ObjectId(id)),
        isActive: true,
        shareDate: new Date(),
        stats: {
          likes: 0,
          comments: 0,
          shares: 0,
          views: 0,
        },
      });

      await sharedMood.save();

      // Populate details for response
      await sharedMood.populate([
        { path: 'user', select: '_id username profilePicture' },
        { path: 'mood', select: '_id moodType intensity note createdAt' },
        { path: 'taggedUsers', select: '_id username profilePicture' },
      ]);

      return this._formatSharedMoodResponse(sharedMood);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error sharing mood:', error);
      throw new ServerError('Failed to share mood');
    }
  }

  /**
   * Get shared moods feed
   * @param {string} userId - User ID viewing the feed
   * @param {string} filter - Filter type (friends, public, trending)
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Shared moods feed with pagination
   */
  async getSharedMoodsFeed(userId, filter = 'friends', page = 1, limit = 20) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Validate filter
      const validFilters = ['friends', 'public', 'trending', 'following'];
      if (!validFilters.includes(filter)) {
        throw new ValidationError('Invalid filter type');
      }

      page = parseInt(page);
      limit = parseInt(limit);

      if (page < 1 || limit < 1 || limit > 50) {
        throw new ValidationError('Invalid pagination parameters');
      }

      const skip = (page - 1) * limit;

      // Build query based on filter
      let query = { isActive: true };
      let sort = { shareDate: -1 };

      switch (filter) {
        case 'friends':
          // Get user's friends (you need to implement friend logic)
          const friends = await this._getUserFriends(userId);
          query.user = { $in: friends };
          break;

        case 'public':
          query.visibility = 'public';
          break;

        case 'trending':
          query.visibility = 'public';
          // Calculate trending score based on recency and engagement
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);
          query.shareDate = { $gte: weekAgo };
          // Sort by engagement score
          sort = this._calculateTrendingSort();
          break;

        case 'following':
          // Get users that the current user follows
          const following = await this._getFollowingUsers(userId);
          query.user = { $in: following };
          break;
      }

      const [sharedMoods, total] = await Promise.all([
        SharedMood.find(query)
          .populate([
            { path: 'user', select: '_id username profilePicture' },
            { path: 'mood', select: '_id moodType intensity note createdAt' },
            { path: 'taggedUsers', select: '_id username profilePicture' },
          ])
          .sort(sort)
          .skip(skip)
          .limit(limit),
        SharedMood.countDocuments(query),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        sharedMoods: sharedMoods.map(mood => this._formatSharedMoodResponse(mood)),
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching shared moods feed:', error);
      throw new ServerError('Failed to fetch shared moods feed');
    }
  }

  /**
   * Like a shared mood
   * @param {string} sharedMoodId - Shared mood ID
   * @param {string} userId - User ID liking the mood
   * @returns {Promise<Object>} Updated shared mood
   */
  async likeSharedMood(sharedMoodId, userId) {
    try {
      if (!sharedMoodId || !userId) {
        throw new ValidationError('Shared mood ID and user ID are required');
      }

      const sharedMood = await SharedMood.findById(sharedMoodId);
      if (!sharedMood) {
        throw new NotFoundError('Shared mood not found');
      }

      // Check if user can view this shared mood
      const canView = await this._canUserViewSharedMood(userId, sharedMood);
      if (!canView) {
        throw new ForbiddenError('Cannot access this shared mood');
      }

      // Check if user already liked
      const alreadyLiked = sharedMood.likes.some(
        like => like.user.toString() === userId
      );

      if (alreadyLiked) {
        // Unlike
        sharedMood.likes = sharedMood.likes.filter(
          like => like.user.toString() !== userId
        );
        sharedMood.stats.likes = Math.max(0, sharedMood.stats.likes - 1);
      } else {
        // Like
        sharedMood.likes.push({
          user: new mongoose.Types.ObjectId(userId),
          likedAt: new Date(),
        });
        sharedMood.stats.likes += 1;
      }

      await sharedMood.save();

      await sharedMood.populate([
        { path: 'user', select: '_id username profilePicture' },
        { path: 'mood', select: '_id moodType intensity note createdAt' },
        { path: 'taggedUsers', select: '_id username profilePicture' },
        { path: 'likes.user', select: '_id username profilePicture' },
      ]);

      return this._formatSharedMoodResponse(sharedMood);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error liking shared mood:', error);
      throw new ServerError('Failed to like shared mood');
    }
  }

  /**
   * Comment on a shared mood
   * @param {string} sharedMoodId - Shared mood ID
   * @param {string} userId - User ID commenting
   * @param {string} comment - Comment text
   * @returns {Promise<Object>} Updated shared mood with new comment
   */
  async commentOnSharedMood(sharedMoodId, userId, comment) {
    try {
      if (!sharedMoodId || !userId || !comment) {
        throw new ValidationError('Shared mood ID, user ID, and comment are required');
      }

      if (comment.trim().length === 0) {
        throw new ValidationError('Comment cannot be empty');
      }

      const sharedMood = await SharedMood.findById(sharedMoodId);
      if (!sharedMood) {
        throw new NotFoundError('Shared mood not found');
      }

      // Check if user can view this shared mood
      const canView = await this._canUserViewSharedMood(userId, sharedMood);
      if (!canView) {
        throw new ForbiddenError('Cannot access this shared mood');
      }

      // Add comment
      sharedMood.comments.push({
        user: new mongoose.Types.ObjectId(userId),
        comment: comment.trim(),
        commentedAt: new Date(),
        isEdited: false,
      });

      sharedMood.stats.comments += 1;
      await sharedMood.save();

      // Get the newly added comment
      const newComment = sharedMood.comments[sharedMood.comments.length - 1];

      // Populate user details for the new comment
      await sharedMood.populate([
        { path: 'user', select: '_id username profilePicture' },
        { path: 'mood', select: '_id moodType intensity note createdAt' },
        { path: 'comments.user', select: '_id username profilePicture' },
      ]);

      const response = this._formatSharedMoodResponse(sharedMood);
      response.newComment = sharedMood.comments.find(
        c => c._id.toString() === newComment._id.toString()
      );

      return response;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error commenting on shared mood:', error);
      throw new ServerError('Failed to comment on shared mood');
    }
  }

  /**
   * Get shared moods by user
   * @param {string} targetUserId - User ID whose moods to fetch
   * @param {string} currentUserId - Current user ID for access control
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} User's shared moods
   */
  async getSharedMoodsByUser(targetUserId, currentUserId, page = 1, limit = 20) {
    try {
      if (!targetUserId) {
        throw new ValidationError('Target user ID is required');
      }

      page = parseInt(page);
      limit = parseInt(limit);

      if (page < 1 || limit < 1 || limit > 50) {
        throw new ValidationError('Invalid pagination parameters');
      }

      const skip = (page - 1) * limit;

      // Build query based on visibility
      let query = {
        user: new mongoose.Types.ObjectId(targetUserId),
        isActive: true,
      };

      // If not viewing own profile, only show allowed content
      if (targetUserId !== currentUserId) {
        const isFriend = await this._areUsersFriends(targetUserId, currentUserId);
        
        query.$or = [
          { visibility: 'public' },
          { visibility: 'friends', $and: [isFriend ? {} : { _id: null }] }, // Only include if friends
          { 
            visibility: 'specific',
            taggedUsers: new mongoose.Types.ObjectId(currentUserId),
          },
        ];
      }

      const [sharedMoods, total] = await Promise.all([
        SharedMood.find(query)
          .populate([
            { path: 'user', select: '_id username profilePicture' },
            { path: 'mood', select: '_id moodType intensity note createdAt' },
            { path: 'taggedUsers', select: '_id username profilePicture' },
          ])
          .sort({ shareDate: -1 })
          .skip(skip)
          .limit(limit),
        SharedMood.countDocuments(query),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        sharedMoods: sharedMoods.map(mood => this._formatSharedMoodResponse(mood)),
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching user shared moods:', error);
      throw new ServerError('Failed to fetch user shared moods');
    }
  }

  /**
   * Delete a shared mood
   * @param {string} sharedMoodId - Shared mood ID
   * @param {string} userId - User ID requesting deletion
   * @returns {Promise<Object>} Deletion result
   */
  async deleteSharedMood(sharedMoodId, userId) {
    try {
      if (!sharedMoodId || !userId) {
        throw new ValidationError('Shared mood ID and user ID are required');
      }

      const sharedMood = await SharedMood.findById(sharedMoodId);
      if (!sharedMood) {
        throw new NotFoundError('Shared mood not found');
      }

      // Check if user owns the shared mood
      if (sharedMood.user.toString() !== userId) {
        throw new ForbiddenError('Cannot delete other users shared moods');
      }

      // Soft delete
      sharedMood.isActive = false;
      sharedMood.deletedAt = new Date();
      await sharedMood.save();

      return {
        success: true,
        message: 'Shared mood deleted successfully',
        deletedAt: sharedMood.deletedAt,
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error deleting shared mood:', error);
      throw new ServerError('Failed to delete shared mood');
    }
  }

  /**
   * Get shared mood by ID
   * @param {string} sharedMoodId - Shared mood ID
   * @param {string} userId - User ID for access control
   * @returns {Promise<Object>} Shared mood details
   */
  async getSharedMoodById(sharedMoodId, userId) {
    try {
      if (!sharedMoodId || !userId) {
        throw new ValidationError('Shared mood ID and user ID are required');
      }

      const sharedMood = await SharedMood.findById(sharedMoodId)
        .populate([
          { path: 'user', select: '_id username profilePicture' },
          { path: 'mood', select: '_id moodType intensity note createdAt' },
          { path: 'taggedUsers', select: '_id username profilePicture' },
          { path: 'likes.user', select: '_id username profilePicture' },
          { path: 'comments.user', select: '_id username profilePicture' },
        ]);

      if (!sharedMood) {
        throw new NotFoundError('Shared mood not found');
      }

      // Check if user can view this shared mood
      const canView = await this._canUserViewSharedMood(userId, sharedMood);
      if (!canView) {
        throw new ForbiddenError('Cannot access this shared mood');
      }

      // Increment view count
      sharedMood.stats.views += 1;
      await sharedMood.save();

      return this._formatSharedMoodResponse(sharedMood);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching shared mood by ID:', error);
      throw new ServerError('Failed to fetch shared mood details');
    }
  }

  /**
   * Helper: Check if user can view shared mood
   * @private
   */
  async _canUserViewSharedMood(userId, sharedMood) {
    if (sharedMood.user.toString() === userId) {
      return true; // User owns the mood
    }

    switch (sharedMood.visibility) {
      case 'public':
        return true;
      
      case 'friends':
        return await this._areUsersFriends(sharedMood.user.toString(), userId);
      
      case 'specific':
        return sharedMood.taggedUsers.some(
          taggedUser => taggedUser.toString() === userId
        );
      
      case 'private':
        return false;
      
      default:
        return false;
    }
  }

  /**
   * Helper: Check if two users are friends
   * @private
   */
  async _areUsersFriends(userId1, userId2) {
    // Implement your friend checking logic here
    // This is a placeholder - replace with actual friend check
    const Friend = require('../models/Friend');
    const friendship = await Friend.findOne({
      $or: [
        { user: userId1, friend: userId2, status: 'accepted' },
        { user: userId2, friend: userId1, status: 'accepted' },
      ],
    });
    return !!friendship;
  }

  /**
   * Helper: Get user's friends
   * @private
   */
  async _getUserFriends(userId) {
    // Implement your friend fetching logic here
    // This is a placeholder
    const Friend = require('../models/Friend');
    const friendships = await Friend.find({
      $or: [
        { user: userId, status: 'accepted' },
        { friend: userId, status: 'accepted' },
      ],
    });

    return friendships.map(f => 
      f.user.toString() === userId ? f.friend : f.user
    );
  }

  /**
   * Helper: Get users that current user follows
   * @private
   */
  async _getFollowingUsers(userId) {
    // Implement your following logic here
    // This is a placeholder
    const Follow = require('../models/Follow');
    const follows = await Follow.find({
      follower: userId,
      isActive: true,
    });

    return follows.map(f => f.following);
  }

  /**
   * Helper: Calculate trending sort criteria
   * @private
   */
  _calculateTrendingSort() {
    // Custom sorting function for trending content
    // You might want to implement this based on your trending algorithm
    return { 'stats.likes': -1, 'stats.comments': -1, shareDate: -1 };
  }

  /**
   * Format shared mood response
   * @private
   */
  _formatSharedMoodResponse(sharedMood) {
    const response = {
      id: sharedMood._id,
      user: sharedMood.user,
      mood: sharedMood.mood,
      visibility: sharedMood.visibility,
      message: sharedMood.message,
      taggedUsers: sharedMood.taggedUsers,
      shareDate: sharedMood.shareDate,
      isActive: sharedMood.isActive,
      stats: sharedMood.stats,
      likes: sharedMood.likes || [],
      comments: sharedMood.comments || [],
      canEdit: sharedMood.user && sharedMood.user._id ? 
        sharedMood.user._id.toString() === sharedMood.userId : false,
      canDelete: sharedMood.user && sharedMood.user._id ? 
        sharedMood.user._id.toString() === sharedMood.userId : false,
    };

    return response;
  }
}

module.exports = new SharedMoodService();