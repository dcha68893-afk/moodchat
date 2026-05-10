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

// ─── Helper: emit settings_updated socket event to the requesting user ───────
function _emitSettingsUpdated(req, settingsPayload) {
    try {
        const io = global.__socketIO || global.__io || global.io;
        if (!io) return;
        const userId = getUserId(req);
        if (!userId) return;
        // Emit to all sockets for this user so every open tab/device receives the update
        [`user:${userId}`, `user_${userId}`, `user:${String(userId)}`, `user_${String(userId)}`].forEach(room => {
            io.to(room).emit('settings_updated', {
                type: 'settings_updated',
                userId,
                settings: settingsPayload,
                timestamp: Date.now()
            });
        });
    } catch (e) {
        console.warn('[Settings] Socket emit failed (non-critical):', e.message);
    }
}

// ─── Helper: build the full AppSettings-schema response from DB rows ─────────
function _buildSettingsResponse(user, settings) {
    const priv  = (settings && settings.privacy)         || {};
    const chat  = (settings && settings.chatPreferences) || {};

    return {
        // ── appearance ──────────────────────────────────────────────────────
        appearance: {
            theme:        (user && user.theme)    || (settings && settings.theme)    || 'light',
            language:     (user && user.language) || (settings && settings.language) || 'en',
            accentColor:  (settings && settings.accentColor)  || '#4F46E5',
            fontSize:     (settings && settings.fontSize)     || 'medium',
            reduceMotion: false,
            timeFormat:   '12h',
            dateFormat:   'mm/dd/yyyy'
        },
        // ── notifications ────────────────────────────────────────────────────
        notifications: {
            messageNotifications:       (settings && settings.notificationsEnabled) !== false,
            emailNotifications:         (settings && settings.emailNotifications)   !== false,
            pushNotifications:          (settings && settings.pushNotifications)    !== false,
            groupNotifications:         true,
            callNotifications:          true,
            statusNotifications:        true,
            notificationSound:          (settings && settings.soundEnabled)         !== false,
            notificationVibration:      (settings && settings.vibrationEnabled)     !== false,
            popupNotifications:         false,
            doNotDisturb:               false,
            doNotDisturbStart:          '22:00',
            doNotDisturbEnd:            '08:00'
        },
        // ── privacy ──────────────────────────────────────────────────────────
        privacy: {
            profileVisibility:  priv.profileVisibility  || 'public',
            readReceipts:       priv.readReceipts        !== false,
            typingIndicators:   priv.typingIndicators    !== false,
            onlineStatus:       priv.onlineStatus        !== false,
            lastSeen:           priv.lastSeen            !== false,
            whoCanAddMe:        priv.whoCanAddMe         || 'everyone',
            contactDiscovery:   priv.contactDiscovery    !== false,
            statusVisibility:   priv.statusVisibility    || 'everyone'
        },
        // ── chat ─────────────────────────────────────────────────────────────
        chat: {
            enterKeySends:       chat.enterToSend         !== false,
            mediaDownload:       (settings && settings.autoDownload) ? 'always' : 'wifi',
            autoDownloadMedia:   (settings && settings.autoDownload) !== false,
            saveMedia:           chat.saveToGallery        || false,
            disappearingMessages:'off',
            fontSize:            (settings && settings.fontSize) || 'medium'
        },
        // ── account ──────────────────────────────────────────────────────────
        account: {
            id:            user && user.id,
            username:      (user && user.username)   || 'User',
            email:         (user && user.email)      || '',
            avatar:        (user && user.avatar)     || null,
            firstName:     (user && user.firstName)  || null,
            lastName:      (user && user.lastName)   || null,
            bio:           (user && user.bio)        || null,
            loginAlerts:   true,
            securityAlerts:true,
            autoBackup:    false,
            backupFrequency:'weekly',
            deleteAccountAfter: 'never'
        },
        // ── advanced ─────────────────────────────────────────────────────────
        advanced: {
            dataSaver:    (settings && settings.dataSaver)   || false,
            syncEnabled:  false,
            offlineMode:  true,
            debugMode:    false,
            lowBandwidth: false
        },
        // ── calls (persisted in chatPreferences JSONB for now) ───────────────
        calls: {
            whoCanCallMe:       'friends',
            ringtone:           'default',
            callVibration:      true,
            autoAnswer:         false,
            videoQuality:       chat.mediaQuality || 'auto',
            noiseCancellation:  true,
            echoCancellation:   true,
            liveReactions:      true,
            inCallChat:         true
        },
        // ── groups / friends / status — static defaults (no DB columns yet) ──
        groups: {
            groupInvitations:   'friends',
            groupPrivacy:       'public',
            groupAnnouncements: true,
            groupSpamDetection: true,
            memberWarnings:     true,
            messageApproval:    false,
            keywordFiltering:   false,
            groupMediaDownload: false
        },
        friends: {
            friendSuggestions:  true,
            nearbyDiscovery:    false,
            friendCategories:   true,
            trustScore:         false
        },
        status: {
            visibility:        'everyone',
            autoDownloadMedia: true,
            moodAutoShare:     false
        }
    };
}

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

            // Get user
            const user = await safeDbQuery(
                () => User.findByPk(userId, {
                    attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'theme', 'language']
                }),
                { username: 'User', email: 'user@example.com' }
            );

            // Get or create settings
            let settings = null;
            if (Settings) {
                const [foundSettings] = await Settings.findOrCreate({
                    where: { userId: userId },
                    defaults: {
                        userId:               userId,
                        theme:                'light',
                        language:             'en',
                        notificationsEnabled: true,
                        emailNotifications:   true,
                        pushNotifications:    true,
                        soundEnabled:         true,
                        vibrationEnabled:     true,
                        accentColor:          '#4F46E5',
                        fontSize:             'medium',
                        timezone:             'UTC',
                        dataSaver:            false,
                        autoDownload:         false,
                        privacy: {
                            profileVisibility: 'public',
                            readReceipts:      true,
                            typingIndicators:  true,
                            onlineStatus:      true,
                            lastSeen:          true,
                            whoCanAddMe:       'everyone',
                            statusVisibility:  'everyone'
                        },
                        chatPreferences: {
                            enterToSend:   true,
                            mediaQuality:  'auto',
                            saveToGallery: false,
                            messageBackup: true
                        }
                    }
                });
                settings = foundSettings;
            }

            // Return in AppSettings-schema format so frontend state merges cleanly
            const settingsPayload = _buildSettingsResponse(user, settings);

            res.status(200).json({
                success: true,
                status:  'success',
                data:    { settings: settingsPayload }
            });
        } catch (error) {
            console.error('[Settings] GET / error:', error);
            res.status(200).json({
                success: true,
                status:  'success',
                data:    { settings: _buildSettingsResponse(null, null) }
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

            // Sync theme/language into Settings table too
            const settingsSync = {};
            if (updateData.theme)    settingsSync.theme    = updateData.theme;
            if (updateData.language) settingsSync.language = updateData.language;
            if (Object.keys(settingsSync).length > 0 && Settings) {
                await Settings.update(settingsSync, { where: { userId } }).catch(() => {});
            }

            const updatedUser = await User.findByPk(userId, {
                attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'theme', 'language']
            });

            // Emit socket update so other tabs/devices react instantly
            _emitSettingsUpdated(req, { appearance: { theme: updatedUser?.theme, language: updatedUser?.language } });

            res.status(200).json({
                success: true,
                status: 'success',
                message: 'Profile updated successfully',
                data: { profile: updatedUser }
            });
        } catch (error) {
            console.error('[Settings] PUT /profile error:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update profile'
            });
        }
    })
);

// Update notification settings — handles ALL notification keys the frontend sends
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
            
            const body = req.body || {};
            const updateData = {};

            // Map from AppSettings notification keys → Settings table columns
            const notifMap = {
                emailNotifications:       'emailNotifications',
                pushNotifications:        'pushNotifications',
                notificationSound:        'soundEnabled',
                soundEnabled:             'soundEnabled',
                notificationVibration:    'vibrationEnabled',
                vibrationEnabled:         'vibrationEnabled',
                messageNotifications:     'notificationsEnabled',
                notificationsEnabled:     'notificationsEnabled',
            };

            Object.entries(notifMap).forEach(([bodyKey, dbKey]) => {
                if (body[bodyKey] !== undefined) updateData[dbKey] = body[bodyKey];
            });

            // Also accept the raw key name if it's a direct Settings column
            ['emailNotifications','pushNotifications','soundEnabled','vibrationEnabled','notificationsEnabled'].forEach(k => {
                if (body[k] !== undefined) updateData[k] = body[k];
            });

            if (Object.keys(updateData).length > 0 && Settings) {
                await Settings.update(updateData, { where: { userId } });
            }

            // Emit socket update for cross-device/tab propagation
            _emitSettingsUpdated(req, { notifications: body });

            res.status(200).json({
                success: true,
                status:  'success',
                message: 'Notification settings updated',
                data:    { notifications: updateData }
            });
        } catch (error) {
            console.error('[Settings] PUT /notifications error:', error);
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

            if (!theme || !['light', 'dark', 'system', 'auto'].includes(theme)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid theme selection'
                });
            }

            await User.update({ theme }, { where: { id: userId } });

            if (Settings) {
                await Settings.update({ theme }, { where: { userId } });
            }

            _emitSettingsUpdated(req, { appearance: { theme } });

            res.status(200).json({
                success: true,
                status: 'success',
                message: 'Theme updated successfully',
                data: { theme }
            });
        } catch (error) {
            console.error('[Settings] PUT /theme error:', error);
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
                await Settings.update({ language }, { where: { userId } });
            }

            _emitSettingsUpdated(req, { appearance: { language } });

            res.status(200).json({
                success: true,
                status: 'success',
                message: 'Language updated successfully',
                data: { language }
            });
        } catch (error) {
            console.error('[Settings] PUT /language error:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update language'
            });
        }
    })
);

// ── PUT /privacy — persist privacy settings and broadcast globally ────────────
router.put(
    '/privacy',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ status: 'error', message: 'Authentication required' });
            }

            const privacyUpdate = req.body || {};
            // Merge into existing JSONB privacy column
            if (Settings) {
                const existing = await Settings.findOne({ where: { userId } });
                if (existing) {
                    const merged = Object.assign({}, existing.privacy || {}, privacyUpdate);
                    await existing.update({ privacy: merged });
                } else {
                    await Settings.create({ userId, privacy: privacyUpdate });
                }
            }

            _emitSettingsUpdated(req, { privacy: privacyUpdate });

            res.status(200).json({
                success: true,
                status:  'success',
                message: 'Privacy settings updated',
                data:    { privacy: privacyUpdate }
            });
        } catch (error) {
            console.error('[Settings] PUT /privacy error:', error);
            res.status(500).json({ status: 'error', message: 'Failed to update privacy settings' });
        }
    })
);

// ── PUT / — bulk settings update (accepts AppSettings-shaped payload) ─────────
router.put(
    '/',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) {
                return res.status(401).json({ status: 'error', message: 'Authentication required' });
            }

            const body = req.body || {};
            const dbUpdate = {};

            // Map AppSettings sections → flat DB columns
            const app = body.appearance || {};
            if (app.theme)       dbUpdate.theme       = app.theme;
            if (app.language)    dbUpdate.language    = app.language;
            if (app.accentColor) dbUpdate.accentColor = app.accentColor;
            if (app.fontSize)    dbUpdate.fontSize    = String(app.fontSize);

            const notif = body.notifications || {};
            if (notif.messageNotifications  !== undefined) dbUpdate.notificationsEnabled = notif.messageNotifications;
            if (notif.emailNotifications    !== undefined) dbUpdate.emailNotifications   = notif.emailNotifications;
            if (notif.pushNotifications     !== undefined) dbUpdate.pushNotifications    = notif.pushNotifications;
            if (notif.notificationSound     !== undefined) dbUpdate.soundEnabled         = notif.notificationSound;
            if (notif.notificationVibration !== undefined) dbUpdate.vibrationEnabled     = notif.notificationVibration;

            const adv = body.advanced || {};
            if (adv.dataSaver !== undefined) dbUpdate.dataSaver = adv.dataSaver;

            const chat = body.chat || {};
            if (chat.autoDownloadMedia !== undefined) dbUpdate.autoDownload = chat.autoDownloadMedia;

            // Persist to Settings table
            if (Settings && Object.keys(dbUpdate).length > 0) {
                const [count] = await Settings.update(dbUpdate, { where: { userId } });
                if (count === 0) {
                    await Settings.create({ userId, ...dbUpdate });
                }
            }

            // Sync theme/language to User table too
            const userSync = {};
            if (dbUpdate.theme)    userSync.theme    = dbUpdate.theme;
            if (dbUpdate.language) userSync.language = dbUpdate.language;
            if (Object.keys(userSync).length > 0) {
                await User.update(userSync, { where: { id: userId } }).catch(() => {});
            }

            // Persist privacy section separately (JSONB merge)
            if (body.privacy && Settings) {
                const existing = await Settings.findOne({ where: { userId } });
                if (existing) {
                    const merged = Object.assign({}, existing.privacy || {}, body.privacy);
                    await existing.update({ privacy: merged });
                }
            }

            // Persist chat preferences
            if (body.chat && Settings) {
                const existing = await Settings.findOne({ where: { userId } });
                if (existing) {
                    const chatPref = Object.assign({}, existing.chatPreferences || {}, {
                        enterToSend:   body.chat.enterKeySends  !== undefined ? body.chat.enterKeySends  : undefined,
                        mediaQuality:  body.chat.videoQuality   !== undefined ? body.chat.videoQuality   : undefined,
                        saveToGallery: body.chat.saveMedia      !== undefined ? body.chat.saveMedia      : undefined,
                    });
                    // Remove undefined keys
                    Object.keys(chatPref).forEach(k => chatPref[k] === undefined && delete chatPref[k]);
                    await existing.update({ chatPreferences: chatPref });
                }
            }

            // Broadcast to all devices/tabs via socket
            _emitSettingsUpdated(req, body);

            res.status(200).json({
                success: true,
                status:  'success',
                message: 'Settings updated successfully',
                data:    { settings: body }
            });
        } catch (error) {
            console.error('[Settings] PUT / error:', error);
            res.status(500).json({ status: 'error', message: 'Failed to update settings' });
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