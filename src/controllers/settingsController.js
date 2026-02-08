const settingsService = require('../services/settingsService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class SettingsController {
  /**
   * Get user settings
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getSettings(req, res, next) {
    try {
      const userId = req.user.id;
      
      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const settings = await settingsService.getSettings(userId);

      res.status(200).json({
        success: true,
        message: 'Settings retrieved successfully',
        data: {
          settings
        }
      });
    } catch (error) {
      logger.error('Get settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve settings', 500));
      }
    }
  }

  /**
   * Update user settings
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateSettings(req, res, next) {
    try {
      const userId = req.user.id;
      const settingsData = req.body;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (!settingsData || typeof settingsData !== 'object') {
        throw new AppError('Settings data is required', 400);
      }

      // Validate required fields
      const requiredFields = [];
      if (requiredFields.some(field => !settingsData[field])) {
        throw new AppError(`Missing required fields: ${requiredFields.join(', ')}`, 400);
      }

      const updatedSettings = await settingsService.updateSettings(userId, settingsData);

      res.status(200).json({
        success: true,
        message: 'Settings updated successfully',
        data: {
          settings: updatedSettings
        }
      });
    } catch (error) {
      logger.error('Update settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to update settings', 500));
      }
    }
  }

  /**
   * Create user settings
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async createSettings(req, res, next) {
    try {
      const userId = req.user.id;
      const settingsData = req.body;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const settings = await settingsService.createSettings(userId, settingsData);

      res.status(201).json({
        success: true,
        message: 'Settings created successfully',
        data: {
          settings
        }
      });
    } catch (error) {
      logger.error('Create settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.code === 11000) {
        next(new AppError('Settings already exist for this user', 409));
      } else {
        next(new AppError('Failed to create settings', 500));
      }
    }
  }

  /**
   * Delete user settings
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteSettings(req, res, next) {
    try {
      const userId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      await settingsService.deleteSettings(userId);

      res.status(200).json({
        success: true,
        message: 'Settings deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to delete settings', 500));
      }
    }
  }

  /**
   * Reset user settings to defaults
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async resetSettings(req, res, next) {
    try {
      const userId = req.user.id;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      const resetSettings = await settingsService.resetSettings(userId);

      res.status(200).json({
        success: true,
        message: 'Settings reset to defaults successfully',
        data: {
          settings: resetSettings
        }
      });
    } catch (error) {
      logger.error('Reset settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to reset settings', 500));
      }
    }
  }

  /**
   * Get bulk settings for multiple users
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getBulkSettings(req, res, next) {
    try {
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new AppError('User IDs array is required', 400);
      }

      // Limit the number of users to prevent abuse
      if (userIds.length > 100) {
        throw new AppError('Maximum 100 users allowed per request', 400);
      }

      const settings = await settingsService.getBulkSettings(userIds);

      res.status(200).json({
        success: true,
        message: 'Bulk settings retrieved successfully',
        data: {
          settings
        }
      });
    } catch (error) {
      logger.error('Get bulk settings controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve bulk settings', 500));
      }
    }
  }

  /**
   * Update specific setting field
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateSettingField(req, res, next) {
    try {
      const userId = req.user.id;
      const { field, value } = req.body;

      if (!userId) {
        throw new AppError('User ID is required', 400);
      }

      if (!field || value === undefined) {
        throw new AppError('Field and value are required', 400);
      }

      const settingsData = { [field]: value };
      const updatedSettings = await settingsService.updateSettings(userId, settingsData);

      res.status(200).json({
        success: true,
        message: 'Setting field updated successfully',
        data: {
          settings: updatedSettings
        }
      });
    } catch (error) {
      logger.error('Update setting field controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else {
        next(new AppError('Failed to update setting field', 500));
      }
    }
  }
}

module.exports = new SettingsController();