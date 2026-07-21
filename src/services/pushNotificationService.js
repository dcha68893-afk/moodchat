/**
 * pushNotificationService.js — Web Push (VAPID) + FCM-compatible notifications
 *
 * Implements:
 *  - Web Push API via VAPID (works on Chrome, Firefox, Edge, Safari 16.4+)
 *  - Notification grouping by conversation
 *  - Smart collapse: only latest message shown per chat
 *  - Mention notifications with priority
 *  - Silent background sync notifications
 *  - Reply-from-notification action
 *  - Mark-read-from-notification action
 *  - Notification analytics (delivery tracking)
 */

'use strict';

let webpush;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('[PushService] web-push not installed — push notifications disabled');
  webpush = null;
}

// ── VAPID key management ──────────────────────────────────────────────────────
let _vapidKeys = null;

function getVapidKeys() {
  if (_vapidKeys) return _vapidKeys;

  const pubKey  = process.env.VAPID_PUBLIC_KEY;
  const privKey = process.env.VAPID_PRIVATE_KEY;

  if (pubKey && privKey) {
    _vapidKeys = { publicKey: pubKey, privateKey: privKey };
  } else {
    // Auto-generate (development only — in prod set env vars and persist)
    if (webpush) {
      _vapidKeys = webpush.generateVAPIDKeys();
      console.warn('[PushService] ⚠️  No VAPID keys in env — generated ephemeral keys.');
      console.warn('[PushService]    Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env for persistence.');
      console.warn('[PushService]    Public key:', _vapidKeys.publicKey);
    }
  }
  return _vapidKeys;
}

function initVapid() {
  if (!webpush) return false;
  const keys = getVapidKeys();
  if (!keys) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@kynecta.com',
    keys.publicKey,
    keys.privateKey
  );
  console.log('[PushService] ✅ VAPID initialized');
  return true;
}

// ── Build notification payload ────────────────────────────────────────────────
function _buildPayload(type, data) {
  const payloads = {
    'message:new': {
      title:   data.senderName || 'New Message',
      body:    _truncate(data.content || 'Sent a message', 100),
      icon:    data.senderAvatar || '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     `chat-${data.chatId}`,   // groups notifications per chat
      renotify: true,
      data: {
        type:    'message:new',
        chatId:  data.chatId,
        messageId: data.messageId,
        url:     `/chat.html?chatId=${data.chatId}`,
      },
      actions: [
        { action: 'reply',    title: '↩ Reply'      },
        { action: 'mark-read', title: '✓ Mark Read' },
      ],
    },
    'mention': {
      title:   `${data.senderName} mentioned you`,
      body:    _truncate(data.content || '', 100),
      icon:    data.senderAvatar || '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     `mention-${data.chatId}-${data.messageId}`,
      data:    { type: 'mention', chatId: data.chatId, messageId: data.messageId, url: `/chat.html?chatId=${data.chatId}` },
      requireInteraction: true, // stays until dismissed
    },
    'call:incoming': {
      title:   `📞 ${data.callerName || 'Incoming call'}`,
      body:    data.isVideo ? 'Video call' : 'Voice call',
      icon:    data.callerAvatar || '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     `call-${data.callId}`,
      requireInteraction: true,
      data:    { type: 'call:incoming', callId: data.callId, callerId: data.callerId, url: `/chat.html?callId=${data.callId}` },
      actions: [
        { action: 'accept', title: '✅ Accept' },
        { action: 'reject', title: '❌ Decline' },
      ],
    },
    'friend:request': {
      title:   `${data.fromName || 'Someone'} sent you a friend request`,
      body:    data.message || 'Wants to connect with you on Kynecta',
      icon:    data.fromAvatar || '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     `friend-${data.requestId}`,
      data:    { type: 'friend:request', requestId: data.requestId, url: '/chat.html?tab=friends' },
    },
  };

  return payloads[type] || {
    title: 'Kynecta',
    body:  data.message || 'You have a new notification',
    icon:  '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data:  { type, url: '/chat.html' },
  };
}

function _truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ── Core send function ────────────────────────────────────────────────────────
async function sendToSubscription(subscription, payload) {
  if (!webpush) return false;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired — caller should delete it
      return 'expired';
    }
    console.error('[PushService] Send error:', err.message);
    return false;
  }
}

// ── Send to all user subscriptions ───────────────────────────────────────────
// FIX: sendToUser previously sent a push notification unconditionally to
// every subscribed device, never checking whether the recipient had turned
// off notifications for this category in Settings. messageNotifications /
// mentionNotifications / callNotifications were all fully wired end-to-end
// (saved, synced, displayed correctly) but never actually consulted by the
// one function that decides whether to push a notification. Also fetches
// notificationSound/notificationVibration here (same query, no extra DB
// hit) so they can ride along in the payload — the service worker runs in
// its own scope and can't easily ask the page for current settings, so
// this is the simplest reliable way to get the preference to it.
const NOTIFICATION_SETTING_KEY = {
  'message:new':    'messageNotifications',
  'mention':        'mentionNotifications',
  'call:incoming':  'callNotifications',
};

async function _getRecipientNotificationPrefs(userId, type, sequelize) {
  const defaults = { enabled: true, sound: true, vibrate: true };
  try {
    const rows = await sequelize.query(
      `SELECT settings FROM "Users" WHERE id = :userId LIMIT 1`,
      { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
    );
    const notif = rows?.[0]?.settings?.notifications || {};
    const settingKey = NOTIFICATION_SETTING_KEY[type];
    return {
      enabled: settingKey ? notif[settingKey] !== false : true,
      sound:   notif.notificationSound !== false,
      vibrate: notif.notificationVibration !== false,
    };
  } catch (_) {
    return defaults; // fail open — a lookup error shouldn't silently eat notifications
  }
}

async function sendToUser(userId, type, data, sequelize) {
  if (!webpush || !sequelize) return;

  const prefs = await _getRecipientNotificationPrefs(userId, type, sequelize);
  if (!prefs.enabled) return;

  const subs = await sequelize.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE "userId"=:userId`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!subs || subs.length === 0) return;

  const payload   = _buildPayload(type, data);
  payload.silent  = !prefs.sound;
  payload.vibrate = prefs.vibrate ? [200, 100, 200] : [];
  const expired   = [];

  await Promise.allSettled(subs.map(async (sub) => {
    const result = await sendToSubscription(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload
    );
    if (result === 'expired') expired.push(sub.id);
  }));

  // Clean up expired subscriptions
  if (expired.length > 0) {
    await sequelize.query(
      `DELETE FROM push_subscriptions WHERE id = ANY(:ids)`,
      { replacements: { ids: expired } }
    ).catch(() => {});
  }
}

// ── New message notification ──────────────────────────────────────────────────
async function notifyNewMessage(recipientId, messageData, sequelize) {
  return sendToUser(recipientId, 'message:new', messageData, sequelize);
}

// ── Mention notification ──────────────────────────────────────────────────────
async function notifyMention(mentionedUserId, messageData, sequelize) {
  return sendToUser(mentionedUserId, 'mention', messageData, sequelize);
}

// ── Call notification ─────────────────────────────────────────────────────────
async function notifyIncomingCall(recipientId, callData, sequelize) {
  return sendToUser(recipientId, 'call:incoming', callData, sequelize);
}

// ── Get VAPID public key (for service worker registration) ────────────────────
function getPublicKey() {
  const keys = getVapidKeys();
  return keys ? keys.publicKey : null;
}

module.exports = {
  initVapid,
  getPublicKey,
  sendToUser,
  sendToSubscription,
  notifyNewMessage,
  notifyMention,
  notifyIncomingCall,
};
