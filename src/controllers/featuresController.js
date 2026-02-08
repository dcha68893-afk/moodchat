const featuresService = require('../services/featuresService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class FeaturesController {
  /**
   * Get all features
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getAllFeatures(req, res, next) {
    try {
      const {
        enabled,
        category,
        page = 1,
        limit = 50,
        sortBy = 'name',
        sortOrder = 'asc'
      } = req.query;

      const options = {
        enabled,
        category,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder
      };

      // Validate pagination
      if (options.page < 1 || options.limit < 1 || options.limit > 100) {
        throw new AppError('Invalid pagination parameters', 400);
      }

      const result = await featuresService.getAllFeatures(options);

      res.status(200).json({
        success: true,
        message: 'Features retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get all features controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve features', 500));
      }
    }
  }

  /**
   * Get feature by name
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getFeatureByName(req, res, next) {
    try {
      const { name } = req.params;

      if (!name) {
        throw new AppError('Feature name is required', 400);
      }

      const feature = await featuresService.getFeatureByName(name);

      res.status(200).json({
        success: true,
        message: 'Feature retrieved successfully',
        data: {
          feature
        }
      });
    } catch (error) {
      logger.error('Get feature by name controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to retrieve feature', 500));
      }
    }
  }

  /**
   * Update feature
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async updateFeature(req, res, next) {
    try {
      const { name } = req.params;
      const updateData = req.body;
      const userId = req.user?.id;

      if (!name) {
        throw new AppError('Feature name is required', 400);
      }

      if (!updateData || typeof updateData !== 'object') {
        throw new AppError('Update data is required', 400);
      }

      const feature = await featuresService.updateFeature(name, updateData, userId);

      res.status(200).json({
        success: true,
        message: 'Feature updated successfully',
        data: {
          feature
        }
      });
    } catch (error) {
      logger.error('Update feature controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to update feature', 500));
      }
    }
  }

  /**
   * Create new feature
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async createFeature(req, res, next) {
    try {
      const featureData = req.body;
      const userId = req.user?.id;

      if (!featureData || !featureData.name) {
        throw new AppError('Feature name is required', 400);
      }

      // Validate required fields
      const requiredFields = ['name'];
      const missingFields = requiredFields.filter(field => !featureData[field]);
      
      if (missingFields.length > 0) {
        throw new AppError(`Missing required fields: ${missingFields.join(', ')}`, 400);
      }

      const feature = await featuresService.createFeature(featureData, userId);

      res.status(201).json({
        success: true,
        message: 'Feature created successfully',
        data: {
          feature
        }
      });
    } catch (error) {
      logger.error('Create feature controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.code === 11000) {
        next(new AppError('Feature already exists', 409));
      } else {
        next(new AppError('Failed to create feature', 500));
      }
    }
  }

  /**
   * Delete feature
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async deleteFeature(req, res, next) {
    try {
      const { name } = req.params;

      if (!name) {
        throw new AppError('Feature name is required', 400);
      }

      await featuresService.deleteFeature(name);

      res.status(200).json({
        success: true,
        message: 'Feature deleted successfully',
        data: null
      });
    } catch (error) {
      logger.error('Delete feature controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to delete feature', 500));
      }
    }
  }

  /**
   * Toggle feature status
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async toggleFeature(req, res, next) {
    try {
      const { name } = req.params;
      const { enabled } = req.body;
      const userId = req.user?.id;

      if (!name) {
        throw new AppError('Feature name is required', 400);
      }

      if (typeof enabled !== 'boolean') {
        throw new AppError('Enabled status must be a boolean', 400);
      }

      const feature = await featuresService.toggleFeature(name, enabled, userId);

      res.status(200).json({
        success: true,
        message: `Feature ${enabled ? 'enabled' : 'disabled'} successfully`,
        data: {
          feature
        }
      });
    } catch (error) {
      logger.error('Toggle feature controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.name === 'ValidationError') {
        next(new AppError(error.message, 400));
      } else if (error.message.includes('not found')) {
        next(new AppError(error.message, 404));
      } else {
        next(new AppError('Failed to toggle feature', 500));
      }
    }
  }

  /**
   * Get features by category
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getFeaturesByCategory(req, res, next) {
    try {
      const { category } = req.params;

      if (!category) {
        throw new AppError('Category is required', 400);
      }

      const features = await featuresService.getFeaturesByCategory(category);

      res.status(200).json({
        success: true,
        message: 'Features retrieved successfully',
        data: {
          features
        }
      });
    } catch (error) {
      logger.error('Get features by category controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve features by category', 500));
      }
    }
  }

  /**
   * Get enabled features for current user
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async getEnabledFeaturesForUser(req, res, next) {
    try {
      const userType = req.user?.role || 'free';
      const userId = req.user?.id;

      const features = await featuresService.getEnabledFeaturesForUser(userType, userId);

      res.status(200).json({
        success: true,
        message: 'Enabled features retrieved successfully',
        data: {
          features
        }
      });
    } catch (error) {
      logger.error('Get enabled features for user controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        next(new AppError('Failed to retrieve enabled features', 500));
      }
    }
  }

  /**
   * Check if specific feature is enabled for user
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next middleware function
   */
  async checkFeatureEnabled(req, res, next) {
    try {
      const { name } = req.params;
      const userType = req.user?.role || 'free';
      const userId = req.user?.id;

      if (!name) {
        throw new AppError('Feature name is required', 400);
      }

      // Get the feature
      const feature = await featuresService.getFeatureByName(name);
      
      // Check if feature is enabled and available for user
      let isEnabled = feature.enabled;
      let isAvailable = true;
      let reason = '';

      if (!feature.enabled) {
        isEnabled = false;
        isAvailable = false;
        reason = 'Feature is disabled globally';
      } else if (!feature.allowedUserTypes.includes('all') && 
                 !feature.allowedUserTypes.includes(userType)) {
        isEnabled = false;
        isAvailable = false;
        reason = 'Feature not available for your user type';
      } else if (userId && feature.rolloutPercentage < 100) {
        // Check rollout percentage
        const hash = this._hashString(userId.toString());
        if ((hash % 100) >= feature.rolloutPercentage) {
          isEnabled = false;
          isAvailable = false;
          reason = 'Feature not rolled out to your account yet';
        }
      }

      res.status(200).json({
        success: true,
        message: 'Feature status checked successfully',
        data: {
          name: feature.name,
          isEnabled,
          isAvailable,
          rolloutPercentage: feature.rolloutPercentage,
          allowedUserTypes: feature.allowedUserTypes,
          reason: isAvailable ? null : reason
        }
      });
    } catch (error) {
      logger.error('Check feature enabled controller error:', error);
      
      if (error instanceof AppError) {
        next(error);
      } else if (error.message.includes('not found')) {
        next(new AppError('Feature not found', 404));
      } else {
        next(new AppError('Failed to check feature status', 500));
      }
    }
  }

  /**
   * Hash string for deterministic rollout
   * @private
   * @param {string} str - String to hash
   * @returns {number} Hash value
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
}

module.exports = new FeaturesController();