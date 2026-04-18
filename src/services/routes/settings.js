const path = require('path');
const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, Settings } = require('../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const multer = require('multer');

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

console.log('✅ Settings routes initialized');

// Helper function for safe database queries
const safeDbQuery = async (queryFn, defaultValue = null) => {
    try {
        return await queryFn();
    } catch (error) {
        console.error('Database query error:', error.message);
        return defaultValue;
    }
};

// Helper function to safely get user ID
const getUserId = (req) => {
    if (!req.user) {
        console.error('[Settings] req.user is undefined!');
        return null;
    }
    return req.user.userId || req.user.id;
};

// Get all settings for current user
router.get(
    '/',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }

            // Get user with only existing fields
            const user = await safeDbQuery(
                () => User.findByPk(userId, {
                    attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'theme', 'language']
                }),
                { username: 'User', email: 'user@example.com' }
            );

            // Get or create settings - FIXED: Use findOrCreate to avoid manual ID
            let settings = null;
            if (Settings) {
                const [foundSettings, created] = await Settings.findOrCreate({
                    where: { userId: userId },
                    defaults: {
                        userId: userId,
                        theme: 'light',
                        language: 'en',
                        notificationsEnabled: true,
                        emailNotifications: true,
                        pushNotifications: true,
                        soundEnabled: true,
                        vibrationEnabled: true,
                        accentColor: '#000000',
                        fontSize: 'medium',
                        timezone: 'UTC',
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
                    }
                });
                settings = foundSettings;
                if (created) {
                    console.log(`[Settings] Created new settings for user ${userId}`);
                }
            }

            res.status(200).json({
                status: 'success',
                data: {
                    profile: {
                        id: user?.id,
                        username: user?.username || 'User',
                        email: user?.email || '',
                        avatar: user?.avatar || null,
                        firstName: user?.firstName || null,
                        lastName: user?.lastName || null,
                        bio: user?.bio || null,
                        theme: user?.theme || settings?.theme || 'light',
                        language: user?.language || settings?.language || 'en'
                    },
                    notifications: {
                        emailNotifications: settings?.emailNotifications !== undefined ? settings.emailNotifications : true,
                        pushNotifications: settings?.pushNotifications !== undefined ? settings.pushNotifications : true,
                        messageNotifications: true,
                        callNotifications: true,
                        groupNotifications: true,
                        soundEnabled: settings?.soundEnabled !== undefined ? settings.soundEnabled : true,
                        vibrationEnabled: settings?.vibrationEnabled !== undefined ? settings.vibrationEnabled : true,
                        doNotDisturb: false,
                        doNotDisturbStart: '22:00',
                        doNotDisturbEnd: '08:00'
                    },
                    privacy: {
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
                    account: {
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
            // Return default settings on error
            res.status(200).json({
                status: 'success',
                data: {
                    profile: { username: 'User' },
                    notifications: {},
                    privacy: {},
                    account: {}
                }
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
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            const {
                displayName, username, bio, theme, language, firstName, lastName
            } = req.body;

            const updateData = {};

            if (displayName !== undefined) updateData.username = displayName;
            if (username !== undefined) updateData.username = username;
            if (bio !== undefined) updateData.bio = bio;
            if (theme !== undefined) updateData.theme = theme;
            if (language !== undefined) updateData.language = language;
            if (firstName !== undefined) updateData.firstName = firstName;
            if (lastName !== undefined) updateData.lastName = lastName;

            // Handle avatar upload
            if (req.file) {
                try {
                    const { uploadToCloudinary } = require('../utils/fileUpload');
                    const uploadResult = await uploadToCloudinary(req.file.buffer, 'avatars');
                    updateData.avatar = uploadResult.secure_url;
                } catch (uploadError) {
                    console.error('Error uploading avatar:', uploadError);
                }
            }

            if (Object.keys(updateData).length > 0) {
                await User.update(updateData, { where: { id: userId } });
            }

            const updatedUser = await User.findByPk(userId, {
                attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'theme', 'language']
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
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            const {
                emailNotifications,
                pushNotifications,
                soundEnabled,
                vibrationEnabled
            } = req.body;

            const updateData = {};

            if (emailNotifications !== undefined) updateData.emailNotifications = emailNotifications;
            if (pushNotifications !== undefined) updateData.pushNotifications = pushNotifications;
            if (soundEnabled !== undefined) updateData.soundEnabled = soundEnabled;
            if (vibrationEnabled !== undefined) updateData.vibrationEnabled = vibrationEnabled;

            if (Object.keys(updateData).length > 0 && Settings) {
                await Settings.update(updateData, { where: { userId: userId } });
            }

            res.status(200).json({
                status: 'success',
                message: 'Notification settings updated',
                data: { notifications: updateData }
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

// Update theme
router.put(
    '/theme',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            const { theme } = req.body;

            if (!theme || !['light', 'dark', 'system'].includes(theme)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid theme selection'
                });
            }

            await User.update({ theme }, { where: { id: userId } });

            if (Settings) {
                await Settings.update({ theme }, { where: { userId: userId } });
            }

            res.status(200).json({
                status: 'success',
                message: 'Theme updated successfully',
                data: { theme }
            });
        } catch (error) {
            console.error('Error updating theme:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update theme'
            });
        }
    })
);

// Update language
router.put(
    '/language',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            const { language } = req.body;

            if (!language || !['en', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'ru'].includes(language)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid language selection'
                });
            }

            await User.update({ language }, { where: { id: userId } });

            if (Settings) {
                await Settings.update({ language }, { where: { userId: userId } });
            }

            res.status(200).json({
                status: 'success',
                message: 'Language updated successfully',
                data: { language }
            });
        } catch (error) {
            console.error('Error updating language:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update language'
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
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
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

// Get blocked users - safe response
router.get(
    '/blocked-users',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }

            res.status(200).json({
                status: 'success',
                data: { blockedUsers: [] }
            });
        } catch (error) {
            console.error('Error getting blocked users:', error);
            res.status(200).json({
                status: 'success',
                data: { blockedUsers: [] }
            });
        }
    })
);

// Block a user - placeholder
router.post(
    '/block-user',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
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

// Unblock a user - placeholder
router.post(
    '/unblock-user',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            const { targetUserId } = req.body;

            if (!targetUserId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Target user ID is required'
                });
            }

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
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            const { format = 'json' } = req.query;

            const user = await User.findByPk(userId, {
                attributes: { exclude: ['password'] }
            });

            if (!user) {
                return res.status(404).json({
                    status: 'error',
                    message: 'User not found'
                });
            }

            const exportData = {
                exportedAt: new Date(),
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    profile: {
                        displayName: user.username,
                        bio: user.bio,
                        avatar: user.avatar,
                        theme: user.theme || 'light',
                        language: user.language || 'en'
                    },
                    security: {
                        createdAt: user.createdAt,
                        lastLogin: user.lastSeen
                    }
                },
                settings: {
                    notifications: {},
                    privacy: {},
                    account: {}
                }
            };

            if (format === 'csv') {
                const csvData = [
                    ['Field', 'Value'],
                    ['User ID', exportData.user.id],
                    ['Username', exportData.user.username],
                    ['Email', exportData.user.email],
                    ['Display Name', exportData.user.profile.displayName],
                    ['Bio', exportData.user.profile.bio || ''],
                    ['Created At', exportData.user.security.createdAt],
                    ['Theme', exportData.user.profile.theme],
                    ['Language', exportData.user.profile.language]
                ];

                const csv = csvData.map(row => row.map(field => `"${field || ''}"`).join(',')).join('\n');

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
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
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

            // Soft delete - mark as inactive
            await user.update({
                email: `deleted_${user.id}@deleted.com`,
                username: `deleted_user_${user.id}`,
                firstName: null,
                lastName: null,
                avatar: null,
                bio: null,
                isActive: false,
                deletedAt: new Date()
            });

            // Delete settings if exists
            if (Settings) {
                await Settings.destroy({ where: { userId: userId } });
            }

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