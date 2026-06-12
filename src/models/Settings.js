// --- MODEL: Settings.js ---
module.exports = (sequelize, DataTypes) => {
  const Settings = sequelize.define(
    'Settings',
    {
      id: {
        type: DataTypes.INTEGER,  // Changed from UUID to INTEGER to match database
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'user_id',
      },
      theme: {
        type: DataTypes.STRING,
        defaultValue: 'light',
        allowNull: false,
      },
      accentColor: {
        type: DataTypes.STRING,
        defaultValue: '#000000',
        field: 'accent_color',
      },
      notificationsEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
        field: 'notifications_enabled',
      },
      language: {
        type: DataTypes.STRING,
        defaultValue: 'en',
        allowNull: false,
      },
      fontSize: {
        type: DataTypes.STRING,
        defaultValue: 'medium',
        field: 'font_size',
      },
      timezone: {
        type: DataTypes.STRING,
        defaultValue: 'UTC',
      },
      emailNotifications: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'email_notifications',
      },
      pushNotifications: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'push_notifications',
      },
      soundEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'sound_enabled',
      },
      vibrationEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'vibration_enabled',
      },
      dataSaver: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'data_saver',
      },
      autoDownload: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'auto_download',
      },
      privacy: {
        type: DataTypes.JSONB,
        defaultValue: {
          profileVisibility: 'public',
          readReceipts: true,
          typingIndicators: true,
          onlineStatus: true,
          lastSeen: true,
          whoCanSendFriendRequests: 'everyone',  // P3 FIX: 'everyone'|'friends_of_friends'|'nobody'
          whoCanSeeMyFriends: 'everyone',         // P3 FIX: 'everyone'|'friends'|'nobody'
          anniversaryNotifications: true          // P3 FIX: friendship anniversaries
        }
      },
      chatPreferences: {
        type: DataTypes.JSONB,
        defaultValue: {
          enterToSend: true,
          mediaQuality: 'auto',
          saveToGallery: false,
          messageBackup: true,
          messageHistory: 'forever'
        },
        field: 'chat_preferences',
      },
      moodSettings: {
        type: DataTypes.JSONB,
        defaultValue: {
          currentMood: 'neutral',
          autoMoodDetection: false,
          showMoodTo: 'friendsOnly',
          moodColors: {
            neutral: '#808080', happy: '#FFD700', calm: '#87CEEB',
            energetic: '#FF6347', focused: '#4169E1', relaxed: '#90EE90',
            stressed: '#DC143C', tired: '#9370DB', excited: '#FF69B4'
          }
        },
        field: 'mood_settings',
      },
      callSettings: {
        type: DataTypes.JSONB,
        defaultValue: { whoCanCallMe: 'everyone', callVibration: true, videoQuality: 'auto', voiceQuality: 'high', allowScreenShare: true },
        field: 'call_settings',
      },
      friendSettings: {
        type: DataTypes.JSONB,
        defaultValue: { whoCanAddMe: 'everyone', contactDiscovery: true },
        field: 'friend_settings',
      },
      groupSettings: {
        type: DataTypes.JSONB,
        defaultValue: { groupInvitations: 'everyone' },
        field: 'group_settings',
      },
      statusSettings: {
        type: DataTypes.JSONB,
        defaultValue: { statusVisibility: 'everyone', autoMuteStatuses: false },
        field: 'status_settings',
      },
      backupSettings: {
        type: DataTypes.JSONB,
        defaultValue: { autoBackup: false, backupFrequency: 'weekly', backupIncludeMedia: false },
        field: 'backup_settings',
      },
      advancedSettings: {
        type: DataTypes.JSONB,
        defaultValue: { syncEnabled: true, offlineMode: false, debugMode: false, developerTools: false, experimentalFeatures: false, performanceMode: false, reduceMotion: false },
        field: 'advanced_settings',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'createdAt',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updatedAt',
      }
    },
    {
      tableName: 'settings',
      modelName: 'Settings',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          unique: true,
          fields: ['user_id']
        }
      ],
    }
  );

  // Static methods
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

  // Instance methods
  Settings.prototype.updateSettings = async function(updates) {
    const allowedUpdates = [
      'theme', 'accentColor', 'notificationsEnabled', 'language', 'fontSize',
      'timezone', 'emailNotifications', 'pushNotifications', 'soundEnabled',
      'vibrationEnabled', 'dataSaver', 'autoDownload', 'privacy', 'chatPreferences',
      'moodSettings', 'callSettings', 'friendSettings', 'groupSettings',
      'statusSettings', 'backupSettings', 'advancedSettings'
    ];
    
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        this[key] = updates[key];
      }
    });
    
    return await this.save();
  };

  // Associations
  Settings.associate = (models) => {
    if (this.associations && Object.keys(this.associations).length > 0) {
      return;
    }
    
    if (models.Users) {
      Settings.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'settingOwner',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Settings;
};