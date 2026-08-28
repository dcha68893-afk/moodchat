// src/services/pushService.js
// P1 FIX: FCM push notifications for group messages
// Uses firebase-admin if FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID is set
// Falls back to graceful no-op if Firebase is not configured
'use strict';

let _admin   = null;
let _app     = null;
let _ready   = false;
let _initErr = null;

function _initFirebase() {
  if (_ready || _initErr) return;
  try {
    _admin = require('firebase-admin');
  } catch (_) {
    _initErr = 'firebase-admin not installed — run: npm install firebase-admin';
    return;
  }

  try {
    let credential;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // JSON string in env var
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = _admin.credential.cert(sa);
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      credential = _admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      });
    } else {
      _initErr = 'Firebase not configured — set FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY';
      return;
    }

    // Avoid duplicate app init
    if (_admin.apps.length === 0) {
      _app = _admin.initializeApp({ credential });
    } else {
      _app = _admin.apps[0];
    }
    _ready = true;
    console.log('[PushService] ✅ Firebase Admin initialized');
  } catch (e) {
    _initErr = 'Firebase init error: ' + e.message;
    console.warn('[PushService] ⚠️', _initErr);
  }
}

// Initialize on load
_initFirebase();

/**
 * Send a push notification to a single FCM token.
 * @returns {string|null} message ID or null on failure
 */
async function sendToToken(token, notification, data = {}) {
  if (!_ready || !_app) return null;
  if (!token) return null;
  try {
    const msg = {
      token,
      notification: {
        title: String(notification.title || 'Nexopa').slice(0, 50),
        body:  String(notification.body  || '').slice(0, 200),
        ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
      },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: data.channelId || 'group_messages',
          sound: 'default',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    };
    const messageId = await _admin.messaging().send(msg);
    return messageId;
  } catch (e) {
    // Token invalid — caller can clean it up
    if (['registration-token-not-registered', 'invalid-registration-token'].includes(e.code)) {
      return 'INVALID_TOKEN';
    }
    console.error('[PushService] sendToToken error:', e.message);
    return null;
  }
}

/**
 * Send to multiple tokens (up to 500 per call — FCM batch limit).
 * Returns { successCount, failureCount, invalidTokens }
 */
async function sendToMultipleTokens(tokens, notification, data = {}) {
  if (!_ready || !_app || !tokens?.length) return { successCount: 0, failureCount: 0, invalidTokens: [] };

  const invalidTokens = [];
  let successCount = 0;
  let failureCount = 0;

  // Batch into 500s (FCM limit)
  const BATCH = 500;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    try {
      const msg = {
        notification: {
          title: String(notification.title || 'Nexopa').slice(0, 50),
          body:  String(notification.body  || '').slice(0, 200),
        },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: 'high', notification: { channelId: data.channelId || 'group_messages', sound: 'default' } },
        apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
        tokens: batch,
      };
      const response = await _admin.messaging().sendEachForMulticast(msg);
      successCount += response.successCount;
      failureCount += response.failureCount;
      response.responses.forEach((r, idx) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          invalidTokens.push(batch[idx]);
        }
      });
    } catch (e) {
      console.error('[PushService] sendToMultipleTokens batch error:', e.message);
      failureCount += batch.length;
    }
  }
  return { successCount, failureCount, invalidTokens };
}

/**
 * Send a group message push notification to all non-muted, non-sender members.
 * Automatically cleans up invalid FCM tokens.
 *
 * @param {number}   groupId
 * @param {object}   message  { content, senderId, senderName, type }
 * @param {string}   groupName
 */
async function pushGroupMessage(groupId, message, groupName = 'Group') {
  if (!_ready || !_app) return;

  try {
    const db = require('../models');
    const GM   = db.models?.GroupMembers || db.GroupMembers;
    const User = db.models?.Users || db.Users;
    if (!GM || !User) return;

    const { Op } = require('sequelize');
    const now = new Date();

    // Get all members with push tokens who are not muted, not the sender, and not banned
    const members = await GM.findAll({
      where: {
        groupId,
        leftAt:   null,
        isBanned: false,
        userId:   { [Op.ne]: message.senderId },
        [Op.or]: [
          { mutedUntil: null },
          { mutedUntil: { [Op.lt]: now } },
        ],
      },
      include: [{
        model: User,
        as:    'groupMemberUser',
        // FIX: 'pushToken' isn't a real column on Users (only fcmToken is) —
        // requesting it here made Postgres reject the whole query with
        // "column groupMemberUser.pushToken does not exist", silently
        // killing all group push notifications.
        attributes: ['id', 'fcmToken', 'settings'],
        required: false,
      }],
    });

    // Collect valid tokens
    // FIX (Notifications audit): this used to push to every member's token
    // unconditionally — never checking Settings > Notifications at all, so
    // "Enable Notifications" and "Group Notifications" had zero effect on
    // this (FCM-based) push path, even though the separate VAPID-based push
    // path (pushNotificationService.js, used for 1:1 messages/calls) already
    // gets this right via _getRecipientNotificationPrefs.
    const tokens = [];
    members.forEach(m => {
      const u = m.groupMemberUser;
      const token = u?.fcmToken;
      if (!token) return;
      const notif = u?.settings?.notifications || {};
      if (notif.enableNotifications === false) return;
      if (notif.groupNotifications === false) return;
      tokens.push({ memberId: m.userId, token });
    });

    if (!tokens.length) return;

    // Build notification
    const body = message.type === 'voice_note'
      ? '🎙 Sent a voice note'
      : message.type === 'image'
      ? '📷 Sent a photo'
      : message.type === 'file'
      ? '📎 Sent a file'
      : String(message.content || '').slice(0, 120) || 'New message';

    const notification = {
      title: `${message.senderName || 'Someone'} in ${groupName}`,
      body,
    };
    const data = {
      type:      'group_message',
      groupId:   String(groupId),
      messageId: String(message.id || ''),
      senderId:  String(message.senderId || ''),
      channelId: 'group_messages',
      // FIX (VERIFIED-MISSING-DEEP-LINK): without this, service-worker.js's
      // notificationclick handler (`data.url || '/chat.html'`) had nothing
      // to fall back to but the bare shell — a group message notification
      // click never opened the specific group. Mirrors
      // pushNotificationService.js's 1:1 `data.url` field exactly.
      url: `/chat.html?groupId=${groupId}`,
    };

    const tokenList = tokens.map(t => t.token);
    const result = await sendToMultipleTokens(tokenList, notification, data);

    // Clean up invalid tokens
    if (result.invalidTokens.length > 0) {
      const invalidSet = new Set(result.invalidTokens);
      const invalidUserIds = tokens.filter(t => invalidSet.has(t.token)).map(t => t.memberId);
      if (invalidUserIds.length) {
        await User.update({ fcmToken: null }, { where: { id: invalidUserIds } });
      }
    }

    if (result.successCount > 0) {
      console.log(`[PushService] Group ${groupId}: pushed to ${result.successCount}/${tokenList.length} members`);
    }
  } catch (e) {
    console.error('[PushService] pushGroupMessage error:', e.message);
  }
}

/**
 * Register / update a user's FCM token.
 */
async function registerToken(userId, fcmToken) {
  try {
    const db   = require('../models');
    const User = db.models?.Users || db.Users;
    if (!User || !userId || !fcmToken) return false;
    await User.update({ fcmToken }, { where: { id: userId } });
    return true;
  } catch (e) {
    console.error('[PushService] registerToken error:', e.message);
    return false;
  }
}

function isConfigured() { return _ready; }

module.exports = { sendToToken, sendToMultipleTokens, pushGroupMessage, registerToken, isConfigured };
