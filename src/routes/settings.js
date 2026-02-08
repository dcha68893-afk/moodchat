const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, NotificationSettings, PrivacySettings, AccountSettings } = require('../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const { uploadToCloudinary } = require('../utils/fileUpload');
const multer = require('multer');
const path = require('path');

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

router.use(authenticateToken);

console.log('✅ Settings routes initialized');

// Get all settings for current user
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;

      const [user, notificationSettings, privacySettings, accountSettings] = await Promise.all([
        User.findByPk(userId, {
          attributes: [
            'username', 'email', 'avatar', 'displayName', 'bio',
            'phoneNumber', 'location', 'website', 'theme', 'language',
            'twoFactorEnabled', 'emailVerified', 'phoneVerified'
          ]
        }),
        NotificationSettings.findOne({ where: { userId } }),
        PrivacySettings.findOne({ where: { userId } }),
        AccountSettings.findOne({ where: { userId } })
      ]);

      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      res.status(200).json({
        status: 'success',
        data: {
          profile: user,
          notifications: notificationSettings || {
            emailNotifications: true,
            pushNotifications: true,
            messageNotifications: true,
            callNotifications: true,
            groupNotifications: true,
            soundEnabled: true,
            vibrationEnabled: true,
            doNotDisturb: false,
            doNotDisturbStart: '22:00',
            doNotDisturbEnd: '08:00'
          },
          privacy: privacySettings || {
            profileVisibility: 'public',
            onlineStatus: 'all',
            lastSeen: 'all',
            readReceipts: true,
            typingIndicators: true,
            blockedUsers: [],
            whoCanAddMe: 'everyone',
            syncContacts: true,
            dataSaver: false
          },
          account: accountSettings || {
            loginAlerts: true,
            securityAlerts: true,
            autoBackup: false,
            backupFrequency: 'weekly',
            dataRetention: '30d',
            deleteAccountAfter: 'never'
          }
        }
      });
    } catch (error) {
      console.error('Error getting settings:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch settings'
      });
    }
  })
);

// Update profile settings
router.put(
  '/profile',
  apiRateLimiter,
  upload.single('avatar'),
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const {
        displayName,
        bio,
        phoneNumber,
        location,
        website,
        theme,
        language
      } = req.body;

      const updateData = {};
      
      if (displayName !== undefined) updateData.displayName = displayName;
      if (bio !== undefined) updateData.bio = bio;
      if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
      if (location !== undefined) updateData.location = location;
      if (website !== undefined) updateData.website = website;
      if (theme !== undefined) updateData.theme = theme;
      if (language !== undefined) updateData.language = language;

      // Handle avatar upload
      if (req.file) {
        try {
          const uploadResult = await uploadToCloudinary(req.file.buffer, 'avatars');
          updateData.avatar = uploadResult.secure_url;
        } catch (uploadError) {
          console.error('Error uploading avatar:', uploadError);
          return res.status(500).json({
            status: 'error',
            message: 'Failed to upload avatar'
          });
        }
      }

      await User.update(updateData, {
        where: { id: userId }
      });

      const updatedUser = await User.findByPk(userId, {
        attributes: [
          'username', 'email', 'avatar', 'displayName', 'bio',
          'phoneNumber', 'location', 'website', 'theme', 'language'
        ]
      });

      res.status(200).json({
        status: 'success',
        message: 'Profile updated successfully',
        data: { profile: updatedUser }
      });
    } catch (error) {
      console.error('Error updating profile:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update profile'
      });
    }
  })
);

// Update notification settings
router.put(
  '/notifications',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const {
        emailNotifications,
        pushNotifications,
        messageNotifications,
        callNotifications,
        groupNotifications,
        soundEnabled,
        vibrationEnabled,
        doNotDisturb,
        doNotDisturbStart,
        doNotDisturbEnd
      } = req.body;

      const [settings, created] = await NotificationSettings.findOrCreate({
        where: { userId },
        defaults: { userId }
      });

      const updateData = {};
      if (emailNotifications !== undefined) updateData.emailNotifications = emailNotifications;
      if (pushNotifications !== undefined) updateData.pushNotifications = pushNotifications;
      if (messageNotifications !== undefined) updateData.messageNotifications = messageNotifications;
      if (callNotifications !== undefined) updateData.callNotifications = callNotifications;
      if (groupNotifications !== undefined) updateData.groupNotifications = groupNotifications;
      if (soundEnabled !== undefined) updateData.soundEnabled = soundEnabled;
      if (vibrationEnabled !== undefined) updateData.vibrationEnabled = vibrationEnabled;
      if (doNotDisturb !== undefined) updateData.doNotDisturb = doNotDisturb;
      if (doNotDisturbStart !== undefined) updateData.doNotDisturbStart = doNotDisturbStart;
      if (doNotDisturbEnd !== undefined) updateData.doNotDisturbEnd = doNotDisturbEnd;

      await settings.update(updateData);

      res.status(200).json({
        status: 'success',
        message: 'Notification settings updated',
        data: { notifications: settings }
      });
    } catch (error) {
      console.error('Error updating notification settings:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update notification settings'
      });
    }
  })
);

// Update privacy settings
router.put(
  '/privacy',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const {
        profileVisibility,
        onlineStatus,
        lastSeen,
        readReceipts,
        typingIndicators,
        whoCanAddMe,
        syncContacts,
        dataSaver
      } = req.body;

      const [settings, created] = await PrivacySettings.findOrCreate({
        where: { userId },
        defaults: { userId }
      });

      const updateData = {};
      if (profileVisibility !== undefined) updateData.profileVisibility = profileVisibility;
      if (onlineStatus !== undefined) updateData.onlineStatus = onlineStatus;
      if (lastSeen !== undefined) updateData.lastSeen = lastSeen;
      if (readReceipts !== undefined) updateData.readReceipts = readReceipts;
      if (typingIndicators !== undefined) updateData.typingIndicators = typingIndicators;
      if (whoCanAddMe !== undefined) updateData.whoCanAddMe = whoCanAddMe;
      if (syncContacts !== undefined) updateData.syncContacts = syncContacts;
      if (dataSaver !== undefined) updateData.dataSaver = dataSaver;

      await settings.update(updateData);

      res.status(200).json({
        status: 'success',
        message: 'Privacy settings updated',
        data: { privacy: settings }
      });
    } catch (error) {
      console.error('Error updating privacy settings:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update privacy settings'
      });
    }
  })
);

// Update account settings
router.put(
  '/account',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const {
        loginAlerts,
        securityAlerts,
        autoBackup,
        backupFrequency,
        dataRetention,
        deleteAccountAfter
      } = req.body;

      const [settings, created] = await AccountSettings.findOrCreate({
        where: { userId },
        defaults: { userId }
      });

      const updateData = {};
      if (loginAlerts !== undefined) updateData.loginAlerts = loginAlerts;
      if (securityAlerts !== undefined) updateData.securityAlerts = securityAlerts;
      if (autoBackup !== undefined) updateData.autoBackup = autoBackup;
      if (backupFrequency !== undefined) updateData.backupFrequency = backupFrequency;
      if (dataRetention !== undefined) updateData.dataRetention = dataRetention;
      if (deleteAccountAfter !== undefined) updateData.deleteAccountAfter = deleteAccountAfter;

      await settings.update(updateData);

      res.status(200).json({
        status: 'success',
        message: 'Account settings updated',
        data: { account: settings }
      });
    } catch (error) {
      console.error('Error updating account settings:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update account settings'
      });
    }
  })
);

// Change password
router.post(
  '/change-password',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword, confirmPassword } = req.body;

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({
          status: 'error',
          message: 'All password fields are required'
        });
      }

      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          status: 'error',
          message: 'New passwords do not match'
        });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          status: 'error',
          message: 'Password must be at least 8 characters long'
        });
      }

      const user = await User.findByPk(userId);
      
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
      
      if (!isPasswordValid) {
        return res.status(400).json({
          status: 'error',
          message: 'Current password is incorrect'
        });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await user.update({ password: hashedPassword });

      res.status(200).json({
        status: 'success',
        message: 'Password changed successfully'
      });
    } catch (error) {
      console.error('Error changing password:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to change password'
      });
    }
  })
);

// Enable/Disable two-factor authentication
router.post(
  '/two-factor',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { enable, code } = req.body;

      const user = await User.findByPk(userId);
      
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      if (enable) {
        // In a real implementation, you would generate and verify a TOTP code
        // For now, we'll just toggle the setting
        await user.update({ twoFactorEnabled: true });
        
        return res.status(200).json({
          status: 'success',
          message: 'Two-factor authentication enabled',
          data: { twoFactorEnabled: true }
        });
      } else {
        await user.update({ twoFactorEnabled: false });
        
        return res.status(200).json({
          status: 'success',
          message: 'Two-factor authentication disabled',
          data: { twoFactorEnabled: false }
        });
      }
    } catch (error) {
      console.error('Error updating two-factor authentication:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to update two-factor authentication'
      });
    }
  })
);

// Get blocked users
router.get(
  '/blocked-users',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'blockedUsers',
          attributes: ['id', 'username', 'avatar', 'displayName'],
          through: { attributes: [] }
        }]
      });

      res.status(200).json({
        status: 'success',
        data: {
          blockedUsers: user.blockedUsers || []
        }
      });
    } catch (error) {
      console.error('Error getting blocked users:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch blocked users'
      });
    }
  })
);

// Block a user
router.post(
  '/block-user',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { targetUserId } = req.body;

      if (!targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Target user ID is required'
        });
      }

      if (userId === targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Cannot block yourself'
        });
      }

      const user = await User.findByPk(userId);
      const targetUser = await User.findByPk(targetUserId);
      
      if (!targetUser) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      await user.addBlockedUser(targetUser);

      res.status(200).json({
        status: 'success',
        message: 'User blocked successfully',
        data: { blockedUserId: targetUserId }
      });
    } catch (error) {
      console.error('Error blocking user:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to block user'
      });
    }
  })
);

// Unblock a user
router.post(
  '/unblock-user',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { targetUserId } = req.body;

      if (!targetUserId) {
        return res.status(400).json({
          status: 'error',
          message: 'Target user ID is required'
        });
      }

      const user = await User.findByPk(userId);
      const targetUser = await User.findByPk(targetUserId);
      
      if (!targetUser) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      await user.removeBlockedUser(targetUser);

      res.status(200).json({
        status: 'success',
        message: 'User unblocked successfully',
        data: { unblockedUserId: targetUserId }
      });
    } catch (error) {
      console.error('Error unblocking user:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to unblock user'
      });
    }
  })
);

// Export user data
router.get(
  '/export-data',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { format = 'json' } = req.query;

      const user = await User.findByPk(userId, {
        attributes: { exclude: ['password'] },
        include: [
          {
            model: User,
            as: 'blockedUsers',
            attributes: ['id', 'username', 'email'],
            through: { attributes: [] }
          }
        ]
      });

      const notificationSettings = await NotificationSettings.findOne({ where: { userId } });
      const privacySettings = await PrivacySettings.findOne({ where: { userId } });
      const accountSettings = await AccountSettings.findOne({ where: { userId } });

      const exportData = {
        exportedAt: new Date(),
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          profile: {
            displayName: user.displayName,
            bio: user.bio,
            avatar: user.avatar,
            phoneNumber: user.phoneNumber,
            location: user.location,
            website: user.website,
            theme: user.theme,
            language: user.language
          },
          security: {
            twoFactorEnabled: user.twoFactorEnabled,
            emailVerified: user.emailVerified,
            phoneVerified: user.phoneVerified,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
          }
        },
        settings: {
          notifications: notificationSettings || {},
          privacy: privacySettings || {},
          account: accountSettings || {}
        },
        blockedUsers: user.blockedUsers || []
      };

      if (format === 'csv') {
        // Convert to CSV format
        const csvData = [
          ['Field', 'Value'],
          ['User ID', exportData.user.id],
          ['Username', exportData.user.username],
          ['Email', exportData.user.email],
          ['Display Name', exportData.user.profile.displayName],
          ['Bio', exportData.user.profile.bio],
          ['Created At', exportData.user.security.createdAt],
          ['Two-Factor Enabled', exportData.user.security.twoFactorEnabled],
          ['Email Verified', exportData.user.security.emailVerified],
          ['Blocked Users Count', exportData.blockedUsers.length]
        ];

        const csv = csvData.map(row => row.map(field => `"${field}"`).join(',')).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename=user_data_${user.username}_${new Date().toISOString().split('T')[0]}.csv`
        );
        return res.send(csv);
      }

      res.status(200).json({
        status: 'success',
        data: exportData
      });
    } catch (error) {
      console.error('Error exporting user data:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to export user data'
      });
    }
  })
);

// Delete account
router.delete(
  '/account',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.user.userId;
      const { confirmation, password } = req.body;

      if (!confirmation || confirmation.toLowerCase() !== 'delete my account') {
        return res.status(400).json({
          status: 'error',
          message: 'Confirmation text is required and must match "delete my account"'
        });
      }

      const user = await User.findByPk(userId);
      
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }

      // Verify password if provided
      if (password) {
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
          return res.status(400).json({
            status: 'error',
            message: 'Incorrect password'
          });
        }
      }

      // In a real application, you might want to soft delete or schedule deletion
      // For now, we'll just mark as deleted
      await user.update({
        email: `deleted_${user.id}@deleted.com`,
        username: `deleted_user_${user.id}`,
        displayName: 'Deleted User',
        avatar: null,
        bio: null,
        phoneNumber: null,
        isActive: false,
        deletedAt: new Date()
      });

      res.status(200).json({
        status: 'success',
        message: 'Account scheduled for deletion'
      });
    } catch (error) {
      console.error('Error deleting account:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to delete account'
      });
    }
  })
);

module.exports = router;