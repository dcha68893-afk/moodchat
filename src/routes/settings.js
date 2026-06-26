const path = require('path');
const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
// ── CRITICAL: Inject global.__socketIO into req.io so all handlers can emit ──
router.use((req, _, next) => { if (!req.io) req.io = global.__socketIO || null; next(); });
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

// ─── Canonical global settings snapshot helpers ──────────────────────────────
const DEFAULT_SETTINGS = {
    appearance: {
        theme: 'light',
        accentColor: '#4F46E5',
        fontSize: 16,
        reduceMotion: false,
        language: 'en',
        timeFormat: '12h',
        dateFormat: 'mm/dd/yyyy'
    },
    notifications: {
        enabled: true,
        messageNotifications: true,
        emailNotifications: true,
        pushNotifications: true,
        groupNotifications: true,
        callNotifications: true,
        statusNotifications: true,
        friendRequestNotifications: true,
        notificationSound: true,
        notificationVibration: true,
        popupNotifications: true,
        doNotDisturb: false
    },
    privacy: {
        profileVisibility: 'everyone',
        photoVisibility: 'everyone',
        onlineStatus: true,
        lastSeen: 'everyone',
        readReceipts: true,
        typingIndicators: true,
        whoCanAddMe: 'everyone',
        contactDiscovery: true,
        statusVisibility: 'everyone'
    },
    chat: {
        wallpaper: 'default',
        enterKeySends: false,
        mediaDownload: 'wifi',
        autoDownloadMedia: true,
        saveMedia: false,
        disappearingMessages: 'off',
        fontSize: 'medium',
        bubbleStyle: 'default'
    },
    account: {
        displayName: 'User',
        username: 'user',
        email: '',
        avatar: null,
        firstName: null,
        lastName: null,
        bio: null,
        loginAlerts: true,
        securityAlerts: true,
        autoBackup: false,
        backupFrequency: 'weekly',
        deleteAccountAfter: 'never'
    },
    advanced: {
        dataSaver: false,
        syncEnabled: true,
        offlineMode: true,
        debugMode: false,
        lowBandwidth: false
    },
    calls: {
        whoCanCallMe: 'friends',
        ringtone: 'default',
        callVibration: true,
        autoAnswer: false,
        autoReject: false,
        speakerDefault: false,
        videoQuality: 'auto',
        microphoneDefault: 'default',
        noiseCancellation: true,
        echoCancellation: true,
        liveReactions: true,
        inCallChat: true
    },
    groups: {
        groupInvitations: 'friends',
        groupPrivacy: 'public',
        groupAnnouncements: true,
        groupSpamDetection: true,
        memberWarnings: true,
        messageApproval: false,
        keywordFiltering: false,
        groupMediaDownload: true
    },
    friends: {
        friendSuggestions: true,
        nearbyDiscovery: false,
        friendCategories: true,
        trustScore: false
    },
    status: {
        visibility: 'everyone',
        autoDownloadMedia: true,
        moodAutoShare: false
    }
};

function _isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function _mergeDeep(target, source) {
    const base = _isObject(target) ? _clone(target) : {};
    if (!_isObject(source)) return base;

    Object.keys(source).forEach((key) => {
        const incoming = source[key];
        if (_isObject(incoming) && _isObject(base[key])) {
            base[key] = _mergeDeep(base[key], incoming);
        } else if (incoming !== undefined) {
            base[key] = _clone(incoming);
        }
    });

    return base;
}

function _normalizeFontSize(value) {
    if (value === 'small' || value === 'medium' || value === 'large') return value;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'medium';
    if (numeric <= 14) return 'small';
    if (numeric >= 18) return 'large';
    return 'medium';
}

function _normalizeVisibility(value, fallback = 'everyone') {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).toLowerCase();
    if (normalized === 'public' || normalized === 'all') return 'everyone';
    if (normalized === 'friends' || normalized === 'contacts') return 'contacts';
    if (normalized === 'nobody' || normalized === 'none') return 'nobody';
    if (normalized === 'everyone') return 'everyone';
    return fallback;
}

function _normalizeLastSeen(value) {
    if (value === true) return 'everyone';
    if (value === false) return 'nobody';
    return _normalizeVisibility(value, 'everyone');
}

function _ensureTheme(value) {
    if (value === 'system') return 'auto';
    return ['light', 'dark', 'auto'].includes(value) ? value : 'light';
}

function _normalizeLanguage(value) {
    const allowed = ['en', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'ru'];
    return allowed.includes(value) ? value : 'en';
}

function _buildSettingsResponse(user, settingsRow) {
    const userData = user && user.toJSON ? user.toJSON() : (user || {});
    const row = settingsRow && settingsRow.toJSON ? settingsRow.toJSON() : (settingsRow || {});
    const userSettings = _isObject(userData.settings) ? userData.settings : {};
    const priv = _mergeDeep({}, row.privacy || {});
    const chatPrefs = _mergeDeep({}, row.chatPreferences || {});
    const snapshot = _mergeDeep(DEFAULT_SETTINGS, userSettings);

    const theme = _ensureTheme(row.theme || userData.theme || snapshot.appearance.theme);
    const language = _normalizeLanguage(row.language || userData.language || snapshot.appearance.language);
    const fontSize = _normalizeFontSize(
        (snapshot.chat && snapshot.chat.fontSize)
        || row.fontSize
        || (snapshot.appearance && snapshot.appearance.fontSize)
    );
    const profileVisibility = _normalizeVisibility(
        snapshot.privacy && (snapshot.privacy.profileVisibility || snapshot.privacy.photoVisibility),
        _normalizeVisibility(priv.profileVisibility, 'everyone')
    );
    const statusVisibility = _normalizeVisibility(
        snapshot.privacy && snapshot.privacy.statusVisibility,
        _normalizeVisibility(priv.statusVisibility, 'everyone')
    );
    const lastSeen = _normalizeLastSeen(
        snapshot.privacy && snapshot.privacy.lastSeen !== undefined ? snapshot.privacy.lastSeen : priv.lastSeen
    );
    const notificationsEnabled = (row.notificationsEnabled !== false) && snapshot.notifications.enabled !== false;
    const soundEnabled = (row.soundEnabled !== false) && snapshot.notifications.notificationSound !== false && notificationsEnabled;
    const vibrationEnabled = (row.vibrationEnabled !== false) && snapshot.notifications.notificationVibration !== false;
    const autoDownloadMedia = (row.autoDownload !== false) && snapshot.chat.autoDownloadMedia !== false;

    return _mergeDeep(snapshot, {
        appearance: {
            theme,
            language,
            accentColor: row.accentColor || snapshot.appearance.accentColor || '#4F46E5',
            fontSize: fontSize === 'small' ? 14 : fontSize === 'large' ? 18 : 16
        },
        notifications: {
            enabled: notificationsEnabled,
            messageNotifications: notificationsEnabled && snapshot.notifications.messageNotifications !== false,
            emailNotifications: row.emailNotifications !== false && snapshot.notifications.emailNotifications !== false,
            pushNotifications: row.pushNotifications !== false && snapshot.notifications.pushNotifications !== false,
            groupNotifications: notificationsEnabled && snapshot.notifications.groupNotifications !== false,
            callNotifications: notificationsEnabled && snapshot.notifications.callNotifications !== false,
            statusNotifications: notificationsEnabled && snapshot.notifications.statusNotifications !== false,
            friendRequestNotifications: notificationsEnabled && snapshot.notifications.friendRequestNotifications !== false,
            notificationSound: soundEnabled,
            notificationVibration: vibrationEnabled,
            popupNotifications: notificationsEnabled && snapshot.notifications.popupNotifications !== false,
            doNotDisturb: snapshot.notifications.doNotDisturb === true
        },
        privacy: {
            profileVisibility,
            photoVisibility: profileVisibility,
            onlineStatus: priv.onlineStatus !== false && snapshot.privacy.onlineStatus !== false,
            lastSeen,
            readReceipts: priv.readReceipts !== false && snapshot.privacy.readReceipts !== false,
            typingIndicators: priv.typingIndicators !== false && snapshot.privacy.typingIndicators !== false,
            whoCanAddMe: priv.whoCanAddMe || snapshot.privacy.whoCanAddMe || 'everyone',
            contactDiscovery: priv.contactDiscovery !== false && snapshot.privacy.contactDiscovery !== false,
            statusVisibility
        },
        chat: {
            wallpaper: chatPrefs.wallpaper || snapshot.chat.wallpaper || 'default',
            enterKeySends: chatPrefs.enterToSend === true || snapshot.chat.enterKeySends === true,
            mediaDownload: autoDownloadMedia ? (snapshot.chat.mediaDownload || 'wifi') : 'never',
            autoDownloadMedia,
            saveMedia: chatPrefs.saveToGallery === true || snapshot.chat.saveMedia === true,
            disappearingMessages: snapshot.chat.disappearingMessages || 'off',
            fontSize,
            bubbleStyle: chatPrefs.bubbleStyle || snapshot.chat.bubbleStyle || 'default'
        },
        account: {
            id: userData.id,
            displayName: userData.username || snapshot.account.displayName || 'User',
            username: userData.username || snapshot.account.username || 'user',
            email: userData.email || snapshot.account.email || '',
            avatar: userData.avatar || snapshot.account.avatar || null,
            firstName: userData.firstName || snapshot.account.firstName || null,
            lastName: userData.lastName || snapshot.account.lastName || null,
            bio: userData.bio || snapshot.account.bio || null,
            loginAlerts: snapshot.account.loginAlerts !== false,
            securityAlerts: snapshot.account.securityAlerts !== false,
            autoBackup: snapshot.account.autoBackup === true,
            backupFrequency: snapshot.account.backupFrequency || 'weekly',
            deleteAccountAfter: snapshot.account.deleteAccountAfter || 'never'
        },
        advanced: {
            dataSaver: row.dataSaver === true || snapshot.advanced.dataSaver === true,
            syncEnabled: snapshot.advanced.syncEnabled !== false,
            offlineMode: snapshot.advanced.offlineMode !== false,
            debugMode: snapshot.advanced.debugMode === true,
            lowBandwidth: snapshot.advanced.lowBandwidth === true
        },
        calls: {
            whoCanCallMe: snapshot.calls.whoCanCallMe || 'friends',
            ringtone: chatPrefs.ringtone || snapshot.calls.ringtone || 'default',
            callVibration: chatPrefs.callVibration !== false && snapshot.calls.callVibration !== false,
            autoAnswer: snapshot.calls.autoAnswer === true,
            autoReject: snapshot.calls.autoReject === true,
            speakerDefault: snapshot.calls.speakerDefault === true,
            videoQuality: chatPrefs.mediaQuality || snapshot.calls.videoQuality || 'auto',
            microphoneDefault: snapshot.calls.microphoneDefault || 'default',
            noiseCancellation: snapshot.calls.noiseCancellation !== false,
            echoCancellation: snapshot.calls.echoCancellation !== false,
            liveReactions: snapshot.calls.liveReactions !== false,
            inCallChat: snapshot.calls.inCallChat !== false
        },
        status: {
            visibility: statusVisibility,
            autoDownloadMedia,
            moodAutoShare: snapshot.status.moodAutoShare === true
        },
        theme,
        language,
        notification_enabled: notificationsEnabled,
        ringtone_enabled: soundEnabled,
        dark_mode: theme === 'dark',
        privacy_last_seen: lastSeen,
        privacy_profile_photo: profileVisibility,
        privacy_status: statusVisibility,
        read_receipts: priv.readReceipts !== false && snapshot.privacy.readReceipts !== false,
        auto_download_media: autoDownloadMedia,
        font_size: fontSize,
        wallpaper: chatPrefs.wallpaper || snapshot.chat.wallpaper || 'default'
    });
}

async function _getUserAndSettings(userId) {
    const user = await safeDbQuery(
        () => User.findByPk(userId, {
            attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'theme', 'language', 'settings']
        }),
        null
    );

    let settingsRow = null;
    if (Settings) {
        const defaults = {
            userId,
            theme: 'light',
            language: 'en',
            notificationsEnabled: true,
            emailNotifications: true,
            pushNotifications: true,
            soundEnabled: true,
            vibrationEnabled: true,
            accentColor: '#4F46E5',
            fontSize: 'medium',
            timezone: 'UTC',
            dataSaver: false,
            autoDownload: true,
            privacy: {
                profileVisibility: 'everyone',
                readReceipts: true,
                typingIndicators: true,
                onlineStatus: true,
                lastSeen: 'everyone',
                whoCanAddMe: 'everyone',
                statusVisibility: 'everyone',
                contactDiscovery: true
            },
            chatPreferences: {
                enterToSend: false,
                mediaQuality: 'auto',
                saveToGallery: false,
                messageBackup: true,
                wallpaper: 'default',
                bubbleStyle: 'default',
                ringtone: 'default',
                callVibration: true
            }
        };
        const [row] = await Settings.findOrCreate({ where: { userId }, defaults });
        settingsRow = row;
    }

    return { user, settingsRow };
}

function _preparePartialSettingsUpdate(body) {
    const source = _isObject(body) ? body : {};
    const partial = _mergeDeep({}, source);

    if (source.theme || source.language || source.dark_mode !== undefined || source.font_size || source.accentColor || source.accent_color) {
        partial.appearance = _mergeDeep(partial.appearance || {}, {});
        if (source.theme) partial.appearance.theme = source.theme;
        if (source.dark_mode === true) partial.appearance.theme = 'dark';
        if (source.dark_mode === false && !source.theme) partial.appearance.theme = 'light';
        if (source.language) partial.appearance.language = source.language;
        if (source.accentColor) partial.appearance.accentColor = source.accentColor;
        if (source.accent_color) partial.appearance.accentColor = source.accent_color;
        if (source.font_size) partial.appearance.fontSize = source.font_size;
    }

    if (source.notification_enabled !== undefined || source.ringtone_enabled !== undefined || source.notificationsEnabled !== undefined) {
        partial.notifications = _mergeDeep(partial.notifications || {}, {});
        if (source.notification_enabled !== undefined) partial.notifications.enabled = source.notification_enabled !== false;
        if (source.notificationsEnabled !== undefined) partial.notifications.enabled = source.notificationsEnabled !== false;
        if (source.ringtone_enabled !== undefined) partial.notifications.notificationSound = source.ringtone_enabled !== false;
    }

    if (source.privacy_last_seen || source.privacy_profile_photo || source.privacy_status || source.read_receipts !== undefined) {
        partial.privacy = _mergeDeep(partial.privacy || {}, {});
        if (source.privacy_last_seen) partial.privacy.lastSeen = source.privacy_last_seen;
        if (source.privacy_profile_photo) {
            partial.privacy.profileVisibility = source.privacy_profile_photo;
            partial.privacy.photoVisibility = source.privacy_profile_photo;
        }
        if (source.privacy_status) partial.privacy.statusVisibility = source.privacy_status;
        if (source.read_receipts !== undefined) partial.privacy.readReceipts = source.read_receipts !== false;
    }

    if (source.auto_download_media !== undefined || source.wallpaper || source.font_size || source.chat_settings) {
        partial.chat = _mergeDeep(partial.chat || {}, source.chat_settings || {});
        if (source.auto_download_media !== undefined) partial.chat.autoDownloadMedia = source.auto_download_media !== false;
        if (source.wallpaper) partial.chat.wallpaper = source.wallpaper;
        if (source.font_size) partial.chat.fontSize = source.font_size;
    }

    if (source.call_settings) {
        partial.calls = _mergeDeep(partial.calls || {}, source.call_settings);
    }

    if (source.fontSize !== undefined) {
        partial.chat = _mergeDeep(partial.chat || {}, { fontSize: source.fontSize });
    }

    return partial;
}

async function _persistSettingsSnapshot(userId, partialPayload) {
    const prepared = _preparePartialSettingsUpdate(partialPayload);
    const { user, settingsRow } = await _getUserAndSettings(userId);
    const userData = user && user.toJSON ? user.toJSON() : (user || {});
    const rowData = settingsRow && settingsRow.toJSON ? settingsRow.toJSON() : (settingsRow || {});
    const current = _buildSettingsResponse(user, settingsRow);
    const snapshot = _mergeDeep(current, prepared || {});

    const normalized = _buildSettingsResponse(
        {
            ...userData,
            settings: snapshot,
            theme: snapshot.appearance && snapshot.appearance.theme,
            language: snapshot.appearance && snapshot.appearance.language
        },
        {
            ...rowData,
            theme: snapshot.appearance && snapshot.appearance.theme,
            language: snapshot.appearance && snapshot.appearance.language,
            accentColor: snapshot.appearance && snapshot.appearance.accentColor,
            fontSize: _normalizeFontSize(snapshot.chat && snapshot.chat.fontSize),
            notificationsEnabled: snapshot.notifications && snapshot.notifications.enabled !== false && snapshot.notifications.messageNotifications !== false,
            emailNotifications: snapshot.notifications && snapshot.notifications.emailNotifications !== false,
            pushNotifications: snapshot.notifications && snapshot.notifications.pushNotifications !== false,
            soundEnabled: snapshot.notifications && snapshot.notifications.notificationSound !== false,
            vibrationEnabled: snapshot.notifications && snapshot.notifications.notificationVibration !== false,
            dataSaver: snapshot.advanced && snapshot.advanced.dataSaver === true,
            autoDownload: snapshot.chat && snapshot.chat.autoDownloadMedia !== false,
            privacy: {
                profileVisibility: snapshot.privacy && (snapshot.privacy.profileVisibility || snapshot.privacy.photoVisibility),
                readReceipts: snapshot.privacy && snapshot.privacy.readReceipts !== false,
                typingIndicators: snapshot.privacy && snapshot.privacy.typingIndicators !== false,
                onlineStatus: snapshot.privacy && snapshot.privacy.onlineStatus !== false,
                lastSeen: snapshot.privacy && snapshot.privacy.lastSeen,
                whoCanAddMe: snapshot.privacy && snapshot.privacy.whoCanAddMe,
                statusVisibility: snapshot.privacy && snapshot.privacy.statusVisibility,
                contactDiscovery: snapshot.privacy && snapshot.privacy.contactDiscovery !== false
            },
            chatPreferences: {
                enterToSend: snapshot.chat && snapshot.chat.enterKeySends === true,
                mediaQuality: (snapshot.calls && snapshot.calls.videoQuality) || 'auto',
                saveToGallery: snapshot.chat && snapshot.chat.saveMedia === true,
                messageBackup: true,
                wallpaper: snapshot.chat && snapshot.chat.wallpaper,
                bubbleStyle: snapshot.chat && snapshot.chat.bubbleStyle,
                ringtone: snapshot.calls && snapshot.calls.ringtone,
                callVibration: snapshot.calls && snapshot.calls.callVibration !== false
            }
        }
    );

    if (user) {
        await user.update({
            theme: normalized.appearance.theme,
            language: normalized.appearance.language,
            settings: normalized
        });
    }

    if (settingsRow) {
        await settingsRow.update({
            theme: normalized.appearance.theme,
            language: normalized.appearance.language,
            accentColor: normalized.appearance.accentColor,
            fontSize: _normalizeFontSize(normalized.chat.fontSize),
            notificationsEnabled: normalized.notifications.enabled !== false && normalized.notifications.messageNotifications !== false,
            emailNotifications: normalized.notifications.emailNotifications !== false,
            pushNotifications: normalized.notifications.pushNotifications !== false,
            soundEnabled: normalized.notifications.notificationSound !== false,
            vibrationEnabled: normalized.notifications.notificationVibration !== false,
            dataSaver: normalized.advanced.dataSaver === true,
            autoDownload: normalized.chat.autoDownloadMedia !== false,
            privacy: {
                profileVisibility: normalized.privacy.profileVisibility,
                readReceipts: normalized.privacy.readReceipts !== false,
                typingIndicators: normalized.privacy.typingIndicators !== false,
                onlineStatus: normalized.privacy.onlineStatus !== false,
                lastSeen: normalized.privacy.lastSeen,
                whoCanAddMe: normalized.privacy.whoCanAddMe,
                statusVisibility: normalized.privacy.statusVisibility,
                contactDiscovery: normalized.privacy.contactDiscovery !== false
            },
            chatPreferences: {
                enterToSend: normalized.chat.enterKeySends === true,
                mediaQuality: normalized.calls.videoQuality || 'auto',
                saveToGallery: normalized.chat.saveMedia === true,
                messageBackup: true,
                wallpaper: normalized.chat.wallpaper,
                bubbleStyle: normalized.chat.bubbleStyle,
                ringtone: normalized.calls.ringtone,
                callVibration: normalized.calls.callVibration !== false
            }
        });
    }

    return normalized;
}

const getSettingsHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const { user, settingsRow } = await _getUserAndSettings(userId);
    const settingsPayload = _buildSettingsResponse(user, settingsRow);

    console.log('[Settings] Loaded settings for user:', userId);
    return res.status(200).json({
        success: true,
        status: 'success',
        data: { settings: settingsPayload }
    });
});

const updateProfileHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const { displayName, username, bio, theme, language, firstName, lastName } = req.body || {};
    const updateData = {};

    if (displayName !== undefined) updateData.username = displayName;
    if (username !== undefined) updateData.username = username;
    if (bio !== undefined) updateData.bio = bio;
    if (theme !== undefined) updateData.theme = _ensureTheme(theme);
    if (language !== undefined) updateData.language = _normalizeLanguage(language);
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;

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
        attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'theme', 'language', 'settings']
    });

    const settingsPayload = await _persistSettingsSnapshot(userId, {
        appearance: {
            theme: updatedUser && updatedUser.theme,
            language: updatedUser && updatedUser.language
        },
        account: {
            displayName: updatedUser && updatedUser.username,
            username: updatedUser && updatedUser.username,
            email: updatedUser && updatedUser.email,
            avatar: updatedUser && updatedUser.avatar,
            firstName: updatedUser && updatedUser.firstName,
            lastName: updatedUser && updatedUser.lastName,
            bio: updatedUser && updatedUser.bio
        }
    });

    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Saved profile settings for user:', userId);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Profile updated successfully',
        data: { profile: updatedUser, settings: settingsPayload }
    });
});

const updateNotificationsHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const payload = _isObject(req.body && req.body.notifications) ? req.body.notifications : (req.body || {});
    const settingsPayload = await _persistSettingsSnapshot(userId, { notifications: payload });

    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Saved notification settings for user:', userId);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Notification settings updated',
        data: { settings: settingsPayload, notifications: settingsPayload.notifications }
    });
});

const updateThemeHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const theme = _ensureTheme(req.body && req.body.theme);
    if (!theme) {
        return res.status(400).json({ status: 'error', message: 'Invalid theme selection' });
    }

    const settingsPayload = await _persistSettingsSnapshot(userId, { appearance: { theme } });
    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Saved theme for user:', userId, theme);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Theme updated successfully',
        data: { theme, settings: settingsPayload }
    });
});

const updateLanguageHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const language = _normalizeLanguage(req.body && req.body.language);
    const settingsPayload = await _persistSettingsSnapshot(userId, { appearance: { language } });
    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Saved language for user:', userId, language);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Language updated successfully',
        data: { language, settings: settingsPayload }
    });
});

const updatePrivacyHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const payload = _isObject(req.body && req.body.privacy) ? req.body.privacy : (req.body || {});
    const settingsPayload = await _persistSettingsSnapshot(userId, { privacy: payload });

    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Saved privacy settings for user:', userId);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Privacy settings updated',
        data: { settings: settingsPayload, privacy: settingsPayload.privacy }
    });
});

const updateAllSettingsHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const settingsPayload = await _persistSettingsSnapshot(userId, req.body || {});
    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Saved full settings snapshot for user:', userId);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Settings updated successfully',
        data: { settings: settingsPayload }
    });
});

const resetSettingsHandler = asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }

    const settingsPayload = await _persistSettingsSnapshot(userId, _clone(DEFAULT_SETTINGS));
    _emitSettingsUpdated(req, settingsPayload);
    console.log('[Settings] Reset settings for user:', userId);

    return res.status(200).json({
        success: true,
        status: 'success',
        message: 'Settings reset successfully',
        data: { settings: settingsPayload }
    });
});

router.get('/', apiRateLimiter, getSettingsHandler);
router.put('/profile', apiRateLimiter, upload.single('avatar'), updateProfileHandler);
router.patch('/profile', apiRateLimiter, upload.single('avatar'), updateProfileHandler);
router.put('/notifications', apiRateLimiter, updateNotificationsHandler);
router.patch('/notifications', apiRateLimiter, updateNotificationsHandler);
router.put('/theme', apiRateLimiter, updateThemeHandler);
router.patch('/theme', apiRateLimiter, updateThemeHandler);
router.put('/language', apiRateLimiter, updateLanguageHandler);
router.patch('/language', apiRateLimiter, updateLanguageHandler);
router.put('/privacy', apiRateLimiter, updatePrivacyHandler);
router.patch('/privacy', apiRateLimiter, updatePrivacyHandler);
router.put('/', apiRateLimiter, updateAllSettingsHandler);
router.patch('/', apiRateLimiter, updateAllSettingsHandler);
router.post('/reset', apiRateLimiter, resetSettingsHandler);
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

// Block a user
router.post(
    '/block-user',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });

            const { targetUserId } = req.body;
            if (!targetUserId) return res.status(400).json({ status: 'error', message: 'Target user ID is required' });
            if (String(userId) === String(targetUserId)) return res.status(400).json({ status: 'error', message: 'Cannot block yourself' });

            const Friend = models.Friend;
            if (Friend) {
                const existing = await Friend.findOne({
                    where: {
                        [Op.or]: [
                            { requesterId: userId, receiverId: targetUserId },
                            { requesterId: targetUserId, receiverId: userId }
                        ]
                    }
                });
                if (existing) {
                    await existing.update({ status: 'blocked', requesterId: userId, receiverId: targetUserId, blockedAt: new Date() });
                } else {
                    await Friend.create({ requesterId: userId, receiverId: targetUserId, status: 'blocked', blockedAt: new Date() });
                }
            }

            res.status(200).json({ status: 'success', message: 'User blocked successfully', data: { blockedUserId: targetUserId } });
        } catch (error) {
            console.error('Error blocking user:', error);
            res.status(500).json({ status: 'error', message: 'Failed to block user' });
        }
    })
);

// Unblock a user
router.post(
    '/unblock-user',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });

            const { targetUserId } = req.body;
            if (!targetUserId) return res.status(400).json({ status: 'error', message: 'Target user ID is required' });

            const Friend = models.Friend;
            if (Friend) {
                const relation = await Friend.findOne({
                    where: { requesterId: userId, receiverId: targetUserId, status: 'blocked' }
                });
                if (relation) await relation.destroy();
            }

            res.status(200).json({ status: 'success', message: 'User unblocked successfully', data: { unblockedUserId: targetUserId } });
        } catch (error) {
            console.error('Error unblocking user:', error);
            res.status(500).json({ status: 'error', message: 'Failed to unblock user' });
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

            // P1 AUDIT FIX: password is now MANDATORY
            if (!password) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Password is required to delete your account'
                });
            }

            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Incorrect password'
                });
            }

            // P1 AUDIT FIX: revoke ALL tokens — deleted user cannot re-authenticate
            const Token = models.Token;
            if (Token) {
                try {
                    await Token.update({ isRevoked: true }, { where: { userId } });
                } catch (te) {
                    console.warn('[DeleteAccount] Token revocation warning:', te.message);
                }
            }

            // Overwrite password hash — no future login possible even if token found
            const deadHash = await bcrypt.hash(
                `DELETED_${userId}_${Date.now()}_${Math.random()}`, 12
            );

            // Soft delete — anonymise all PII
            await user.update({
                email:     `deleted_${user.id}@deleted.invalid`,
                username:  `deleted_user_${user.id}`,
                firstName: null,
                lastName:  null,
                avatar:    null,
                bio:       null,
                password:  deadHash,
                isActive:  false,
                deletedAt: new Date()
            });

            if (Settings) {
                await Settings.destroy({ where: { userId } });
            }

            res.status(200).json({
                status: 'success',
                message: 'Account deleted successfully'
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


// ─── 2FA TOTP routes (P1 audit fix) ─────────────────────────────────────────

router.get('/2fa/status', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });
        const user = await User.findByPk(userId, { attributes: ['id', 'mfaEnabled'] });
        if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
        res.json({ status: 'success', data: { mfaEnabled: user.mfaEnabled === true } });
    } catch (e) { console.error('2FA status error:', e); res.status(500).json({ status: 'error', message: 'Failed' }); }
}));

router.post('/2fa/setup', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });
        const user = await User.findByPk(userId);
        if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
        if (user.mfaEnabled) return res.status(400).json({ status: 'error', message: '2FA is already enabled' });

        const { authenticator } = require('otplib');
        const QRCode = require('qrcode');
        const crypto = require('crypto');

        const secret = authenticator.generateSecret();
        const otpUrl = authenticator.keyuri(user.email || user.username, 'MoodChat', secret);
        const qrCode = await QRCode.toDataURL(otpUrl);
        const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());

        await user.update({
            mfaSecret: secret,
            mfaBackupCodes: backupCodes.map(code => ({ code, used: false }))
        });

        res.json({ status: 'success', data: { qrCode, secret, backupCodes } });
    } catch (e) { console.error('2FA setup error:', e); res.status(500).json({ status: 'error', message: 'Failed to set up 2FA' }); }
}));

router.post('/2fa/verify', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });
        const { token } = req.body;
        if (!token) return res.status(400).json({ status: 'error', message: 'TOTP token is required' });
        const user = await User.findByPk(userId);
        if (!user || !user.mfaSecret) return res.status(400).json({ status: 'error', message: 'Run /2fa/setup first' });

        const { authenticator } = require('otplib');
        if (!authenticator.verify({ token, secret: user.mfaSecret }))
            return res.status(400).json({ status: 'error', message: 'Invalid TOTP token — check your authenticator app' });

        await user.update({ mfaEnabled: true });
        res.json({ status: 'success', message: '2FA enabled on your account' });
    } catch (e) { console.error('2FA verify error:', e); res.status(500).json({ status: 'error', message: 'Failed to verify 2FA' }); }
}));

router.post('/2fa/disable', apiRateLimiter, asyncHandler(async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });
        const { password, token } = req.body;
        if (!password || !token) return res.status(400).json({ status: 'error', message: 'Password and TOTP token are required' });

        const user = await User.findByPk(userId);
        if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
        if (!user.mfaEnabled) return res.status(400).json({ status: 'error', message: '2FA is not enabled' });

        if (!await bcrypt.compare(password, user.password))
            return res.status(400).json({ status: 'error', message: 'Incorrect password' });

        const { authenticator } = require('otplib');
        if (!authenticator.verify({ token, secret: user.mfaSecret }))
            return res.status(400).json({ status: 'error', message: 'Invalid TOTP token' });

        await user.update({ mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });
        res.json({ status: 'success', message: '2FA disabled' });
    } catch (e) { console.error('2FA disable error:', e); res.status(500).json({ status: 'error', message: 'Failed to disable 2FA' }); }
}));

// ─── Message retention cron (P2 audit fix) ───────────────────────────────────
try {
    const schedule = require('node-schedule');
    const { Message } = require('../models');
    if (Message && schedule) {
        schedule.scheduleJob('0 3 * * 0', async () => {
            console.log('[MessageRetention] Running weekly sweep…');
            try {
                const retentionDays = { '1month': 30, '6months': 180, '1year': 365 };
                const allSettings = await Settings.findAll({ attributes: ['userId', 'chatPreferences'] });
                for (const s of allSettings) {
                    const hist = s.chatPreferences?.messageHistory;
                    if (!hist || hist === 'forever') continue;
                    const days = retentionDays[hist];
                    if (!days) continue;
                    const cutoff = new Date(Date.now() - days * 86400 * 1000);
                    await Message.update(
                        { isDeleted: true, deletedAt: new Date() },
                        { where: { senderId: s.userId, sentAt: { [Op.lt]: cutoff }, isDeleted: false } }
                    );
                }
                console.log('[MessageRetention] Sweep complete');
            } catch (e) { console.error('[MessageRetention] Error:', e.message); }
        });
        console.log('[Settings] ✅ Message retention cron scheduled (Sun 03:00)');
    }
} catch (e) { console.warn('[Settings] Message retention cron unavailable:', e.message); }

// ─── 2FA alias routes (frontend hits /api/settings/2fa/* but canonical is /api/2fa/*) ──
try {
    const twoFactorRouter = require('./twoFactor');
    router.use('/2fa', twoFactorRouter);
    console.log('[Settings] ✅ 2FA alias routes mounted at /api/settings/2fa/*');
} catch (e) {
    console.warn('[Settings] 2FA alias mount failed:', e.message);
}

module.exports = router;

