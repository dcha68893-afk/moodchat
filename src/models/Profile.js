const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

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
        references: {
          model: 'users',
          key: 'id',
        },
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
    },
    {
      tableName: 'profiles',
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

  // Instance methods
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

    // Filter based on privacy settings
    const result = {};
    publicFields.forEach(field => {
      if (field === 'location' && !this.privacySettings.showLocation) return;
      if (field === 'occupation' && !this.privacySettings.showOccupation) return;
      if (field === 'education' && !this.privacySettings.showEducation) return;
      result[field] = this[field];
    });

    return result;
  };

  // Associations defined in models/index.js
  Profile.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return Profile;
};