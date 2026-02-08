const Features = require('../models/Features');
const { ServerError, ValidationError, NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Features Service
 * Handles feature flag management
 */
class FeaturesService {
  /**
   * Get all features
   * @param {Object} options - Query options
   * @returns {Promise<Array>} All features
   */
  async getAllFeatures(options = {}) {
    try {
      const {
        enabled,
        category,
        page = 1,
        limit = 50,
        sortBy = 'name',
        sortOrder = 'asc'
      } = options;

      const query = {};
      
      if (enabled !== undefined) {
        query.enabled = enabled === 'true';
      }
      
      if (category) {
        query.category = category;
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

      const [features, total] = await Promise.all([
        Features.find(query)
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        Features.countDocuments(query)
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        features: features.map(feature => this._formatFeatureResponse(feature)),
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalFeatures: total,
          hasNext: parseInt(page) < totalPages,
          hasPrevious: parseInt(page) > 1
        }
      };
    } catch (error) {
      logger.error('Error getting all features:', error);
      throw new ServerError('Failed to get features');
    }
  }

  /**
   * Get feature by name
   * @param {string} name - Feature name
   * @returns {Promise<Object>} Feature details
   */
  async getFeatureByName(name) {
    try {
      if (!name) {
        throw new ValidationError('Feature name is required');
      }

      const feature = await Features.findOne({ name }).lean();

      if (!feature) {
        throw new NotFoundError(`Feature '${name}' not found`);
      }

      return this._formatFeatureResponse(feature);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error getting feature by name:', error);
      throw new ServerError('Failed to get feature');
    }
  }

  /**
   * Update feature
   * @param {string} name - Feature name
   * @param {Object} data - Update data
   * @param {string} userId - User ID making the update
   * @returns {Promise<Object>} Updated feature
   */
  async updateFeature(name, data, userId = null) {
    try {
      if (!name) {
        throw new ValidationError('Feature name is required');
      }

      if (!data || typeof data !== 'object') {
        throw new ValidationError('Update data is required');
      }

      // Validate update data
      this._validateFeatureUpdate(data);

      const updateData = { ...data };
      if (userId) {
        updateData.updatedBy = userId;
      }

      // Track enabled/disabled timestamps
      if (data.enabled !== undefined) {
        if (data.enabled) {
          updateData.lastEnabledAt = new Date();
        } else {
          updateData.lastDisabledAt = new Date();
        }
      }

      const feature = await Features.findOneAndUpdate(
        { name },
        { $set: updateData },
        { new: true, runValidators: true }
      ).lean();

      if (!feature) {
        throw new NotFoundError(`Feature '${name}' not found`);
      }

      return this._formatFeatureResponse(feature);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error updating feature:', error);
      throw new ServerError('Failed to update feature');
    }
  }

  /**
   * Create a new feature
   * @param {Object} featureData - Feature data
   * @param {string} userId - User ID creating the feature
   * @returns {Promise<Object>} Created feature
   */
  async createFeature(featureData, userId = null) {
    try {
      if (!featureData || !featureData.name) {
        throw new ValidationError('Feature name is required');
      }

      // Check if feature already exists
      const existingFeature = await Features.findOne({ name: featureData.name });
      if (existingFeature) {
        throw new ValidationError(`Feature '${featureData.name}' already exists`);
      }

      const feature = new Features({
        ...featureData,
        createdBy: userId
      });

      await feature.save();

      return this._formatFeatureResponse(feature.toObject());
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error creating feature:', error);
      throw new ServerError('Failed to create feature');
    }
  }

  /**
   * Delete a feature
   * @param {string} name - Feature name
   * @returns {Promise<boolean>} Success status
   */
  async deleteFeature(name) {
    try {
      if (!name) {
        throw new ValidationError('Feature name is required');
      }

      const result = await Features.deleteOne({ name });

      if (result.deletedCount === 0) {
        throw new NotFoundError(`Feature '${name}' not found`);
      }

      return true;
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error deleting feature:', error);
      throw new ServerError('Failed to delete feature');
    }
  }

  /**
   * Toggle feature status
   * @param {string} name - Feature name
   * @param {boolean} enabled - Whether to enable or disable
   * @param {string} userId - User ID making the change
   * @returns {Promise<Object>} Updated feature
   */
  async toggleFeature(name, enabled, userId = null) {
    try {
      if (!name) {
        throw new ValidationError('Feature name is required');
      }

      if (typeof enabled !== 'boolean') {
        throw new ValidationError('Enabled status must be a boolean');
      }

      const updateData = { enabled };
      if (enabled) {
        updateData.lastEnabledAt = new Date();
      } else {
        updateData.lastDisabledAt = new Date();
      }

      if (userId) {
        updateData.updatedBy = userId;
      }

      const feature = await Features.findOneAndUpdate(
        { name },
        { $set: updateData },
        { new: true }
      ).lean();

      if (!feature) {
        throw new NotFoundError(`Feature '${name}' not found`);
      }

      return this._formatFeatureResponse(feature);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      logger.error('Error toggling feature:', error);
      throw new ServerError('Failed to toggle feature');
    }
  }

  /**
   * Get enabled features for a user
   * @param {string} userType - User type/role
   * @param {string} userId - User ID for rollout calculation
   * @returns {Promise<Array>} Features available to the user
   */
  async getEnabledFeaturesForUser(userType, userId = null) {
    try {
      if (!userType) {
        throw new ValidationError('User type is required');
      }

      const features = await Features.find({ enabled: true }).lean();

      // Filter features based on user type and rollout
      const availableFeatures = features.filter(feature => {
        // Check if user type is allowed
        if (!feature.allowedUserTypes.includes('all') && 
            !feature.allowedUserTypes.includes(userType)) {
          return false;
        }

        // Check rollout percentage if userId is provided
        if (userId && feature.rolloutPercentage < 100) {
          // Simple deterministic rollout calculation
          const hash = this._hashString(userId.toString());
          return (hash % 100) < feature.rolloutPercentage;
        }

        return true;
      });

      return availableFeatures.map(feature => ({
        name: feature.name,
        description: feature.description,
        category: feature.category,
        version: feature.version,
        requiresPermission: feature.requiresPermission,
        configuration: feature.configuration
      }));
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting enabled features for user:', error);
      throw new ServerError('Failed to get enabled features');
    }
  }

  /**
   * Get features by category
   * @param {string} category - Feature category
   * @returns {Promise<Array>} Features in category
   */
  async getFeaturesByCategory(category) {
    try {
      if (!category) {
        throw new ValidationError('Category is required');
      }

      const features = await Features.find({ category }).lean();
      return features.map(feature => this._formatFeatureResponse(feature));
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Error getting features by category:', error);
      throw new ServerError('Failed to get features by category');
    }
  }

  /**
   * Validate feature update
   * @private
   * @param {Object} data - Feature update data
   */
  _validateFeatureUpdate(data) {
    const allowedFields = [
      'enabled', 'description', 'category', 'version', 'requiresPermission',
      'allowedUserTypes', 'rolloutPercentage', 'configuration', 'dependencies',
      'metadata'
    ];

    // Check for invalid fields
    const invalidFields = Object.keys(data).filter(
      field => !allowedFields.includes(field)
    );

    if (invalidFields.length > 0) {
      throw new ValidationError(`Invalid fields: ${invalidFields.join(', ')}`);
    }

    // Validate specific fields if present
    if (data.category && !['core', 'premium', 'experimental', 'beta', 'legacy'].includes(data.category)) {
      throw new ValidationError('Invalid category');
    }

    if (data.rolloutPercentage !== undefined) {
      const rollout = parseInt(data.rolloutPercentage);
      if (isNaN(rollout) || rollout < 0 || rollout > 100) {
        throw new ValidationError('Rollout percentage must be between 0 and 100');
      }
    }

    if (data.allowedUserTypes && Array.isArray(data.allowedUserTypes)) {
      const validUserTypes = ['free', 'premium', 'admin', 'moderator', 'all'];
      const invalidTypes = data.allowedUserTypes.filter(type => !validUserTypes.includes(type));
      if (invalidTypes.length > 0) {
        throw new ValidationError(`Invalid user types: ${invalidTypes.join(', ')}`);
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

  /**
   * Format feature response
   * @private
   * @param {Object} feature - Feature document
   * @returns {Object} Formatted feature response
   */
  _formatFeatureResponse(feature) {
    return {
      id: feature._id,
      name: feature.name,
      enabled: feature.enabled,
      description: feature.description,
      category: feature.category,
      version: feature.version,
      requiresPermission: feature.requiresPermission,
      allowedUserTypes: feature.allowedUserTypes,
      rolloutPercentage: feature.rolloutPercentage,
      configuration: feature.configuration,
      dependencies: feature.dependencies,
      lastEnabledAt: feature.lastEnabledAt,
      lastDisabledAt: feature.lastDisabledAt,
      createdBy: feature.createdBy,
      metadata: feature.metadata,
      status: feature.enabled ? 
        (feature.rolloutPercentage === 100 ? 'active' : 'rolling_out') : 
        'disabled',
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt
    };
  }
}

module.exports = new FeaturesService();