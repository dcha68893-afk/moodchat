// --- MODEL: Profile.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
      },
      website: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          isUrl: true,
        },
      },
      location: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      occupation: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      education: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      interests: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      socialLinks: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      privacySettings: {
        type: DataTypes.JSONB,
        defaultValue: {
          showEmail: false,
          showPhone: false,
          showAge: false,
          showLocation: false,
          showOccupation: false,
          showEducation: false,
        },
        allowNull: false,
      },
      themeSettings: {
        type: DataTypes.JSONB,
        defaultValue: {
          primaryColor: '#1890ff',
          backgroundColor: '#ffffff',
          fontSize: 'medium',
          density: 'comfortable',
        },
        allowNull: false,
      },
      notificationSettings: {
        type: DataTypes.JSONB,
        defaultValue: {
          emailNotifications: true,
          pushNotifications: true,
          soundEnabled: true,
          vibrationEnabled: true,
        },
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'profiles',
      modelName: 'Profile',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['user_id'],
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
  Profile.prototype.getPublicInfo = function () {
    const publicFields = [
      'id',
      'userId',
      'website',
      'location',
      'occupation',
      'education',
      'interests',
      'socialLinks',
    ];

    const result = {};
    publicFields.forEach(field => {
      if (field === 'location' && !this.privacySettings.showLocation) return;
      if (field === 'occupation' && !this.privacySettings.showOccupation) return;
      if (field === 'education' && !this.privacySettings.showEducation) return;
      result[field] = this[field];
    });

    return result;
  };

  // FIXED: Associations with unique aliases
  Profile.associate = function(models) {
    // CRITICAL: Prevent duplicate associations (alias conflict fix)
    if (this.associations && Object.keys(this.associations).length > 0) {
        // Skip if associations already defined to prevent alias conflicts
        return;
    }
        
    if (models.Users) {
      Profile.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'profileOwner',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Profile;
};
