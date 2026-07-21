const { Op } = require('sequelize');
const db = require('../models');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

// Lazy-resolve the model so we get the Sequelize instance, not the factory function
const getUser = () => db.User || db.models.Users || db.models.User;
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cloudinaryService = require('../services/cloudinaryService');

// FIX (PROFILE-COVER-EPHEMERAL-DISK + WRONG-COLUMN): this whole file used to
// write avatar/cover uploads to local disk via uploadProfileImage() below,
// AND stored the result on `user.profilePicture` / `user.coverPhoto` — but
// Users never had a `profilePicture` column (the real column is `avatar`),
// and `coverPhoto` didn't exist as a column at all until the ensureSchema.js
// fix. Both bugs together meant profile/cover photo uploads through this
// service silently did nothing durable: the disk copy vanished on Render's
// next restart, and even if it hadn't, the DB write was targeting a column
// that either wasn't the real one or didn't exist. Now uploads go straight
// to Cloudinary (same account already used for group/user avatars via
// settings.js) and are written to the real `avatar` / `coverPhoto` columns.

class ProfileService {
  async getProfile(userId, viewerId = null) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const user = await getUser().findByPk(userId, {
        attributes: { exclude: ['password'] }
      });

      if (!user) {
        throw new NotFoundError('User not found');
      }

      const completion = this.calculateProfileCompletion(user);
      const profileJson = { ...user.toJSON(), profileCompletion: completion };

      // FIX (PROFILE-VISIBILITY-NOT-ENFORCED): profileVisibility
      // (everyone / friendsOnly / nobody, saved via /api/settings/profile)
      // was persisted correctly but never actually checked here — every
      // viewer got the full profile, including avatar and coverPhoto,
      // regardless of what the owner chose. This enforces it.
      const isSelf = viewerId != null && String(viewerId) === String(userId);
      if (isSelf) {
        return profileJson;
      }

      const visibility = await this._getProfileVisibility(userId);

      if (visibility === 'everyone') {
        return profileJson;
      }

      let allowed = false;
      if (visibility === 'friendsOnly' && viewerId) {
        allowed = await this._areFriends(userId, viewerId);
      }

      if (allowed) {
        return profileJson;
      }

      // Restricted: strip photos and personal details, keep only safe
      // public fields (id/username/displayName/online status).
      return {
        id: profileJson.id,
        username: profileJson.username,
        firstName: null,
        lastName: null,
        displayName: profileJson.username,
        avatar: null,
        coverPhoto: null,
        bio: null,
        status: profileJson.status,
        restricted: true,
        restrictedReason: visibility === 'nobody' ? 'nobody' : 'friendsOnly',
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error fetching profile:', error);
      throw new ServerError('Failed to fetch profile');
    }
  }

  // Reads the profile visibility choice the owner saved in Settings.privacy
  // (the same JSONB field /api/settings/profile reads and writes).
  async _getProfileVisibility(ownerId) {
    try {
      const Settings = db.Settings || (db.models && db.models.Settings);
      if (!Settings) return 'everyone';
      const row = await Settings.findOne({ where: { userId: ownerId } });
      const priv = (row && row.privacy) || {};
      const raw = priv.profileVisibility || priv.photoVisibility || 'everyone';
      const normalized = String(raw).toLowerCase();
      if (normalized === 'nobody' || normalized === 'none') return 'nobody';
      if (normalized === 'friendsonly' || normalized === 'friends' || normalized === 'contacts') return 'friendsOnly';
      return 'everyone';
    } catch (_) {
      return 'everyone';
    }
  }

  async _areFriends(ownerId, viewerId) {
    try {
      const Friend = db.Friend || (db.models && db.models.Friend);
      if (!Friend || !Friend.getFriendship) return false;
      const friendship = await Friend.getFriendship(ownerId, viewerId);
      return !!(friendship && friendship.status === 'accepted');
    } catch (_) {
      return false;
    }
  }

  async updateProfile(userId, updates) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const allowedUpdates = [
        'username', 'email', 'bio', 'location', 'website',
        'dateOfBirth', 'gender', 'language', 'timezone'
      ];
      
      const updateFields = {};
      
      for (const [key, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(key)) {
          if (key === 'username') {
            if (value.length < 3 || value.length > 30) {
              throw new ValidationError('Username must be between 3 and 30 characters');
            }
            if (!/^[a-zA-Z0-9_]+$/.test(value)) {
              throw new ValidationError('Username can only contain letters, numbers, and underscores');
            }
            
            const existingUser = await getUser().findOne({
              where: { 
                username: value,
                id: { [Op.ne]: userId }
              }
            });
            if (existingUser) {
              throw new ValidationError('Username is already taken');
            }
          }

          if (key === 'email') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(value)) {
              throw new ValidationError('Invalid email format');
            }
            
            const existingUser = await getUser().findOne({
              where: { 
                email: value,
                id: { [Op.ne]: userId }
              }
            });
            if (existingUser) {
              throw new ValidationError('Email is already registered');
            }
          }

          if (key === 'bio' && value.length > 500) {
            throw new ValidationError('Bio cannot exceed 500 characters');
          }

          updateFields[key] = value;
        }
      }

      await user.update(updateFields);

      const updatedUser = await getUser().findByPk(userId, {
        attributes: { exclude: ['password'] }
      });

      const completion = this.calculateProfileCompletion(updatedUser);

      return {
        ...updatedUser.toJSON(),
        profileCompletion: completion
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error updating profile:', error);
      throw new ServerError('Failed to update profile');
    }
  }

  async updateProfilePicture(userId, file) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      if (!file) {
        throw new ValidationError('Profile picture file is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const buffer = file.buffer || (file.path ? fs.readFileSync(file.path) : null);
      if (!buffer) {
        throw new ValidationError('Uploaded file could not be read');
      }

      const uploadResult = await cloudinaryService.uploadUserAvatar(buffer, userId);
      if (!uploadResult || !uploadResult.url) {
        throw new ServerError('Failed to upload profile picture');
      }

      user.avatar = uploadResult.url;
      await user.save();

      return {
        avatar: user.avatar,
        profilePicture: user.avatar, // legacy alias some callers expect
        message: 'Profile picture updated successfully'
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error updating profile picture:', error);
      throw new ServerError('Failed to update profile picture');
    }
  }

  async uploadCoverPhoto(userId, file) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      if (!file) {
        throw new ValidationError('Cover photo file is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const buffer = file.buffer || (file.path ? fs.readFileSync(file.path) : null);
      if (!buffer) {
        throw new ValidationError('Uploaded file could not be read');
      }

      const uploadResult = await cloudinaryService.uploadToCloudinary(buffer, {
        folder: 'moodchat/user-covers',
        publicId: `user_${userId}_cover`,
        width: 1600,
        height: 600,
        crop: 'fill',
      });
      if (!uploadResult || !uploadResult.url) {
        throw new ServerError('Failed to upload cover photo');
      }

      user.coverPhoto = uploadResult.url;
      await user.save();

      return {
        coverPhoto: user.coverPhoto,
        message: 'Cover photo updated successfully'
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error updating cover photo:', error);
      throw new ServerError('Failed to update cover photo');
    }
  }

  async deleteProfilePicture(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await cloudinaryService.deleteFromCloudinary(`moodchat/user-avatars/user_${userId}_avatar`);

      user.avatar = 'https://ui-avatars.com/api/?name=User&background=random&color=fff';
      await user.save();

      return {
        avatar: user.avatar,
        profilePicture: null,
        message: 'Profile picture deleted successfully'
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error deleting profile picture:', error);
      throw new ServerError('Failed to delete profile picture');
    }
  }

  async deleteCoverPhoto(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await cloudinaryService.deleteFromCloudinary(`moodchat/user-covers/user_${userId}_cover`);

      user.coverPhoto = null;
      await user.save();

      return {
        coverPhoto: null,
        message: 'Cover photo deleted successfully'
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error deleting cover photo:', error);
      throw new ServerError('Failed to delete cover photo');
    }
  }

  async changePassword(userId, passwordData) {
    try {
      const { currentPassword, newPassword, confirmPassword } = passwordData;

      if (!currentPassword || !newPassword || !confirmPassword) {
        throw new ValidationError('All password fields are required');
      }

      if (newPassword !== confirmPassword) {
        throw new ValidationError('New passwords do not match');
      }

      if (newPassword.length < 8) {
        throw new ValidationError('Password must be at least 8 characters long');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isPasswordValid) {
        throw new ValidationError('Current password is incorrect');
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      user.password = hashedPassword;
      await user.save();

      return {
        message: 'Password changed successfully'
      };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error changing password:', error);
      throw new ServerError('Failed to change password');
    }
  }

  async updatePrivacySettings(userId, privacySettings) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const allowedSettings = [
        'profileVisibility',
        'onlineStatusVisibility',
        'readReceipts',
        'lastSeenVisibility',
        'messageRequests',
        'taggingEnabled'
      ];

      const updateFields = {};
      
      for (const [key, value] of Object.entries(privacySettings)) {
        if (allowedSettings.includes(key)) {
          updateFields[key] = value;
        }
      }

      if (Object.keys(updateFields).length > 0) {
        await user.update({ privacySettings: updateFields });
      }

      return user.privacySettings || {};
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error updating privacy settings:', error);
      throw new ServerError('Failed to update privacy settings');
    }
  }

  async getActivitySummary(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const user = await getUser().findByPk(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      const activitySummary = {
        messagesSent: 0,
        groupsJoined: 0,
        friendsAdded: 0,
        activeDays: 0,
        lastActive: user.lastSeen
      };

      return activitySummary;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      console.error('Error fetching activity summary:', error);
      throw new ServerError('Failed to fetch activity summary');
    }
  }

  calculateProfileCompletion(user) {
    const requiredFields = [
      'username',
      'email',
      'profilePicture',
      'bio'
    ];

    const optionalFields = [
      'location',
      'website',
      'dateOfBirth'
    ];

    let completed = 0;
    let total = requiredFields.length + optionalFields.length;

    requiredFields.forEach(field => {
      if (user[field]) {
        completed += 1;
      }
    });

    optionalFields.forEach(field => {
      if (user[field]) {
        completed += 0.5;
      }
    });

    return Math.min(Math.round((completed / total) * 100), 100);
  }
}

module.exports = new ProfileService();