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
        // Normalise AppSettings-shaped payload → flat DB schema
        const flatData = this._normaliseSectionedPayload(settingsData);

        // Validate updates before applying
        this._validateSettingsUpdate(flatData);
        
        // Update settings
        settings = await Settings.findOneAndUpdate(
          { userId },
          { $set: flatData },
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
      // Normalise any AppSettings-shaped keys before merging with defaults
      const flatCustom = Object.keys(settingsData).length > 0
        ? this._normaliseSectionedPayload(settingsData)
        : settingsData;
      const mergedSettings = {
        userId,
        ...defaultSettings,
        ...flatCustom
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
   * Accepts both flat fields (legacy) and section-keyed objects (AppSettings shape).
   * @private
   * @param {Object} settingsData - Settings data to validate
   */
  _validateSettingsUpdate(settingsData) {
    // ── Flat top-level fields (legacy schema, kept for backwards compat) ──────
    const validFlatFields = [
      'theme', 'accentColor', 'notificationsEnabled', 'language',
      'fontSize', 'timezone', 'emailNotifications', 'pushNotifications',
      'soundEnabled', 'vibrationEnabled', 'dataSaver', 'autoDownload',
      'privacy', 'chatPreferences',
      // userId is set server-side; updatedAt is managed here
      'updatedAt', 'syncEnabled', 'section'
    ];

    // ── Section-keyed fields (AppSettings / MoodChat schema) ─────────────────
    const validSectionFields = [
      'appearance', 'notifications', 'calls', 'groups',
      'friends', 'status', 'account', 'chat', 'advanced'
    ];

    const allValidFields = [...validFlatFields, ...validSectionFields];

    const invalidFields = Object.keys(settingsData).filter(
      field => !allValidFields.includes(field)
    );

    if (invalidFields.length > 0) {
      throw new ValidationError(`Invalid fields: ${invalidFields.join(', ')}`);
    }

    // ── Field-level validation ────────────────────────────────────────────────
    const theme = settingsData.theme || settingsData.appearance?.theme;
    if (theme && !['light', 'dark', 'system', 'auto'].includes(theme)) {
      throw new ValidationError('Invalid theme value');
    }

    const accentColor = settingsData.accentColor || settingsData.appearance?.accentColor;
    if (accentColor && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(accentColor)) {
      throw new ValidationError('Invalid accent color format');
    }

    const language = settingsData.language || settingsData.appearance?.language;
    const validLanguages = ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ru', 'ar',
                            'pt', 'it', 'nl', 'pl', 'sv', 'tr'];
    if (language && !validLanguages.includes(language)) {
      throw new ValidationError('Invalid language');
    }

    // Validate boolean fields
    const boolFields = ['notificationsEnabled', 'emailNotifications', 'pushNotifications',
                        'soundEnabled', 'vibrationEnabled', 'dataSaver', 'autoDownload', 'syncEnabled'];
    boolFields.forEach(field => {
      if (field in settingsData && typeof settingsData[field] !== 'boolean') {
        throw new ValidationError(`Field "${field}" must be a boolean`);
      }
    });

    // privacy must be an object if present
    if (settingsData.privacy !== undefined &&
        (typeof settingsData.privacy !== 'object' || Array.isArray(settingsData.privacy))) {
      throw new ValidationError('Field "privacy" must be an object');
    }

    // chatPreferences must be an object if present
    if (settingsData.chatPreferences !== undefined &&
        (typeof settingsData.chatPreferences !== 'object' || Array.isArray(settingsData.chatPreferences))) {
      throw new ValidationError('Field "chatPreferences" must be an object');
    }
  }

  /**
   * Normalise an AppSettings-shaped payload to the flat DB schema.
   * Called by updateSettings before writing to the DB so the richer
   * frontend shape maps cleanly to the existing Sequelize model columns.
   * @private
   * @param {Object} settingsData
   * @returns {Object} flat settings object safe to pass to $set / findOneAndUpdate
   */
  _normaliseSectionedPayload(settingsData) {
    const out = Object.assign({}, settingsData);

    // Flatten appearance → top-level columns
    if (settingsData.appearance && typeof settingsData.appearance === 'object') {
      const a = settingsData.appearance;
      if (a.theme        !== undefined) out.theme        = a.theme;
      if (a.accentColor  !== undefined) out.accentColor  = a.accentColor;
      if (a.fontSize     !== undefined) out.fontSize      = String(a.fontSize);
      if (a.language     !== undefined) out.language      = a.language;
      if (a.timezone     !== undefined) out.timezone      = a.timezone;
      delete out.appearance;
    }

    // Flatten notifications booleans
    if (settingsData.notifications && typeof settingsData.notifications === 'object') {
      const n = settingsData.notifications;
      if (n.messageNotifications   !== undefined) out.notificationsEnabled = n.messageNotifications;
      if (n.notificationSound      !== undefined) out.soundEnabled         = n.notificationSound;
      if (n.notificationVibration  !== undefined) out.vibrationEnabled     = n.notificationVibration;
      if (n.emailNotifications     !== undefined) out.emailNotifications   = n.emailNotifications;
      if (n.pushNotifications      !== undefined) out.pushNotifications    = n.pushNotifications;
      delete out.notifications;
    }

    // Flatten chat
    if (settingsData.chat && typeof settingsData.chat === 'object') {
      const c = settingsData.chat;
      out.chatPreferences = Object.assign(out.chatPreferences || {}, {
        enterToSend:  c.enterKeySends      !== undefined ? c.enterKeySends      : undefined,
        mediaQuality: c.videoQuality        !== undefined ? c.videoQuality       : undefined,
        saveToGallery:c.saveMedia           !== undefined ? c.saveMedia          : undefined,
      });
      if (c.autoDownloadMedia !== undefined) out.autoDownload = c.autoDownloadMedia;
      delete out.chat;
    }

    // Flatten advanced
    if (settingsData.advanced && typeof settingsData.advanced === 'object') {
      if (settingsData.advanced.dataSaver   !== undefined) out.dataSaver   = settingsData.advanced.dataSaver;
      if (settingsData.advanced.syncEnabled !== undefined) out.syncEnabled = settingsData.advanced.syncEnabled;
      delete out.advanced;
    }

    // Remove section keys that don't map to DB columns (friends, groups, status, account, calls)
    ['friends', 'groups', 'status', 'account', 'calls'].forEach(k => delete out[k]);

    return out;
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