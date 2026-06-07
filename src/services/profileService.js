const { Op } = require('sequelize');
const db = require('../models');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

// Lazy-resolve the model so we get the Sequelize instance, not the factory function
const getUser = () => db.User || db.models.Users || db.models.User;
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const uploadProfileImage = async (file) => {
  return `/uploads/profiles/${file.filename}`;
};

class ProfileService {
  async getProfile(userId) {
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

      return {
        ...user.toJSON(),
        profileCompletion: completion
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

      if (user.profilePicture && !user.profilePicture.includes('/default-avatar.png')) {
        try {
          const oldFilePath = path.join(__dirname, '../../', user.profilePicture);
          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
          }
        } catch (deleteError) {
          console.error('Error deleting old profile picture:', deleteError);
        }
      }

      const filePath = await uploadProfileImage(file);
      
      user.profilePicture = filePath;
      await user.save();

      return {
        profilePicture: user.profilePicture,
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

      if (user.coverPhoto) {
        try {
          const oldFilePath = path.join(__dirname, '../../', user.coverPhoto);
          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
          }
        } catch (deleteError) {
          console.error('Error deleting old cover photo:', deleteError);
        }
      }

      const filePath = await uploadProfileImage(file);
      
      user.coverPhoto = filePath;
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

      if (user.profilePicture && !user.profilePicture.includes('/default-avatar.png')) {
        try {
          const filePath = path.join(__dirname, '../../', user.profilePicture);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (deleteError) {
          console.error('Error deleting profile picture:', deleteError);
        }
      }

      user.profilePicture = null;
      await user.save();

      return {
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

      if (user.coverPhoto) {
        try {
          const filePath = path.join(__dirname, '../../', user.coverPhoto);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (deleteError) {
          console.error('Error deleting cover photo:', deleteError);
        }
      }

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