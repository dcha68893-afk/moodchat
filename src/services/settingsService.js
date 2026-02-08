const Settings = require('../models/Settings');
const { ServerError, ValidationError, NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Settings Service
 * Handles user settings management
 */
class SettingsService {
  /**
   * Get settings for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User settings
   */
  async getSettings(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      let settings = await Settings.findOne({ userId }).lean();

      if (!settings) {
        // Create default settings if none exist
        settings = await this.createSettings(userId, {});
      }

      return this._formatSettingsResponse(settings);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting settings:', error);
      throw new ServerError('Failed to get settings');
    }
  }

  /**
   * Update settings for a user
   * @param {string} userId - User ID
   * @param {Object} settingsData - Settings data to update
   * @returns {Promise<Object>} Updated settings
   */
  async updateSettings(userId, settingsData) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      if (!settingsData || typeof settingsData !== 'object') {
        throw new ValidationError('Settings data is required');
      }

      let settings = await Settings.findOne({ userId });

      if (!settings) {
        // Create settings if they don't exist
        settings = await this.createSettings(userId, settingsData);
      } else {
        // Validate updates before applying
        this._validateSettingsUpdate(settingsData);
        
        // Update settings
        settings = await Settings.findOneAndUpdate(
          { userId },
          { $set: settingsData },
          { new: true, runValidators: true }
        ).lean();
      }

      if (!settings) {
        throw new NotFoundError('Settings not found');
      }

      return this._formatSettingsResponse(settings);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error updating settings:', error);
      throw new ServerError('Failed to update settings');
    }
  }

  /**
   * Create settings for a user
   * @param {string} userId - User ID
   * @param {Object} settingsData - Optional custom settings data
   * @returns {Promise<Object>} Created settings
   */
  async createSettings(userId, settingsData = {}) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Check if settings already exist
      const existingSettings = await Settings.findOne({ userId });
      if (existingSettings) {
        throw new ValidationError('Settings already exist for this user');
      }

      // Get default settings and merge with custom data
      const defaultSettings = Settings.getDefaultSettings();
      const mergedSettings = {
        userId,
        ...defaultSettings,
        ...settingsData
      };

      // Validate the merged settings
      this._validateSettingsUpdate(mergedSettings);

      // Create new settings
      const settings = new Settings(mergedSettings);
      await settings.save();

      return this._formatSettingsResponse(settings.toObject());
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error creating settings:', error);
      throw new ServerError('Failed to create settings');
    }
  }

  /**
   * Delete settings for a user
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteSettings(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const result = await Settings.deleteOne({ userId });

      if (result.deletedCount === 0) {
        throw new NotFoundError('Settings not found');
      }

      return true;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error deleting settings:', error);
      throw new ServerError('Failed to delete settings');
    }
  }

  /**
   * Get multiple users' settings
   * @param {Array<string>} userIds - Array of user IDs
   * @returns {Promise<Array<Object>>} Array of settings
   */
  async getBulkSettings(userIds) {
    try {
      if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new ValidationError('User IDs array is required');
      }

      const settings = await Settings.find({ userId: { $in: userIds } }).lean();

      // Create default settings for users who don't have any
      const usersWithoutSettings = userIds.filter(
        id => !settings.some(s => s.userId.toString() === id)
      );

      if (usersWithoutSettings.length > 0) {
        const defaultSettingsPromises = usersWithoutSettings.map(userId =>
          this.createSettings(userId, {})
        );
        const newSettings = await Promise.all(defaultSettingsPromises);
        settings.push(...newSettings);
      }

      return settings.map(s => this._formatSettingsResponse(s));
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting bulk settings:', error);
      throw new ServerError('Failed to get bulk settings');
    }
  }

  /**
   * Reset settings to defaults for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Reset settings
   */
  async resetSettings(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      const defaultSettings = Settings.getDefaultSettings();
      
      const settings = await Settings.findOneAndUpdate(
        { userId },
        { $set: defaultSettings },
        { new: true, upsert: true, runValidators: true }
      ).lean();

      return this._formatSettingsResponse(settings);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error resetting settings:', error);
      throw new ServerError('Failed to reset settings');
    }
  }

  /**
   * Validate settings update
   * @private
   * @param {Object} settingsData - Settings data to validate
   */
  _validateSettingsUpdate(settingsData) {
    const validFields = [
      'theme', 'accentColor', 'notificationsEnabled', 'language',
      'fontSize', 'timezone', 'emailNotifications', 'pushNotifications',
      'soundEnabled', 'vibrationEnabled', 'dataSaver', 'autoDownload',
      'privacy', 'chatPreferences'
    ];

    // Check for invalid fields
    const invalidFields = Object.keys(settingsData).filter(
      field => !validFields.includes(field)
    );

    if (invalidFields.length > 0) {
      throw new ValidationError(`Invalid fields: ${invalidFields.join(', ')}`);
    }

    // Validate specific fields if present
    if (settingsData.theme && !['light', 'dark', 'system'].includes(settingsData.theme)) {
      throw new ValidationError('Invalid theme value');
    }

    if (settingsData.accentColor && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(settingsData.accentColor)) {
      throw new ValidationError('Invalid accent color format');
    }

    if (settingsData.language && !['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ru', 'ar'].includes(settingsData.language)) {
      throw new ValidationError('Invalid language');
    }
  }

  /**
   * Format settings response
   * @private
   * @param {Object} settings - Settings document
   * @returns {Object} Formatted settings response
   */
  _formatSettingsResponse(settings) {
    return {
      id: settings._id,
      userId: settings.userId,
      theme: settings.theme,
      accentColor: settings.accentColor,
      notificationsEnabled: settings.notificationsEnabled,
      language: settings.language,
      fontSize: settings.fontSize,
      timezone: settings.timezone,
      emailNotifications: settings.emailNotifications,
      pushNotifications: settings.pushNotifications,
      soundEnabled: settings.soundEnabled,
      vibrationEnabled: settings.vibrationEnabled,
      dataSaver: settings.dataSaver,
      autoDownload: settings.autoDownload,
      privacy: settings.privacy,
      chatPreferences: settings.chatPreferences,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt
    };
  }
}

module.exports = new SettingsService();