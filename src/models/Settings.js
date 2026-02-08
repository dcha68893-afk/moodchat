module.exports = (sequelize, DataTypes) => {
  const Settings = sequelize.define('Settings', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    theme: {
      type: DataTypes.STRING,
      defaultValue: 'light',
      allowNull: false,
      validate: {
        isIn: [['light', 'dark', 'system']]
      }
    },
    accentColor: {
      type: DataTypes.STRING,
      defaultValue: '#000000',
      validate: {
        isHexColor(value) {
          if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(value)) {
            throw new Error(`${value} is not a valid hex color!`);
          }
        }
      }
    },
    notificationsEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false
    },
    language: {
      type: DataTypes.STRING,
      defaultValue: 'en',
      allowNull: false,
      validate: {
        isIn: [['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ru', 'ar']]
      }
    },
    fontSize: {
      type: DataTypes.STRING,
      defaultValue: 'medium',
      validate: {
        isIn: [['small', 'medium', 'large']]
      }
    },
    timezone: {
      type: DataTypes.STRING,
      defaultValue: 'UTC'
    },
    emailNotifications: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    pushNotifications: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    soundEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    vibrationEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    dataSaver: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    autoDownload: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    privacy: {
      type: DataTypes.JSONB,
      defaultValue: {
        profileVisibility: 'public',
        readReceipts: true,
        typingIndicators: true,
        onlineStatus: true,
        lastSeen: true
      }
    },
    chatPreferences: {
      type: DataTypes.JSONB,
      defaultValue: {
        enterToSend: true,
        mediaQuality: 'auto',
        saveToGallery: false,
        messageBackup: true
      }
    }
  }, {
    tableName: 'settings',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['userId']
      }
    ]
  });

  Settings.associate = (models) => {
    Settings.belongsTo(models.Users, {
      foreignKey: 'userId',
      as: 'user'
    });
  };

  // Static method equivalent
  Settings.getDefaultSettings = function() {
    return {
      theme: 'light',
      accentColor: '#000000',
      notificationsEnabled: true,
      language: 'en',
      fontSize: 'medium',
      timezone: 'UTC',
      emailNotifications: true,
      pushNotifications: true,
      soundEnabled: true,
      vibrationEnabled: true,
      dataSaver: false,
      autoDownload: false,
      privacy: {
        profileVisibility: 'public',
        readReceipts: true,
        typingIndicators: true,
        onlineStatus: true,
        lastSeen: true
      },
      chatPreferences: {
        enterToSend: true,
        mediaQuality: 'auto',
        saveToGallery: false,
        messageBackup: true
      }
    };
  };

  // Instance method equivalent
  Settings.prototype.updateSettings = async function(updates) {
    const allowedUpdates = [
      'theme', 'accentColor', 'notificationsEnabled', 'language', 'fontSize',
      'timezone', 'emailNotifications', 'pushNotifications', 'soundEnabled',
      'vibrationEnabled', 'dataSaver', 'autoDownload', 'privacy', 'chatPreferences'
    ];
    
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        this[key] = updates[key];
      }
    });
    
    return await this.save();
  };

  return Settings;
};