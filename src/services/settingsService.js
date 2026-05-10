const Settings = require('../models/Settings');
const { ServerError, ValidationError, NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Settings Service
 * Handles user settings management — Sequelize edition.
 *
 * FIXED:
 *  ✅  All Mongoose (.lean(), findOne with callback pattern) replaced with Sequelize API
 *  ✅  findOne({ userId }) → findOne({ where: { userId } })
 *  ✅  findOneAndUpdate → findOne + instance.update()
 *  ✅  deleteOne → destroy()
 *  ✅  _formatSettingsResponse now returns AppSettings-schema shape so frontend merges cleanly
 *  ✅  _normaliseSectionedPayload kept for backward compat with AppSettings payload shape
 */
class SettingsService {
  /**
   * Get settings for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User settings
   */
  async getSettings(userId) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      let settings = await Settings.findOne({ where: { userId } });

      if (!settings) {
        settings = await this._createDefaultSettings(userId);
      }

      return this._formatSettingsResponse(settings.toJSON ? settings.toJSON() : settings);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
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
      if (!userId) throw new ValidationError('User ID is required');
      if (!settingsData || typeof settingsData !== 'object') throw new ValidationError('Settings data is required');

      // Normalise AppSettings-shaped payload → flat DB columns
      const flatData = this._normaliseSectionedPayload(settingsData);

      this._validateSettingsUpdate(flatData);

      let settings = await Settings.findOne({ where: { userId } });

      if (!settings) {
        // Create with merged defaults + provided data
        const defaults = Settings.getDefaultSettings ? Settings.getDefaultSettings() : {};
        settings = await Settings.create({ userId, ...defaults, ...flatData });
      } else {
        await settings.update(flatData);
        await settings.reload();
      }

      return this._formatSettingsResponse(settings.toJSON ? settings.toJSON() : settings);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) throw error;
      logger.error('Error updating settings:', error);
      throw new ServerError('Failed to update settings');
    }
  }

  /**
   * Create settings for a user
   */
  async createSettings(userId, settingsData = {}) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      const existing = await Settings.findOne({ where: { userId } });
      if (existing) throw new ValidationError('Settings already exist for this user');

      const defaults     = Settings.getDefaultSettings ? Settings.getDefaultSettings() : {};
      const flatCustom   = Object.keys(settingsData).length > 0
        ? this._normaliseSectionedPayload(settingsData)
        : settingsData;
      const mergedSettings = { userId, ...defaults, ...flatCustom };

      this._validateSettingsUpdate(mergedSettings);

      const settings = await Settings.create(mergedSettings);
      return this._formatSettingsResponse(settings.toJSON ? settings.toJSON() : settings);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      logger.error('Error creating settings:', error);
      throw new ServerError('Failed to create settings');
    }
  }

  /**
   * Internal helper — create with defaults, no duplicate check
   */
  async _createDefaultSettings(userId) {
    const defaults = Settings.getDefaultSettings ? Settings.getDefaultSettings() : {};
    return Settings.create({ userId, ...defaults });
  }

  /**
   * Delete settings for a user
   */
  async deleteSettings(userId) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      const count = await Settings.destroy({ where: { userId } });
      if (count === 0) throw new NotFoundError('Settings not found');
      return true;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) throw error;
      logger.error('Error deleting settings:', error);
      throw new ServerError('Failed to delete settings');
    }
  }

  /**
   * Get multiple users' settings
   */
  async getBulkSettings(userIds) {
    try {
      if (!Array.isArray(userIds) || userIds.length === 0) throw new ValidationError('User IDs array is required');

      const settings = await Settings.findAll({ where: { userId: userIds } });

      const foundIds = settings.map(s => String(s.userId));
      const missing  = userIds.filter(id => !foundIds.includes(String(id)));

      const newSettings = await Promise.all(missing.map(uid => this._createDefaultSettings(uid)));
      settings.push(...newSettings);

      return settings.map(s => this._formatSettingsResponse(s.toJSON ? s.toJSON() : s));
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      logger.error('Error getting bulk settings:', error);
      throw new ServerError('Failed to get bulk settings');
    }
  }

  /**
   * Reset settings to defaults for a user
   */
  async resetSettings(userId) {
    try {
      if (!userId) throw new ValidationError('User ID is required');

      const defaults = Settings.getDefaultSettings ? Settings.getDefaultSettings() : {};

      const [, [settings]] = await Settings.update(defaults, {
        where: { userId },
        returning: true   // Postgres only; ignored on MySQL/SQLite
      });

      if (!settings) {
        // upsert fallback for databases that don't return rows
        const row = await Settings.findOne({ where: { userId } });
        if (!row) {
          return this._formatSettingsResponse((await Settings.create({ userId, ...defaults })).toJSON());
        }
        return this._formatSettingsResponse(row.toJSON ? row.toJSON() : row);
      }

      return this._formatSettingsResponse(settings.toJSON ? settings.toJSON() : settings);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      logger.error('Error resetting settings:', error);
      throw new ServerError('Failed to reset settings');
    }
  }

  /**
   * Validate settings update — accepts flat fields and section-keyed objects.
   * @private
   */
  _validateSettingsUpdate(settingsData) {
    const validFlatFields = [
      'theme', 'accentColor', 'notificationsEnabled', 'language',
      'fontSize', 'timezone', 'emailNotifications', 'pushNotifications',
      'soundEnabled', 'vibrationEnabled', 'dataSaver', 'autoDownload',
      'privacy', 'chatPreferences', 'updatedAt', 'syncEnabled', 'section', 'userId'
    ];

    const validSectionFields = [
      'appearance', 'notifications', 'calls', 'groups',
      'friends', 'status', 'account', 'chat', 'advanced'
    ];

    const allValidFields = [...validFlatFields, ...validSectionFields];
    const invalidFields  = Object.keys(settingsData).filter(f => !allValidFields.includes(f));
    if (invalidFields.length > 0) {
      throw new ValidationError(`Invalid fields: ${invalidFields.join(', ')}`);
    }

    const theme = settingsData.theme || settingsData.appearance?.theme;
    if (theme && !['light', 'dark', 'system', 'auto'].includes(theme)) {
      throw new ValidationError('Invalid theme value');
    }

    const accentColor = settingsData.accentColor || settingsData.appearance?.accentColor;
    if (accentColor && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(accentColor)) {
      throw new ValidationError('Invalid accent color format');
    }

    const language     = settingsData.language || settingsData.appearance?.language;
    const validLangs   = ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ru', 'ar', 'pt', 'it', 'nl', 'pl', 'sv', 'tr'];
    if (language && !validLangs.includes(language)) {
      throw new ValidationError('Invalid language');
    }
  }

  /**
   * Normalise an AppSettings-shaped payload to flat DB schema columns.
   * @private
   */
  _normaliseSectionedPayload(settingsData) {
    const out = Object.assign({}, settingsData);

    if (settingsData.appearance && typeof settingsData.appearance === 'object') {
      const a = settingsData.appearance;
      if (a.theme       !== undefined) out.theme       = a.theme;
      if (a.accentColor !== undefined) out.accentColor = a.accentColor;
      if (a.fontSize    !== undefined) out.fontSize    = String(a.fontSize);
      if (a.language    !== undefined) out.language    = a.language;
      if (a.timezone    !== undefined) out.timezone    = a.timezone;
      delete out.appearance;
    }

    if (settingsData.notifications && typeof settingsData.notifications === 'object') {
      const n = settingsData.notifications;
      if (n.messageNotifications  !== undefined) out.notificationsEnabled = n.messageNotifications;
      if (n.notificationSound     !== undefined) out.soundEnabled         = n.notificationSound;
      if (n.notificationVibration !== undefined) out.vibrationEnabled     = n.notificationVibration;
      if (n.emailNotifications    !== undefined) out.emailNotifications   = n.emailNotifications;
      if (n.pushNotifications     !== undefined) out.pushNotifications    = n.pushNotifications;
      delete out.notifications;
    }

    if (settingsData.chat && typeof settingsData.chat === 'object') {
      const c = settingsData.chat;
      const existing = out.chatPreferences || {};
      out.chatPreferences = Object.assign({}, existing, {
        ...(c.enterKeySends     !== undefined && { enterToSend:   c.enterKeySends }),
        ...(c.videoQuality      !== undefined && { mediaQuality:  c.videoQuality }),
        ...(c.saveMedia         !== undefined && { saveToGallery: c.saveMedia }),
      });
      if (c.autoDownloadMedia !== undefined) out.autoDownload = c.autoDownloadMedia;
      delete out.chat;
    }

    if (settingsData.advanced && typeof settingsData.advanced === 'object') {
      if (settingsData.advanced.dataSaver   !== undefined) out.dataSaver   = settingsData.advanced.dataSaver;
      if (settingsData.advanced.syncEnabled !== undefined) out.syncEnabled = settingsData.advanced.syncEnabled;
      delete out.advanced;
    }

    // Remove section-only keys that have no DB columns
    ['friends', 'groups', 'status', 'account', 'calls'].forEach(k => delete out[k]);

    return out;
  }

  /**
   * Format settings response in AppSettings-schema shape so the frontend
   * can merge it directly into SettingsState / AppSettings without remapping.
   * @private
   */
  _formatSettingsResponse(settings) {
    const priv = settings.privacy         || {};
    const chat = settings.chatPreferences || {};

    return {
      // ── appearance ──────────────────────────────────────────────────────
      appearance: {
        theme:       settings.theme       || 'light',
        language:    settings.language    || 'en',
        accentColor: settings.accentColor || '#4F46E5',
        fontSize:    settings.fontSize    || 'medium',
        timezone:    settings.timezone    || 'UTC',
        reduceMotion:false
      },
      // ── notifications ────────────────────────────────────────────────────
      notifications: {
        messageNotifications:   settings.notificationsEnabled !== false,
        emailNotifications:     settings.emailNotifications   !== false,
        pushNotifications:      settings.pushNotifications    !== false,
        notificationSound:      settings.soundEnabled         !== false,
        notificationVibration:  settings.vibrationEnabled     !== false,
        groupNotifications:     true,
        callNotifications:      true,
        statusNotifications:    true,
        popupNotifications:     false,
        doNotDisturb:           false
      },
      // ── privacy ──────────────────────────────────────────────────────────
      privacy: {
        profileVisibility: priv.profileVisibility  || 'public',
        readReceipts:      priv.readReceipts        !== false,
        typingIndicators:  priv.typingIndicators    !== false,
        onlineStatus:      priv.onlineStatus        !== false,
        lastSeen:          priv.lastSeen            !== false,
        whoCanAddMe:       priv.whoCanAddMe         || 'everyone',
        statusVisibility:  priv.statusVisibility    || 'everyone'
      },
      // ── chat ─────────────────────────────────────────────────────────────
      chat: {
        enterKeySends:     chat.enterToSend  !== false,
        autoDownloadMedia: settings.autoDownload !== false,
        saveMedia:         chat.saveToGallery || false,
        mediaQuality:      chat.mediaQuality  || 'auto',
        fontSize:          settings.fontSize  || 'medium'
      },
      // ── advanced ─────────────────────────────────────────────────────────
      advanced: {
        dataSaver:   settings.dataSaver  || false,
        syncEnabled: settings.syncEnabled || false
      },
      // ── meta ─────────────────────────────────────────────────────────────
      _id:       settings.id,
      userId:    settings.userId,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt
    };
  }
}

module.exports = new SettingsService();