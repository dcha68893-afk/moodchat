// --- MODEL: Settings.js ---
module.exports = (sequelize, DataTypes) => {
  const Settings = sequelize.define(
    'Settings',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
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
    },
    {
      tableName: 'settings',                 // Standardized: lowercase table name
      modelName: 'Settings',                  // Explicit model name
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          unique: true,
          fields: ['userId']
        }
      ]
    }
  );

  // Static methods (PRESERVED)
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

  // Instance methods (PRESERVED)
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

  // FIXED: Associations with unique aliases
  Settings.associate = (models) => {
    if (models.Users) {
      Settings.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'settingOwnerUser',               // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Settings;
};