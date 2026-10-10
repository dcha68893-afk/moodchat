'use strict';
/**
 * pushService.js - FCM (Firebase Cloud Messaging) delivery for the native Android app.
 *
 * FIXES in this version (why notifications never showed when the app was closed):
 *  1. Firebase credentials are now accepted in every common form: raw JSON, base64 JSON, JSON with escaped
 *     newlines in private_key, three separate env vars, or GOOGLE_APPLICATION_CREDENTIALS. Before, a pasted key whose
 *     "\n" were mangled made initialisation fail ONCE and push stayed disabled for the whole process lifetime.
 *  2. Initialisation is retried (at most every 60 s) instead of being cached as a permanent failure.
 *  3. global.__pushService is now assigned. workers/groupCronWorker.js checks it, but nothing ever set it, so those
 *     pushes silently never ran.
 *  4. Group pushes skip members who muted the group (chat_participants) and never throw into the caller.
 *  5. getStatus() reports WHY push is off (error text, token counts) so /api/push/status is useful for diagnosis.
 */

let _admin = null, _app = null, _ready = false, _initErr = null, _lastInitTry = 0, _projectId = null, _lastSendError = null;

// Escape raw control characters (real newlines/tabs) that sit INSIDE JSON string values. Pasting a multi-line service-account
// file into Render's env-var box keeps real newlines in "private_key", and JSON.parse rejects those ("Bad control character").
function _escapeControlCharsInStrings(text) {
  let out = '', inStr = false, esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function _tryParseServiceAccount(rawIn) {
  let raw = String(rawIn || '').trim();
  if (!raw) return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1).trim();
  if (!raw.startsWith('{')) {                                   // base64-encoded JSON
    try {
      const dec = Buffer.from(raw, 'base64').toString('utf8').trim();
      if (dec.startsWith('{')) raw = dec;
    } catch (_) {}
  }
  if (!raw.startsWith('{')) return null;
  let sa;
  try { sa = JSON.parse(raw); }
  catch (_) {
    try { sa = JSON.parse(_escapeControlCharsInStrings(raw)); }
    catch (e2) { throw new Error('service account JSON is not valid: ' + e2.message); }
  }
  if (!sa || typeof sa !== 'object') return null;
  if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
  return (sa.private_key && sa.client_email) ? sa : null;
}

function _parseServiceAccount() {
  // 1) well-known names first, then 2) ANY env var that looks like it holds a service-account JSON
  //    (people name it FIREBASE_CREDENTIALS, FIREBASE_KEY, GOOGLE_CREDENTIALS, FCM_SERVICE_ACCOUNT ...).
  const known = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT_KEY', 'FIREBASE_CREDENTIALS',
    'FIREBASE_CONFIG_JSON', 'FIREBASE_ADMIN_SDK', 'FIREBASE_KEY', 'GOOGLE_SERVICE_ACCOUNT', 'GOOGLE_CREDENTIALS', 'FCM_SERVICE_ACCOUNT'];
  const names = known.filter(n => process.env[n]).concat(
    Object.keys(process.env).filter(n => !known.includes(n) && /FIREBASE|FCM|GOOGLE|SERVICE_ACCOUNT/i.test(n) && /^\s*["']?[{e]/.test(process.env[n] || '') && String(process.env[n]).length > 200));
  let lastErr = null;
  for (const n of names) {
    try { const sa = _tryParseServiceAccount(process.env[n]); if (sa) { sa.__source = n; return sa; } }
    catch (e) { lastErr = new Error(n + ': ' + e.message); }
  }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    let key = String(process.env.FIREBASE_PRIVATE_KEY).trim();
    if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
    return {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: key.replace(/\\n/g, '\n'),
      __source: 'FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY',
    };
  }
  if (lastErr) throw lastErr;
  return null;
}

function _initFirebase() {
  if (_ready) return true;
  const now = Date.now();
  if (_initErr && now - _lastInitTry < 60000) return false;   // retry at most once a minute
  _lastInitTry = now;
  try {
    _admin = require('firebase-admin');
    if (_admin.apps.length) { _app = _admin.apps[0]; _ready = true; _initErr = null; return true; }
    const sa = _parseServiceAccount();
    let credential;
    if (sa) {
      const source = sa.__source; delete sa.__source;
      credential = _admin.credential.cert(sa);
      _projectId = sa.project_id || null;
      console.log('[PushService] Using service account from env ' + source + ' (project_id=' + _projectId + ', client_email=' + sa.client_email + ')');
      if (_projectId && _projectId !== 'necpra') console.warn('[PushService] WARNING: android/app/google-services.json is project "necpra" but this service account is for "' + _projectId + '" - FCM will reject every token (SenderId mismatch). Use a key from the SAME Firebase project.');
    }
    else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) credential = _admin.credential.applicationDefault();
    else { _initErr = 'Firebase not configured (set FIREBASE_SERVICE_ACCOUNT)'; return false; }
    _app = _admin.initializeApp({ credential });
    _ready = true; _initErr = null;
    console.log('[PushService] Firebase Admin initialized');
    return true;
  } catch (e) {
    _initErr = e.message;
    console.warn('[PushService] Firebase init failed:', e.message);
    return false;
  }
}
_initFirebase();

function isConfigured() { return _ready || _initFirebase(); }
function _db() { return require('../models'); }
function _invalidError(code) {
  return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' ||
         code === 'registration-token-not-registered' || code === 'invalid-registration-token';
}
// The app creates the v2 channels (status_updates_v2, general_v2). Pushes addressed to the old names landed in the
// fallback channel (no pop-up, no sound). Map any legacy/unknown name to the real channel id.
const _CHANNEL_MAP = { status_updates: 'status_updates_v2', general: 'general_v2' };
function _androidChannel(id) { const c = String(id || 'messages'); return _CHANNEL_MAP[c] || c; }
function _stringData(data = {}) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k), String(v ?? '')]));
}

async function _ensureTable() {
  const db = _db();
  await db.sequelize.query(
    'CREATE TABLE IF NOT EXISTS device_push_tokens (id BIGSERIAL PRIMARY KEY,"userId" INTEGER NOT NULL,token TEXT NOT NULL UNIQUE,' +
    'platform VARCHAR(30) NOT NULL DEFAULT \'android\',"userAgent" TEXT,"lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),' +
    '"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  ).catch(() => {});
}

async function _deleteTokens(tokens) {
  if (!tokens || !tokens.length) return;
  try {
    const db = _db();
    await db.sequelize.query('DELETE FROM device_push_tokens WHERE token = ANY(:tokens)',
      { replacements: { tokens }, type: db.sequelize.QueryTypes.DELETE });
  } catch (e) { console.warn('[PushService] token cleanup failed:', e.message); }
}

async function sendToMultipleTokens(tokens, notification, data = {}, sendOptions = {}) {
  if (!isConfigured() || !_app || !Array.isArray(tokens) || !tokens.length) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] };
  }
  const invalidTokens = [];
  let successCount = 0, failureCount = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const title = String(notification.title || 'Necpra').slice(0, 80);
      const body = String(notification.body || '').slice(0, 300);
      const img = /^https:\/\/[^\s]+$/i.test(String(notification.imageUrl || '')) ? String(notification.imageUrl) : '';
      // DATA-ONLY for devices running the native NecpraMessagingService: no `notification` block, so Android never
      // draws it itself and the app's service always receives the push (closed / background / foreground) and builds
      // the grouped MessagingStyle notification with Reply / Mark as read.
      const msg = sendOptions.dataOnly
        ? {
            data: _stringData({ ...data, title, body, ...(img ? { imageUrl: img } : {}) }),
            android: { priority: 'high', ttl: 86400000 },
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { alert: { title, body }, sound: 'default', badge: 1 } } },
            tokens: batch,
          }
        : {
            notification: { title, body, ...(img ? { imageUrl: img } : {}) },
            data: _stringData(data),
            android: { priority: 'high', ttl: 86400000, notification: { channelId: _androidChannel(data.channelId), sound: 'default' } },
            apns: { payload: { aps: { sound: 'default', badge: 1 } } },
            tokens: batch,
          };
      const response = await _admin.messaging().sendEachForMulticast(msg);
      successCount += response.successCount;
      failureCount += response.failureCount;
      response.responses.forEach((item, index) => {
        if (item.success) return;
        if (_invalidError(item.error && item.error.code)) invalidTokens.push(batch[index]);
        else {
          const code = String((item.error && item.error.code) || ''), msg = String((item.error && item.error.message) || '');
          _lastSendError = code + ': ' + msg;
          if (/third-party-auth-error|mismatched-credential|sender-id-mismatch|authentication-error|invalid-credential|insufficient-permission/i.test(code + ' ' + msg))
            console.error('[PushService] FIREBASE REJECTED THE SERVER CREDENTIALS - every push will fail until FIREBASE_SERVICE_ACCOUNT on Render is a key from Firebase project \"necpra\" (matching google-services.json). Firebase said: ' + _lastSendError);
          else console.warn('[PushService] FCM send failed:', _lastSendError);
        }
      });
    } catch (e) {
      _lastSendError = e.message;
      if (/credential|authenticat|permission|Could not load the default credentials|invalid_grant|private key/i.test(String(e.message)))
        console.error('[PushService] FIREBASE REJECTED THE SERVER CREDENTIALS - check FIREBASE_SERVICE_ACCOUNT on Render (must be a key from Firebase project \"necpra\"). Error: ' + e.message);
      else console.error('[PushService] multicast failed:', e.message);
      failureCount += batch.length;
    }
  }
  if (invalidTokens.length) await _deleteTokens([...new Set(invalidTokens)]);
  return { successCount, failureCount, invalidTokens };
}

async function sendToToken(token, notification, data = {}) {
  const r = await sendToMultipleTokens([token], notification, data);
  return r.successCount ? 'sent' : (r.invalidTokens.length ? 'INVALID_TOKEN' : null);
}

function _parseSettings(s) {
  if (!s) return {};
  if (typeof s === 'string') { try { return JSON.parse(s) || {}; } catch (_) { return {}; } }
  return s;
}
function _prefs(settings) {
  const n = _parseSettings(settings).notifications || {};
  return {
    enabled: n.enableNotifications !== false && n.pushNotifications !== false,
    messages: n.messageNotifications !== false && n.messages !== false,
    groups: n.groupNotifications !== false && n.groups !== false,
    status: n.statusNotifications !== false && n.status !== false,
  };
}

async function _tokensForUsers(userIds, category) {
  await _ensureTable();
  const db = _db();
  const ids = [...new Set((userIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const rows = await db.sequelize.query(
    'SELECT d."userId",d.token,d."userAgent",u.settings FROM device_push_tokens d JOIN "Users" u ON u.id=d."userId" ' +
    'WHERE d."userId"=ANY(:ids) AND d."lastSeenAt">NOW()-INTERVAL \'90 days\' AND d.token IS NOT NULL AND d.token<>\'\'',
    { replacements: { ids }, type: db.sequelize.QueryTypes.SELECT });
  return rows.filter(r => { const p = _prefs(r.settings); return p.enabled && p[category] !== false; });
}

// Devices running the native notification layer say so in userAgent (set by NecpraPushRegistrar / js/native-push.js).
function _hasNativeNotify(ua) { return /NecpraNativeNotify\/\d+/.test(String(ua || '')); }
// v3+ draws Status notifications natively; older APKs would drop a data-only status push.
function _nativeNotifyVersion(ua) { const m = /NecpraNativeNotify\/(\d+)/.exec(String(ua || '')); return m ? Number(m[1]) : 0; }

const _noTokenWarnAt = new Map();   // userId -> last warn timestamp
function _warnNoTokens(userIds) {
  const now = Date.now();
  for (const id of (userIds || [])) {
    const k = String(id);
    if (now - (_noTokenWarnAt.get(k) || 0) < 10 * 60 * 1000) continue;
    _noTokenWarnAt.set(k, now);
    console.warn('[PushService] No usable device token for user ' + k + ' - the phone never registered (or the token is >90 days old / notifications disabled in settings). Not an FCM delivery failure.');
  }
  if (_noTokenWarnAt.size > 5000) for (const [k, t] of _noTokenWarnAt) if (now - t > 10 * 60 * 1000) _noTokenWarnAt.delete(k);
}

let _warnedNoFirebase = false;
async function sendToUsers(userIds, notification, data = {}, options = {}) {
  if (!isConfigured()) {
    if (!_warnedNoFirebase) {
      _warnedNoFirebase = true;
      console.warn('[PushService] Push is DISABLED - Firebase Admin not initialised:', _initErr || 'unknown reason',
        '(set FIREBASE_SERVICE_ACCOUNT on the server)');
    }
    return { successCount: 0, failureCount: 0, invalidTokens: [], configured: false };
  }
  const category = options.category || 'messages';
  const rows = await _tokensForUsers(userIds, category);
  if (!rows.length) {
    _warnNoTokens([...new Set((userIds || []).map(Number).filter(Number.isInteger))]);
    return { successCount: 0, failureCount: 0, invalidTokens: [], configured: true, noTokens: true };
  }

  const channel = data.channelId ||
    (category === 'groups' ? 'group_messages' : category === 'status' ? 'status_updates' : category === 'other' ? 'general' : 'messages');
  const isChat = data.type === 'message' || data.type === 'group_message';
  const isStatus = category === 'status' || String(data.type || '').startsWith('status');
  const isNative = r => isStatus ? _nativeNotifyVersion(r.userAgent) >= 3 : _hasNativeNotify(r.userAgent);
  const nativeRows = (isChat || isStatus) ? rows.filter(isNative) : [];
  const legacyRows = (isChat || isStatus) ? rows.filter(r => !isNative(r)) : rows;
  const payload = { ...data, channelId: _androidChannel(channel) };

  const parts = [];
  if (nativeRows.length) parts.push(await sendToMultipleTokens(nativeRows.map(r => r.token), notification, payload, { dataOnly: true }));
  if (legacyRows.length) parts.push(await sendToMultipleTokens(legacyRows.map(r => r.token), notification, payload));
  const total = parts.reduce((a, x) => ({
    successCount: a.successCount + x.successCount,
    failureCount: a.failureCount + x.failureCount,
    invalidTokens: a.invalidTokens.concat(x.invalidTokens),
  }), { successCount: 0, failureCount: 0, invalidTokens: [] });
  return { ...total, configured: true };
}

async function registerToken(userId, token, meta = {}) {
  await _ensureTable();
  const uid = Number(userId), fcmToken = String(token || '').trim();
  if (!uid || !fcmToken) throw new Error('userId and token are required');
  const db = _db();
  await db.sequelize.query(
    'INSERT INTO device_push_tokens ("userId",token,platform,"userAgent","lastSeenAt","createdAt","updatedAt") ' +
    'VALUES (:userId,:token,:platform,:userAgent,NOW(),NOW(),NOW()) ON CONFLICT (token) DO UPDATE SET ' +
    '"userId"=EXCLUDED."userId",platform=COALESCE(EXCLUDED.platform,device_push_tokens.platform),' +
    '"userAgent"=COALESCE(EXCLUDED."userAgent",device_push_tokens."userAgent"),"lastSeenAt"=NOW(),"updatedAt"=NOW()',
    { replacements: { userId: uid, token: fcmToken, platform: String(meta.platform || 'android').slice(0, 30),
        userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 1000) : null }, type: db.sequelize.QueryTypes.INSERT });
  return true;
}

async function unregisterToken(userId, token = null) {
  await _ensureTable();
  const uid = Number(userId);
  if (!uid) return false;
  const db = _db();
  await db.sequelize.query(
    token ? 'DELETE FROM device_push_tokens WHERE "userId"=:userId AND token=:token' : 'DELETE FROM device_push_tokens WHERE "userId"=:userId',
    { replacements: token ? { userId: uid, token: String(token) } : { userId: uid }, type: db.sequelize.QueryTypes.DELETE });
  return true;
}

async function getStatus(userId) {
  await _ensureTable();
  const db = _db(), uid = Number(userId);
  const rows = uid ? await db.sequelize.query(
    'SELECT "userAgent" FROM device_push_tokens WHERE "userId"=:userId',
    { replacements: { userId: uid }, type: db.sequelize.QueryTypes.SELECT }) : [];
  return {
    configured: isConfigured(), error: _initErr, projectId: _projectId, lastSendError: _lastSendError,
    deviceCount: rows.length,
    nativeDeviceCount: rows.filter(r => _hasNativeNotify(r.userAgent)).length,
  };
}

async function pushGroupMessage(groupId, message, groupName = 'Group') {
  try {
    const db = _db(), GM = (db.models && db.models.GroupMembers) || db.GroupMembers;
    if (!GM) return;
    const { Op } = require('sequelize');
    const members = await GM.findAll({
      where: { groupId, leftAt: null, isBanned: false, userId: { [Op.ne]: Number(message.senderId) },
        [Op.or]: [{ mutedUntil: null }, { mutedUntil: { [Op.lt]: new Date() } }] },
      attributes: ['userId'],
    });
    const ids = members.map(m => Number(m.userId)).filter(Boolean);
    if (!ids.length) return;
    await sendToUsers(ids,
      { title: String(message.senderName || 'Someone') + ' in ' + groupName, body: String(message.content || 'New message').slice(0, 120) },
      { type: 'group_message', groupId: String(groupId), messageId: String(message.id || ''), senderId: String(message.senderId || ''), url: '/chat.html?groupId=' + groupId },
      { category: 'groups' });
  } catch (e) { console.warn('[PushService] pushGroupMessage failed:', e.message); }
}

function _looksEncrypted(raw) {
  return /^\s*\{\s*"(v|kid|ct|iv|eph|sid|n|pipeline|epoch|owner)"\s*:/.test(String(raw || ''));
}
function safePreview(message) {
  const type = String((message && message.type) || 'text').toLowerCase(), raw = String((message && message.content) || '');
  const labels = { image: 'a photo', video: 'a video', audio: 'a voice message', file: 'a file', sticker: 'a sticker', location: 'a location', contact: 'a contact', poll: 'a poll' };
  if (type === 'text') return (!raw || _looksEncrypted(raw)) ? 'New message' : raw.slice(0, 100);
  return 'Sent ' + (labels[type] || 'a message');
}

async function describeGroupMessage(groupId, message) {
  let groupName = 'Group';
  try {
    const db = _db();
    const [c] = await db.sequelize.query('SELECT name FROM chats WHERE id=:id LIMIT 1',
      { replacements: { id: Number(groupId) }, type: db.sequelize.QueryTypes.SELECT });
    if (c && c.name) groupName = String(c.name);
  } catch (_) {}
  const full = [message && message.firstName, message && message.lastName].filter(Boolean).join(' ').trim();
  const sender = (message && message.senderDisplayName) || full || (message && message.senderUsername) || 'Someone';
  return { title: groupName, body: sender + ': ' + safePreview(message), imageUrl: (message && message.senderAvatar) || null };
}

/** Group fan-out used by routes/group-messages.js: skips muted members, never throws, safe to fire-and-forget. */
async function pushGroupChatMessage(groupId, senderId, message, memberIds) {
  try {
    const db = _db();
    let ids = [...new Set((memberIds || []).map(Number).filter(n => n && n !== Number(senderId)))];
    if (!ids.length) return { successCount: 0, failureCount: 0 };
    try {
      const muted = await db.sequelize.query(
        'SELECT "userId" FROM chat_participants WHERE "chatId"=:chatId AND "userId"=ANY(:ids) AND "isMuted"=true ' +
        'AND ("mutedUntil" IS NULL OR "mutedUntil">NOW())',
        { replacements: { chatId: Number(groupId), ids }, type: db.sequelize.QueryTypes.SELECT });
      const mutedSet = new Set(muted.map(r => Number(r.userId)));
      ids = ids.filter(id => !mutedSet.has(id));
    } catch (_) { /* fail open: a mute lookup error must not eat the notification */ }
    if (!ids.length) return { successCount: 0, failureCount: 0 };
    const d = await describeGroupMessage(groupId, message);
    return await sendToUsers(ids, { title: d.title, body: d.body, imageUrl: d.imageUrl },
      { type: 'group_message', groupId: String(groupId), messageId: String((message && message.id) || ''),
        senderId: String(senderId), url: '/chat.html?groupId=' + groupId }, { category: 'groups' });
  } catch (e) {
    console.warn('[PushService] group push failed:', e.message);
    return { successCount: 0, failureCount: 0 };
  }
}

// Generic bridge: every in-app Notification row (friend request, status like/comment, group invite, ...) also becomes an OS push.
function _channelForType(t) {
  t = String(t || '');
  if (t.startsWith('status')) return 'status_updates';
  if (t.startsWith('group')) return 'group_messages';
  return 'general';
}
async function pushForNotification(userId, n) {
  if (!n || !userId) return;
  const d = (n.data && typeof n.data === 'object') ? n.data : {};
  const out = { type: String(n.type || 'notification'), notificationId: String(n.id || ''), channelId: _channelForType(n.type), url: String(n.actionUrl || '') };
  ['chatId', 'groupId', 'statusId', 'messageId', 'requesterId', 'userId'].forEach(k => { if (d[k] != null) out[k] = String(d[k]); });
  const category = String(n.type || '').startsWith('status') ? 'status' : String(n.type || '').startsWith('group') ? 'groups' : 'other';
  await sendToUsers([Number(userId)], {
    title: String(n.title || 'Necpra'), body: String(n.body || 'You have a new notification'),
    imageUrl: d.senderAvatar || d.requesterAvatar || d.avatar || null,
  }, out, { category });
}

module.exports = {
  safePreview, describeGroupMessage, pushForNotification, sendToToken, sendToMultipleTokens, sendToUsers,
  pushGroupMessage, pushGroupChatMessage, registerToken, unregisterToken, getStatus, isConfigured,
};
// workers/groupCronWorker.js reads global.__pushService; nothing ever assigned it, so those pushes never ran.
global.__pushService = module.exports;
