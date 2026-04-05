// --- MODEL: Features.js ---
module.exports = (sequelize, DataTypes) => {
  const Features = sequelize.define(
    'Features',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
          notEmpty: true
        }
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: {
          len: [0, 500]
        }
      },
      category: {
        type: DataTypes.STRING,
        defaultValue: 'core',
        validate: {
          isIn: [['core', 'premium', 'experimental', 'beta', 'legacy']]
        }
      },
      version: {
        type: DataTypes.STRING,
        defaultValue: '1.0.0'
      },
      requiresPermission: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      allowedUserTypes: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: ['all'],
        validate: {
          isValidArray(value) {
            if (!Array.isArray(value)) {
              throw new Error('allowedUserTypes must be an array');
            }
            const validValues = ['free', 'premium', 'admin', 'moderator', 'all'];
            for (const val of value) {
              if (!validValues.includes(val)) {
                throw new Error(`Invalid user type: ${val}`);
              }
            }
          }
        }
      },
      rolloutPercentage: {
        type: DataTypes.INTEGER,
        defaultValue: 100,
        validate: {
          min: 0,
          max: 100
        }
      },
      configuration: {
        type: DataTypes.JSONB,
        defaultValue: {}
      },
      dependencies: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: []
      },
      lastEnabledAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      lastDisabledAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {}
      }
    },
    {
      tableName: 'features',
      modelName: 'Features',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          unique: true,
          fields: ['name']
        },
        {
          fields: ['enabled']
        },
        {
          fields: ['category']
        }
      ]
    }
  );

  // Virtual property simulation (PRESERVED)
  Features.prototype.getStatus = function() {
    if (this.enabled && this.rolloutPercentage === 100) return 'active';
    if (this.enabled && this.rolloutPercentage < 100) return 'rolling_out';
    if (!this.enabled) return 'disabled';
    return 'unknown';
  };

  // Static methods (PRESERVED)
  Features.getEnabledFeatures = async function() {
    return await this.findAll({
      where: { enabled: true },
      attributes: ['name', 'description', 'category', 'version']
    });
  };

  Features.getFeaturesByCategory = async function(category) {
    return await this.findAll({
      where: { category },
      order: [['name', 'ASC']]
    });
  };

  Features.toggleFeature = async function(name, enabled, userId = null) {
    const feature = await this.findOne({ where: { name } });
    if (!feature) {
      throw new Error(`Feature ${name} not found`);
    }
    
    feature.enabled = enabled;
    if (enabled) {
      feature.lastEnabledAt = new Date();
    } else {
      feature.lastDisabledAt = new Date();
    }
    
    return await feature.save();
  };

  // Instance methods (PRESERVED)
  Features.prototype.isAvailableForUser = function(userType) {
    if (this.allowedUserTypes.includes('all')) return true;
    return this.allowedUserTypes.includes(userType);
  };

  Features.prototype.shouldShowToUser = function(userId) {
    if (!this.enabled) return false;
    if (this.rolloutPercentage === 100) return true;
    
    const hash = this._hashString(userId.toString());
    return (hash % 100) < this.rolloutPercentage;
  };

  // Helper method (PRESERVED)
  Features.prototype._hashString = function(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  };

  // FIXED: Associations with unique aliases
  Features.associate = (models) => {
    if (models.Users) {
      Features.belongsTo(models.Users, {
        foreignKey: 'createdBy',
        as: 'featureCreator',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Features;
};