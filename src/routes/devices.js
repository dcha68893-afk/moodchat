/**
 * devices.js — Multi-device management + encrypted backup routes
 *
 * Phase 7 — Multi-Device:
 *  GET    /api/devices                    — List linked devices
 *  POST   /api/devices/link               — Link a new device
 *  DELETE /api/devices/:deviceId          — Revoke a device
 *  GET    /api/devices/sync               — Sync data to linked devices
 *  POST   /api/devices/heartbeat          — Update device last-seen
 *
 * Phase 12 — Encrypted Backup:
 *  POST   /api/devices/backup             — Create/update encrypted message backup
 *  GET    /api/devices/backup             — Get backup metadata
 *  GET    /api/devices/backup/download    — Download encrypted backup
 *  DELETE /api/devices/backup             — Delete backup
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('express-async-handler');
const crypto       = require('crypto');

function getSequelize() { return require('../models/index').sequelize; }

const MAX_DEVICES = 5; // Max linked devices per user (Signal-style)

// ── AUTO-MIGRATION: create linked_devices table if it doesn't exist ─────────
// FIX: there is no Sequelize model AND no migration file anywhere in this
// codebase that creates this table — every route below queries it directly
// via raw SQL, so on any database that hasn't had it manually created, every
// single one of these routes 500s with "relation linked_devices does not
// exist". Mirrors the same self-healing pattern used in models/Call.js.
let _linkedDevicesMigrated = false;
async function ensureLinkedDevicesTable() {
  if (_linkedDevicesMigrated) return;
  _linkedDevicesMigrated = true;
  try {
    const sequelize = getSequelize();
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS linked_devices (
        id            SERIAL PRIMARY KEY,
        "userId"      INTEGER NOT NULL,
        "deviceId"    VARCHAR(64) NOT NULL,
        "deviceName"  VARCHAR(200),
        platform      VARCHAR(50) DEFAULT 'web',
        "publicKey"   TEXT,
        "isActive"    BOOLEAN NOT NULL DEFAULT true,
        "lastSeenAt"  TIMESTAMPTZ,
        "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT linked_devices_user_device_unique UNIQUE ("userId", "deviceId")
      );
    `);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS linked_devices_user_idx ON linked_devices ("userId");`);
    console.log('[devices.js] ✅ linked_devices table verified/created');
  } catch (err) {
    console.error('[devices.js] ⚠️ Could not verify/create linked_devices table:', err.message);
  }
}
// Kick off once at module load, but every route below also awaits this
// (resolves immediately once the first run completes) so a request that
// arrives before startup migration finishes still succeeds instead of racing.
let _linkedDevicesReady = ensureLinkedDevicesTable();
router.use((req, res, next) => { _linkedDevicesReady.then(() => next()).catch(() => next()); });

// ────────────────────────────────────────────────────────────────────────────
// DEVICE MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

// GET /api/devices — list linked devices
router.get('/', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  // BUG FIX (REVOKED-DEVICE-NEVER-DISAPPEARS): DELETE /api/devices/:deviceId
  // only ever sets isActive=false (a soft revoke, so history/backup records
  // referencing the device stay intact) — but this list query selected every
  // row for the user with no isActive filter at all, so a "removed" device
  // kept showing up in Settings forever, with Rename/Revoke still offered on
  // a session that was already revoked. Only list active devices.
  const devices   = await sequelize.query(
    `SELECT "deviceId","deviceName",platform,"lastSeenAt","isActive","createdAt"
     FROM linked_devices WHERE "userId"=:userId AND "isActive"=true ORDER BY "lastSeenAt" DESC NULLS LAST`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  res.json({ status: 'success', data: { devices, count: devices.length } });
}));

// POST /api/devices/link — register a new device
router.post('/link', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { deviceName, platform, publicKey } = req.body;
  // FIX-DEVICEID-IGNORED: this route used to ignore the deviceId the client
  // already sends (js/multi-device-sync.js persists one per browser via
  // _getOrCreateDeviceId() specifically so re-linking the same device is
  // idempotent) and generated a brand-new random one on every single call
  // instead. That meant the ON CONFLICT ("userId","deviceId") below could
  // never match an existing row, so every page load/reload inserted a whole
  // new device instead of updating the existing one — after 5 loads the
  // MAX_DEVICES cap was permanently hit and every future /link call 422'd,
  // which is exactly what was being reported.
  const { deviceId: clientDeviceId } = req.body;

  if (!deviceName) return res.status(400).json({ status: 'error', message: 'deviceName required' });

  const sequelize = getSequelize();
  const deviceId  = clientDeviceId || crypto.randomBytes(16).toString('hex');

  // Enforce device limit — only counts if this isn't already a known device
  const [existingRows] = await sequelize.query(
    `SELECT 1 FROM linked_devices WHERE "userId"=:userId AND "deviceId"=:deviceId`,
    { replacements: { userId, deviceId } }
  );
  if (!existingRows?.length) {
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM linked_devices WHERE "userId"=:userId AND "isActive"=true`,
      { replacements: { userId } }
    );
    if (parseInt(countRows[0]?.cnt || 0) >= MAX_DEVICES) {
      return res.status(422).json({
        status: 'error',
        message: `Maximum ${MAX_DEVICES} devices allowed. Remove a device first.`,
      });
    }
  }

  await sequelize.query(
    `INSERT INTO linked_devices ("userId","deviceId","deviceName",platform,"publicKey","isActive","lastSeenAt","createdAt","updatedAt")
     VALUES (:userId,:deviceId,:deviceName,:platform,:publicKey,true,NOW(),NOW(),NOW())
     ON CONFLICT ("userId","deviceId") DO UPDATE
       SET "deviceName"=:deviceName, platform=:platform, "isActive"=true, "lastSeenAt"=NOW(), "updatedAt"=NOW()`,
    { replacements: { userId, deviceId, deviceName, platform: platform || 'web', publicKey: publicKey || null } }
  );

  res.status(201).json({
    status: 'success',
    data: { deviceId, deviceName, platform },
    message: 'Device linked successfully',
  });
}));

// POST /api/devices/heartbeat — update last-seen
router.post('/heartbeat', asyncHandler(async (req, res) => {
  const userId   = req.user.id;
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ status: 'error', message: 'deviceId required' });

  const sequelize = getSequelize();
  await sequelize.query(
    `UPDATE linked_devices SET "lastSeenAt"=NOW(), "updatedAt"=NOW()
     WHERE "userId"=:userId AND "deviceId"=:deviceId`,
    { replacements: { userId, deviceId } }
  );
  res.json({ status: 'success' });
}));

// DELETE /api/devices/revoke-all — sign out every other device
// IMPORTANT: must be registered BEFORE DELETE /:deviceId below, otherwise
// Express matches this path as deviceId="revoke-all" and 404s/no-ops instead
// of actually revoking anything. The frontend (linked-sessions-and-pin.js)
// calls this exact path; previously only settings.js exposed the equivalent
// logic at /api/settings/devices/revoke-all, which nothing ever called.
router.delete('/revoke-all', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();

  await sequelize.query(
    `UPDATE linked_devices SET "isActive"=false, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );
  try {
    await sequelize.query(
      `UPDATE refresh_tokens SET revoked=true,"revokedAt"=NOW() WHERE "userId"=:userId`,
      { replacements: { userId } }
    );
  } catch (_) {}

  res.json({ status: 'success', message: 'All other sessions terminated' });
}));

// PATCH /api/devices/:deviceId — rename a linked device
// Added: mission Step 7 requires device rename; no route for it existed
// anywhere in the backend (settings.js's /devices/revoke-all is the only
// other devices-adjacent route, and it doesn't do renames either).
router.patch('/:deviceId', asyncHandler(async (req, res) => {
  const userId   = req.user.id;
  const { deviceId } = req.params;
  const { deviceName } = req.body;

  if (!deviceName || !deviceName.trim()) {
    return res.status(400).json({ status: 'error', message: 'deviceName required' });
  }

  const sequelize = getSequelize();
  const [, affected] = await sequelize.query(
    `UPDATE linked_devices SET "deviceName"=:deviceName, "updatedAt"=NOW()
     WHERE "userId"=:userId AND "deviceId"=:deviceId`,
    { replacements: { userId, deviceId, deviceName: deviceName.trim() } }
  );

  res.json({ status: 'success', message: 'Device renamed', data: { deviceId, deviceName: deviceName.trim() } });
}));

// DELETE /api/devices/:deviceId — revoke device
router.delete('/:deviceId', asyncHandler(async (req, res) => {
  const userId   = req.user.id;
  const { deviceId } = req.params;
  const sequelize = getSequelize();

  await sequelize.query(
    `UPDATE linked_devices SET "isActive"=false, "updatedAt"=NOW()
     WHERE "userId"=:userId AND "deviceId"=:deviceId`,
    { replacements: { userId, deviceId } }
  );

  // Also remove push subscriptions from that device if deviceId is in userAgent
  // (best-effort — depends on device identifying itself in user-agent)

  res.json({ status: 'success', message: 'Device revoked' });
}));

// GET /api/devices/sync — return sync data for a newly linked device
router.get('/sync', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const since     = req.query.since ? new Date(req.query.since) : null;
  const sequelize = getSequelize();

  // Return recent messages, chat list, starred messages, and pinned chats
  const [recentChats, starredMessages, pinnedChats] = await Promise.all([
    sequelize.query(
      `SELECT c.id, c.type, c.name, c."updatedAt", c."lastMessageId",
              cp."isMuted", cp."isPinned", cp."unreadCount"
       FROM chats c
       JOIN chat_participants cp ON cp."chatId"=c.id AND cp."userId"=:userId
       ${since ? 'WHERE c."updatedAt" > :since' : ''}
       ORDER BY c."updatedAt" DESC LIMIT 50`,
      { replacements: { userId, since }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT "messageId","chatId","starredAt" FROM starred_messages WHERE "userId"=:userId LIMIT 200`,
      { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT "chatId","pinnedAt" FROM chat_participants WHERE "userId"=:userId AND "isPinned"=true`,
      { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  res.json({
    status: 'success',
    data: {
      syncedAt: new Date().toISOString(),
      chats:    recentChats,
      starred:  starredMessages,
      pinned:   pinnedChats,
    },
  });
}));

// ────────────────────────────────────────────────────────────────────────────
// ENCRYPTED BACKUP (Phase 12)
// ────────────────────────────────────────────────────────────────────────────

// POST /api/devices/backup — upload encrypted backup
router.post('/backup', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { encryptedData, messageCount, sizeBytes } = req.body;

  if (!encryptedData || typeof encryptedData !== 'string') {
    return res.status(400).json({ status: 'error', message: 'encryptedData (base64 encrypted JSON) required' });
  }
  if (encryptedData.length > 50 * 1024 * 1024) { // 50MB limit for inline backup
    return res.status(413).json({ status: 'error', message: 'Backup too large. Max 50MB inline. Use chunked upload for larger.' });
  }

  const sequelize = getSequelize();
  const backupKey = crypto.randomBytes(16).toString('hex');

  await sequelize.query(
    `INSERT INTO message_backups ("userId","backupKey","encryptedData","messageCount","sizeBytes","status","completedAt","createdAt")
     VALUES (:userId,:backupKey,:encryptedData,:messageCount,:sizeBytes,'completed',NOW(),NOW())
     ON CONFLICT DO NOTHING`,
    { replacements: {
      userId, backupKey, encryptedData,
      messageCount: parseInt(messageCount) || 0,
      sizeBytes: parseInt(sizeBytes) || encryptedData.length,
    }}
  );

  res.status(201).json({
    status: 'success',
    data: { backupKey },
    message: 'Encrypted backup saved. Store the backup key securely — it is needed to restore.',
  });
}));

// GET /api/devices/backup — get backup metadata
router.get('/backup', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  const rows      = await sequelize.query(
    `SELECT "backupKey","messageCount","sizeBytes","status","completedAt","createdAt"
     FROM message_backups WHERE "userId"=:userId ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows?.length) return res.json({ status: 'success', data: null });
  res.json({ status: 'success', data: rows[0] });
}));

// GET /api/devices/backup/download — download encrypted backup
router.get('/backup/download', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const { key }   = req.query;
  const sequelize = getSequelize();

  const rows = await sequelize.query(
    `SELECT "encryptedData","messageCount","sizeBytes","completedAt"
     FROM message_backups WHERE "userId"=:userId${key ? ' AND "backupKey"=:key' : ''}
     ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId, key: key || null }, type: sequelize.QueryTypes.SELECT }
  );

  if (!rows?.length) return res.status(404).json({ status: 'error', message: 'No backup found' });

  const { encryptedData, messageCount, completedAt } = rows[0];
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="kynecta-backup-${userId}-${Date.now()}.kbk"`);
  res.send(encryptedData);
}));

// DELETE /api/devices/backup — delete backup
router.delete('/backup', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  await sequelize.query(
    `DELETE FROM message_backups WHERE "userId"=:userId`,
    { replacements: { userId } }
  );
  res.json({ status: 'success', message: 'Backup deleted' });
}));

module.exports = router;
