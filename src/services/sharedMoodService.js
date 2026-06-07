// sharedMoodService.js — REWRITTEN: Mongoose → Sequelize
// Original used mongoose sessions, .findOne(), .find(), $or/$in/$gte, mongoose.Types.ObjectId.
// SharedMood model columns: id, senderId, receiverId, moodId, message, isViewed, createdAt
// Friend model columns: id, requesterId, receiverId (addresseeId), status

const { Op } = require('sequelize');
const db = require('../models');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

const getSharedMood = () => db.SharedMood;
const getUser       = () => db.User || db.models?.Users;
const getMood       = () => db.Mood;
const getFriend     = () => db.Friend;

class SharedMoodService {
  /**
   * Share a mood with a specific receiver.
   */
  async shareMood(shareData) {
    try {
      const { userId, moodId, receiverId, message = '' } = shareData;

      if (!userId || !moodId || !receiverId) {
        throw new ValidationError('userId, moodId, and receiverId are required');
      }

      const User  = getUser();
      const Mood  = getMood();
      const SharedMood = getSharedMood();

      const [user, mood, receiver] = await Promise.all([
        User.findByPk(userId),
        Mood.findByPk(moodId),
        User.findByPk(receiverId)
      ]);

      if (!user)     throw new NotFoundError('User not found');
      if (!mood)     throw new NotFoundError('Mood not found');
      if (!receiver) throw new NotFoundError('Receiver not found');

      if (mood.userId !== userId) {
        throw new ForbiddenError('Mood does not belong to user');
      }

      // Prevent duplicate active shares
      const existing = await SharedMood.findOne({
        where: { senderId: userId, receiverId, moodId, isViewed: false }
      });
      if (existing) throw new ValidationError('Mood is already shared with this user');

      const created = await SharedMood.create({
        senderId: userId,
        receiverId,
        moodId,
        message
      });

      return created.toJSON();
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error sharing mood:', error);
      throw new ServerError('Failed to share mood');
    }
  }

  /**
   * Get moods shared with the user (received).
   */
  async getReceivedSharedMoods(userId, page = 1, limit = 20) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      page  = parseInt(page);
      limit = parseInt(limit);
      if (page < 1 || limit < 1 || limit > 50) throw new ValidationError('Invalid pagination');

      const SharedMood = getSharedMood();
      const { rows, count } = await SharedMood.findAndCountAll({
        where: { receiverId: userId },
        order: [['createdAt', 'DESC']],
        limit,
        offset: (page - 1) * limit
      });

      return {
        sharedMoods: rows.map(r => r.toJSON()),
        pagination: {
          currentPage:  page,
          totalPages:   Math.ceil(count / limit),
          totalItems:   count,
          hasNext:      page < Math.ceil(count / limit),
          hasPrevious:  page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      console.error('Error fetching received moods:', error);
      throw new ServerError('Failed to fetch received moods');
    }
  }

  /**
   * Get moods the user has sent.
   */
  async getSentSharedMoods(userId, page = 1, limit = 20) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      page  = parseInt(page);
      limit = parseInt(limit);
      if (page < 1 || limit < 1 || limit > 50) throw new ValidationError('Invalid pagination');

      const SharedMood = getSharedMood();
      const { rows, count } = await SharedMood.findAndCountAll({
        where: { senderId: userId },
        order: [['createdAt', 'DESC']],
        limit,
        offset: (page - 1) * limit
      });

      return {
        sharedMoods: rows.map(r => r.toJSON()),
        pagination: {
          currentPage:  page,
          totalPages:   Math.ceil(count / limit),
          totalItems:   count,
          hasNext:      page < Math.ceil(count / limit),
          hasPrevious:  page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      console.error('Error fetching sent moods:', error);
      throw new ServerError('Failed to fetch sent moods');
    }
  }

  /**
   * Get shared moods feed (from friends who shared publicly via 'friends' or 'public' visibility).
   * SharedMood model has senderId/receiverId — feed = moods received by userId.
   */
  async getSharedMoodsFeed(userId, filter = 'received', page = 1, limit = 20) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      page  = parseInt(page);
      limit = parseInt(limit);
      if (page < 1 || limit < 1 || limit > 50) throw new ValidationError('Invalid pagination');

      const SharedMood = getSharedMood();
      let where = {};

      if (filter === 'sent') {
        where = { senderId: userId };
      } else {
        // Default: received
        where = { receiverId: userId };
      }

      const { rows, count } = await SharedMood.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit,
        offset: (page - 1) * limit
      });

      return {
        sharedMoods: rows.map(r => r.toJSON()),
        pagination: {
          currentPage:  page,
          totalPages:   Math.ceil(count / limit),
          totalItems:   count,
          hasNext:      page < Math.ceil(count / limit),
          hasPrevious:  page > 1
        }
      };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      console.error('Error fetching shared moods feed:', error);
      throw new ServerError('Failed to fetch shared moods feed');
    }
  }

  /**
   * Mark a shared mood as viewed.
   */
  async markAsViewed(sharedMoodId, userId) {
    try {
      if (!sharedMoodId || !userId) throw new ValidationError('Shared mood ID and user ID are required');

      const SharedMood = getSharedMood();
      const sharedMood = await SharedMood.findByPk(sharedMoodId);
      if (!sharedMood) throw new NotFoundError('Shared mood not found');

      if (sharedMood.receiverId !== userId) throw new ForbiddenError('Cannot mark other users\' moods as viewed');

      sharedMood.isViewed = true;
      await sharedMood.save();

      return sharedMood.toJSON();
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error marking shared mood as viewed:', error);
      throw new ServerError('Failed to mark shared mood as viewed');
    }
  }

  /**
   * Delete a shared mood (sender can delete).
   */
  async deleteSharedMood(sharedMoodId, userId) {
    try {
      if (!sharedMoodId || !userId) throw new ValidationError('Shared mood ID and user ID are required');

      const SharedMood = getSharedMood();
      const sharedMood = await SharedMood.findByPk(sharedMoodId);
      if (!sharedMood) throw new NotFoundError('Shared mood not found');

      if (sharedMood.senderId !== userId) throw new ForbiddenError('Cannot delete other users\' shared moods');

      await sharedMood.destroy();

      return { success: true, message: 'Shared mood deleted successfully' };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error deleting shared mood:', error);
      throw new ServerError('Failed to delete shared mood');
    }
  }

  /**
   * Get unviewed count for a user.
   */
  async getUnviewedCount(userId) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      const SharedMood = getSharedMood();
      const count = await SharedMood.count({
        where: { receiverId: userId, isViewed: false }
      });

      return { count };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      console.error('Error fetching unviewed count:', error);
      throw new ServerError('Failed to fetch unviewed count');
    }
  }

  /**
   * Get a shared mood by ID.
   */
  async getSharedMoodById(sharedMoodId, userId) {
    try {
      if (!sharedMoodId || !userId) throw new ValidationError('Shared mood ID and user ID are required');

      const SharedMood = getSharedMood();
      const sharedMood = await SharedMood.findByPk(sharedMoodId);
      if (!sharedMood) throw new NotFoundError('Shared mood not found');

      if (sharedMood.senderId !== userId && sharedMood.receiverId !== userId) {
        throw new ForbiddenError('Cannot access this shared mood');
      }

      return sharedMood.toJSON();
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) throw error;
      console.error('Error fetching shared mood:', error);
      throw new ServerError('Failed to fetch shared mood');
    }
  }

  /**
   * Helper: check if two users are friends via Friend model (requesterId/receiverId columns).
   * @private
   */
  async _areUsersFriends(userId1, userId2) {
    try {
      const Friend = getFriend();
      if (!Friend) return false;
      const friendship = await Friend.findOne({
        where: {
          [Op.or]: [
            { requesterId: userId1, receiverId: userId2, status: 'accepted' },
            { requesterId: userId2, receiverId: userId1, status: 'accepted' }
          ]
        }
      });
      return !!friendship;
    } catch (_) {
      return false;
    }
  }
}

module.exports = new SharedMoodService();
