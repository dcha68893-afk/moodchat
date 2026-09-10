/**
 * encryption.js — Encryption key management routes
 *
 * POST /api/encryption/keys          — Register/update user's public key
 * GET  /api/encryption/keys/:userId  — Fetch a user's public key
 * GET  /api/encryption/keys          — Get own key info
 * DELETE /api/encryption/keys        — Revoke own key (logout/key rotation)
 * GET  /api/encryption/safety/:userId — Get safety numbers with another user
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('express-async-handler');

function getSequelize() { return require('../models/index').sequelize; }

// ── AUTO-MIGRATION: create user_encryption_keys table if it doesn't exist ───
// FIX: same class of bug as linked_devices in routes/devices.js — there is no
// Sequelize model and no migration file anywhere in this codebase that
// creates this table, yet every route below queries it directly via raw SQL.
let _encKeysMigrated = false;
async function ensureEncryptionKeysTable() {
  if (_encKeysMigrated) return;
  _encKeysMigrated = true;
  try {
    const sequelize = getSequelize();
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS user_encryption_keys (
        id                    SERIAL PRIMARY KEY,
        "userId"              INTEGER NOT NULL,
        "publicKey"           TEXT NOT NULL,
        "encryptedPrivateKey" TEXT,
        "keyId"               VARCHAR(64) NOT NULL,
        algorithm             VARCHAR(50) NOT NULL DEFAULT 'ECDH-P256-AES256GCM',
        "isActive"            BOOLEAN NOT NULL DEFAULT true,
        "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_encryption_keys_user_key_unique UNIQUE ("userId", "keyId")
      );
    `);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS user_encryption_keys_user_active_idx ON user_encryption_keys ("userId", "isActive");`);
    console.log('[encryption.js] ✅ user_encryption_keys table verified/created');
  } catch (err) {
    console.error('[encryption.js] ⚠️ Could not verify/create user_encryption_keys table:', err.message);
  }
}
let _encKeysReady = ensureEncryptionKeysTable();

// ── X3DH PREKEYS: signing identity key + signed prekey + one-time prekeys ──
// FIX (X3DH-UPGRADE): the 1:1 ratchet handshake (js/double-ratchet.js) used
// to bootstrap a session from nothing but each side's long-term identity
// key (a simplified 2-DH combine). That means anyone who later steals a
// user's long-term identity private key could retroactively decrypt the
// FIRST message of every past 1:1 conversation that user was ever part of
// (every message after the first is still protected by the ratchet itself).
// Real X3DH — a separate signing identity key, a rotating signed prekey
// (proves the DH key really belongs to this identity), and a pool of
// one-time prekeys (each used for at most one session, then discarded) —
// closes that gap the same way Signal's protocol does. This table pair
// stores the public halves; private halves never leave the client.
let _prekeysMigrated = false;
async function ensurePrekeyTables() {
  if (_prekeysMigrated) return;
  _prekeysMigrated = true;
  try {
    const sequelize = getSequelize();
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS user_signed_prekeys (
        "userId"         INTEGER PRIMARY KEY,
        "signingPubKey"  TEXT NOT NULL,
        "signedPreKeyId" VARCHAR(64) NOT NULL,
        "signedPreKey"   TEXT NOT NULL,
        "signature"      TEXT NOT NULL,
        "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS user_one_time_prekeys (
        id            SERIAL PRIMARY KEY,
        "userId"      INTEGER NOT NULL,
        "keyId"       VARCHAR(64) NOT NULL,
        "publicKey"   TEXT NOT NULL,
        consumed      BOOLEAN NOT NULL DEFAULT false,
        "consumedAt"  TIMESTAMPTZ,
        "consumedBy"  INTEGER,
        "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_one_time_prekeys_user_key_unique UNIQUE ("userId", "keyId")
      );
    `);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS user_otpk_unconsumed_idx ON user_one_time_prekeys ("userId") WHERE consumed = false;`);
    console.log('[encryption.js] ✅ prekey tables verified/created');
  } catch (err) {
    console.error('[encryption.js] ⚠️ Could not verify/create prekey tables:', err.message);
  }
}
let _prekeysReady = ensurePrekeyTables();
router.use((req, res, next) => { _prekeysReady.then(() => next()).catch(() => next()); });
router.use((req, res, next) => { _encKeysReady.then(() => next()).catch(() => next()); });

// ── PHASE 2 (MULTI-DEVICE): user_devices registry + deviceId-scoped prekeys ─
// FIX (SINGLE-DEVICE-ONLY): every table above was keyed on userId alone —
// one identity key, one signed prekey, one one-time-prekey pool PER USER,
// not per device. That's fine for "one browser, one session" but means a
// second device (or even a second browser on the same account) either
// silently overwrote the first device's identity key (ON CONFLICT
// ("userId") DO UPDATE in user_signed_prekeys) or fought over the same
// one-time prekey pool — neither device could reliably decrypt what was
// sent to the other. Real multi-device (Signal/WhatsApp linked devices)
// gives EACH device its own identity/signed-prekey/one-time-prekey set, and
// a sender fans a message out to every one of the recipient's active
// devices individually. This block adds that additively:
//   - user_devices: the registry of a user's active devices
//   - "deviceId" column added to the existing prekey tables (default
//     'primary', backward-compatible: an old client that never sends
//     deviceId keeps behaving exactly as it does today, scoped to the
//     implicit 'primary' device)
// ADD COLUMN ... DEFAULT is safe/non-blocking on modern Postgres (11+):
// existing rows are backfilled with the default without a table rewrite.
let _devicesMigrated = false;
async function ensureDeviceTables() {
  if (_devicesMigrated) return;
  _devicesMigrated = true;
  try {
    const sequelize = getSequelize();
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS user_devices (
        id            SERIAL PRIMARY KEY,
        "userId"      INTEGER NOT NULL,
        "deviceId"    VARCHAR(64) NOT NULL,
        "deviceName"  VARCHAR(120),
        platform      VARCHAR(40),
        active        BOOLEAN NOT NULL DEFAULT true,
        "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "lastSeenAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_devices_user_device_unique UNIQUE ("userId", "deviceId")
      );
    `);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS user_devices_active_idx ON user_devices ("userId") WHERE active = true;`);

    // Backward-compatible deviceId columns on the existing per-user tables.
    await sequelize.query(`ALTER TABLE user_encryption_keys ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(64) NOT NULL DEFAULT 'primary';`);
    await sequelize.query(`ALTER TABLE user_signed_prekeys  ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(64) NOT NULL DEFAULT 'primary';`);
    await sequelize.query(`ALTER TABLE user_one_time_prekeys ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(64) NOT NULL DEFAULT 'primary';`);

    // user_signed_prekeys originally had userId as its sole primary key —
    // one row per user. Multi-device needs one row per (user, device). If
    // the old single-column primary key is still in place, replace it with
    // a composite one; a fresh deploy of this file creates the composite
    // key directly (see ensurePrekeyTables — left as-is above on purpose,
    // this migration only runs the ALTER on a database that already has
    // the old shape).
    await sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'user_signed_prekeys' AND constraint_type = 'PRIMARY KEY'
            AND constraint_name = 'user_signed_prekeys_pkey'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.key_column_usage
          WHERE table_name = 'user_signed_prekeys' AND column_name = 'deviceId'
            AND constraint_name = 'user_signed_prekeys_pkey'
        ) THEN
          ALTER TABLE user_signed_prekeys DROP CONSTRAINT user_signed_prekeys_pkey;
          ALTER TABLE user_signed_prekeys ADD CONSTRAINT user_signed_prekeys_pkey PRIMARY KEY ("userId", "deviceId");
        END IF;
      END $$;
    `);

    console.log('[encryption.js] ✅ multi-device tables verified/created');
  } catch (err) {
    console.error('[encryption.js] ⚠️ Could not verify/create multi-device tables:', err.message);
  }
}
let _devicesReady = ensureDeviceTables();
router.use((req, res, next) => { _devicesReady.then(() => next()).catch(() => next()); });

// ── FIX (KEY-ANNOUNCEMENT / ITEM 5,6,7 — WebSocket key push): previously the
// only way another user's client ever learned about a public key was a REST
// GET the moment IT needed to encrypt/decrypt something — there was no push
// path at all. That means (a) a friend who had just registered their very
// first key stayed invisible to you until you happened to open/send to them
// again, and (b) a friend who rotated their key (new device, cleared
// storage, reinstall) left every other client silently encrypting against a
// now-stale cached key until a decrypt failure forced a re-fetch. Push both
// events over the socket to everyone currently authorized to see this key —
// the same "accepted friend" relationship /keys/:userId already gates reads
// on (see _canSeeEncryptionKey above) — the instant registration succeeds.
async function _getFriendIds(userId, sequelize) {
  const rows = await sequelize.query(
    `SELECT CASE WHEN requester_id = :userId THEN receiver_id ELSE requester_id END AS "friendId"
     FROM friends
     WHERE status = 'accepted' AND (requester_id = :userId OR receiver_id = :userId)`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  return (rows || []).map(r => r.friendId).filter(Boolean);
}

async function _broadcastKeyEvent(userId, eventName, data, sequelize) {
  let wsService;
  try { wsService = require('../services/webSocketService'); } catch (_) { return; }
  if (!wsService || typeof wsService.sendToUser !== 'function') return;

  const payload = { userId, ...data, timestamp: Date.now() };

  // The owner's own other devices/tabs — so a second logged-in session
  // treats the freshly (re)registered key as canonical too.
  try { await wsService.sendToUser(userId, eventName, payload); } catch (_) {}

  let friendIds = [];
  try { friendIds = await _getFriendIds(userId, sequelize); } catch (e) {
    console.warn('[encryption.js] _broadcastKeyEvent: friend lookup failed:', e.message);
  }
  for (const fid of friendIds) {
    try { await wsService.sendToUser(fid, eventName, payload); } catch (_) {}
  }
}

// POST /api/encryption/devices — register or "touch" (update lastSeenAt of)
// one of the caller's own devices. deviceId is client-generated and stable
// per browser/install (see js/e2e-store-v2.js's getOrCreateDeviceId()) —
// the server never invents or reassigns it.
router.post('/devices', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { deviceId, deviceName, platform } = req.body;
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ status: 'error', message: 'deviceId required' });
  }
  const sequelize = getSequelize();
  await sequelize.query(
    `INSERT INTO user_devices ("userId","deviceId","deviceName",platform,active,"createdAt","lastSeenAt")
     VALUES (:userId,:deviceId,:deviceName,:platform,true,NOW(),NOW())
     ON CONFLICT ("userId","deviceId") DO UPDATE
       SET "deviceName"=COALESCE(:deviceName, user_devices."deviceName"),
           platform=COALESCE(:platform, user_devices.platform),
           active=true, "lastSeenAt"=NOW()`,
    { replacements: { userId, deviceId, deviceName: deviceName || null, platform: platform || null } }
  );
  res.status(201).json({ status: 'success', data: { deviceId } });
}));

// GET /api/encryption/devices/:userId — list another user's active devices,
// so a sender knows how many sub-envelopes to fan a message out to. Gated
// by the same authorization as key/prekey access — a device list otherwise
// leaks nothing sensitive (no keys), but it's still account metadata.
router.get('/devices/:userId', asyncHandler(async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return res.status(400).json({ status: 'error', message: 'Invalid userId' });
  const sequelize = getSequelize();
  const authorized = await _canSeeEncryptionKey(req.user.id, targetId, sequelize);
  if (!authorized) return res.status(403).json({ status: 'error', message: 'No shared conversation or friendship' });
  const rows = await sequelize.query(
    `SELECT "deviceId","deviceName",platform,"lastSeenAt" FROM user_devices WHERE "userId"=:targetId AND active=true ORDER BY "lastSeenAt" DESC`,
    { replacements: { targetId }, type: sequelize.QueryTypes.SELECT }
  );
  // A user who has never registered under the multi-device scheme still has
  // exactly one implicit device: 'primary' — keeps fan-out logic correct
  // for accounts that haven't touched /devices yet.
  const devices = (rows && rows.length) ? rows : [{ deviceId: 'primary', deviceName: null, platform: null, lastSeenAt: null }];
  res.json({ status: 'success', data: { devices } });
}));

// DELETE /api/encryption/devices/:deviceId — unlink one of the CALLER's own
// devices (e.g. "remove this device" in settings after losing a phone).
// Deliberately cannot target another user's device.
router.delete('/devices/:deviceId', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { deviceId } = req.params;
  const sequelize = getSequelize();
  await sequelize.query(
    `UPDATE user_devices SET active=false WHERE "userId"=:userId AND "deviceId"=:deviceId`,
    { replacements: { userId, deviceId } }
  );
  res.json({ status: 'success', message: 'Device unlinked' });
}));


router.post('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const { publicKey, keyId, deviceId: rawDeviceId, encryptedPrivateKey } = req.body;
  const deviceId = (typeof rawDeviceId === 'string' && rawDeviceId) || 'primary';

  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ status: 'error', message: 'publicKey required' });
  }
  if (!keyId || typeof keyId !== 'string') {
    return res.status(400).json({ status: 'error', message: 'keyId required' });
  }

  const sequelize = getSequelize();

  // FIX (KEY-ANNOUNCEMENT): look up whatever was active BEFORE this write so
  // we can tell friends whether this is a brand-new identity (e2e:key_available)
  // or a rotation replacing a key they may already have cached
  // (e2e:key_rotated) — the two need different client-side handling (a
  // rotation should also purge any stale cached key derived from the old
  // one; see js/e2e-encryption.js's _handleKeyAnnouncement).
  // FIX (MULTI-DEVICE-KEY-CLOBBER): scoped to this deviceId only now — this
  // used to look up (and, below, deactivate) ALL of the user's keys, so a
  // second device registering its own identity key silently deactivated the
  // first device's key too. Each device's identity key is independent.
  // ROOT-CAUSE FIX (CROSS-DEVICE-KEY-AMBIGUITY / persistent "Unable to
  // decrypt this message"): GET /keys/:userId and GET /keys/batch below —
  // the only lookups every peer ever uses to decide which public key to
  // encrypt a NEW message against — are intentionally NOT scoped by
  // deviceId; they just take whichever row is "isActive"=true with the
  // newest createdAt for that userId. The DM identity model on the client
  // (e2e-identity-core.js) is not multi-device-aware either: each
  // browser/device generates and keeps its own single keypair in
  // localStorage, with no cross-device sync or per-device message fan-out
  // (message-e2e-core.js encrypts once, to one derived key). Scoping
  // deactivation to :deviceId here — as this used to do — let two
  // devices/browsers for the SAME account (a second browser, an
  // incognito/cleared-storage session, a reinstall) both hold
  // "isActive"=true rows for that user at once. GET /keys/:userId would
  // then arbitrarily pick whichever was registered more recently, which is
  // very often NOT the device the account is actually chatting from right
  // now — any message a peer encrypts against "the other" device's key is
  // then permanently undecryptable here, no retry can fix it, and it looks
  // exactly like a real, persistent decrypt failure (distinct from the
  // separate silent-plaintext-send bug fixed in message-client.js, which
  // only explains messages that were never encrypted at all). Fixed by
  // deactivating EVERY previously active key for this user on each new
  // registration, regardless of device, so there is always exactly one
  // unambiguous active DM key per user — matching what GET /keys/:userId's
  // un-scoped single-row query already assumes. This does not touch the
  // separate X3DH prekey/device tables (user_signed_prekeys/
  // user_one_time_prekeys/user_devices), which remain unused by the 1:1 DM
  // path per the Sep 9 2026 architecture audit.
  const previousActive = await sequelize.query(
    `SELECT "keyId" FROM user_encryption_keys WHERE "userId"=:userId AND "isActive"=true LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  const isRotation = !!(previousActive && previousActive.length && previousActive[0].keyId !== keyId);

  // Deactivate every previously active key for this user, across ALL
  // devices — see comment above for why per-device scoping here was wrong.
  await sequelize.query(
    `UPDATE user_encryption_keys SET "isActive"=false, "updatedAt"=NOW() WHERE "userId"=:userId AND "isActive"=true`,
    { replacements: { userId } }
  );

  // Insert new key
  //
  // ROOT-CAUSE FIX (MULTI-DEVICE-CANNOT-DECRYPT-OLD-MESSAGES): the
  // "encryptedPrivateKey" column has existed on this table since it was
  // first created, but nothing ever wrote to it — each device generated its
  // own ECDH keypair locally (js/e2e-encryption.js's init()) and only ever
  // persisted the wrapped private key in THAT BROWSER's localStorage. A
  // second device (or the same device after storage was cleared) had no way
  // to recover the first device's private key, so it minted a brand-new
  // identity instead — every message previously encrypted against the old
  // device's public key (i.e. the entire prior chat history) became
  // permanently undecryptable there, exactly matching the reported "switch
  // devices, every old chat says Unable to decrypt". Accepting and storing
  // the caller's own password-wrapped private key here (still opaque
  // ciphertext to the server — see js/e2e-encryption.js's
  // _encryptPrivateKey/_decryptPrivateKey, AES-256-GCM under a
  // PBKDF2-derived key that never leaves the client) lets a new device pull
  // the SAME identity back down via GET /identity-backup below instead of
  // generating a replacement.
  await sequelize.query(
    `INSERT INTO user_encryption_keys ("userId","deviceId","publicKey","keyId","encryptedPrivateKey","algorithm","isActive","createdAt","updatedAt")
     VALUES (:userId,:deviceId,:publicKey,:keyId,:encryptedPrivateKey,'ECDH-P256-AES256GCM',true,NOW(),NOW())
     ON CONFLICT ("userId","keyId") DO UPDATE
       SET "publicKey"=:publicKey,
           "encryptedPrivateKey"=COALESCE(:encryptedPrivateKey, user_encryption_keys."encryptedPrivateKey"),
           "isActive"=true, "updatedAt"=NOW()`,
    { replacements: { userId, deviceId, publicKey, keyId, encryptedPrivateKey: encryptedPrivateKey || null } }
  );

  // Fire-and-forget: never let a slow/failed socket push delay or fail the
  // HTTP response the registering client is waiting on to confirm E2E_READY.
  _broadcastKeyEvent(
    userId,
    isRotation ? 'e2e:key_rotated' : 'e2e:key_available',
    { publicKey, keyId },
    sequelize
  ).catch(() => {});

  res.status(201).json({ status: 'success', data: { keyId }, message: 'Public key registered' });
}));

// GET /api/encryption/keys — own key info
router.get('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  const rows      = await sequelize.query(
    `SELECT "keyId","publicKey","createdAt" FROM user_encryption_keys
     WHERE "userId"=:userId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.json({ status: 'success', data: null });
  }
  res.json({ status: 'success', data: rows[0] });
}));

// GET /api/encryption/identity-backup — the caller's own most recent
// password-wrapped private key blob (see the ROOT-CAUSE FIX comment on
// POST /keys above), so a new/cleared device can restore the SAME DM
// identity instead of generating a replacement one. Deliberately scoped to
// req.user.id only — this must never be reachable for any other userId, and
// takes the newest row that actually has a backup on file (an older device
// registered before this fix shipped won't have one; that's a normal
// "nothing to restore" case, not an error). The client still needs the
// correct password/wrap-secret to decrypt what's returned — the server
// never sees the plaintext private key.
router.get('/identity-backup', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  const rows      = await sequelize.query(
    `SELECT "keyId","publicKey","encryptedPrivateKey" FROM user_encryption_keys
     WHERE "userId"=:userId AND "encryptedPrivateKey" IS NOT NULL
     ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.json({ status: 'success', data: null });
  }
  res.json({ status: 'success', data: rows[0] });
}));

// GET /api/encryption/keys/:userId — fetch another user's public key
//
// FIX-NEW-CHAT-KEY-403 (paired with the frontend's no-plaintext-fallback
// fix): this used to ONLY allow the fetch if a chat_participants row
// already existed between requester and target. That row is created the
// moment the first message is sent — so for a conversation started from
// Friends/Calls/Status (i.e. every brand-new chat), the very first attempt
// to fetch the recipient's key for that all-important first message had
// nothing to authorize against and got a 403. A later fix (still visible in
// git history) narrowed this to "existing shared chat OR accepted
// friendship" — but that still 403's the very common case of messaging or
// calling someone you've discovered but aren't yet friends with, which is
// an explicitly supported flow in this app (Discovery lets you open a chat/
// call with any user, friend or not). Per product decision: messaging and
// calling are allowed between ANY two users regardless of friend status —
// the only thing that should still deny key access is an actual block
// (friends.status = 'blocked' in either direction), since a block is a
// deliberate "do not contact me" signal and should keep working even
// though the general friend requirement is gone.
async function _canSeeEncryptionKey(requesterId, targetId, sequelize) {
  if (requesterId === targetId) return true;

  const [blocked] = await sequelize.query(
    `SELECT 1 FROM friends
     WHERE status = 'blocked'
       AND ((requester_id = :requesterId AND receiver_id = :targetId)
         OR (requester_id = :targetId AND receiver_id = :requesterId))
     LIMIT 1`,
    { replacements: { requesterId, targetId } }
  );
  return !(blocked && blocked.length > 0);
}

// GET /api/encryption/keys/batch?userIds=1,2,3 — fetch several users' public
// keys in one round trip.
//
// FIX (LOGIN-TIME-KEY-WARMUP): decryption was only ever fetching a
// recipient's key lazily — the first time a chat with them was opened —
// which meant every cold app start (or a device that had its localStorage
// cleared) needed a live network round trip, one at a time, before ANY
// message from a given contact could be decrypted. Real messaging apps
// (Signal, WhatsApp) resolve this by fetching + caching every known
// contact's identity key once, right after login, so later decrypts never
// wait on the network at all unless the contact is genuinely new. This
// route is the batch primitive the frontend's login-time warmup (see
// message-client.js's loadConversations()) calls with every existing
// conversation's other-participant id in a single request instead of N
// separate /keys/:userId calls. Registered BEFORE /keys/:userId so the
// literal path 'batch' is never swallowed by that route's :userId param.
router.get('/keys/batch', asyncHandler(async (req, res) => {
  const raw = String(req.query.userIds || '');
  const ids = Array.from(new Set(
    raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0)
  )).slice(0, 200); // cap — this is a warmup convenience call, not a directory dump
  if (!ids.length) return res.json({ status: 'success', data: {} });

  const sequelize = getSequelize();
  const authorizedIds = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    if (await _canSeeEncryptionKey(req.user.id, id, sequelize)) authorizedIds.push(id);
  }
  if (!authorizedIds.length) return res.json({ status: 'success', data: {} });

  const rows = await sequelize.query(
    `SELECT DISTINCT ON ("userId") "userId","keyId","publicKey" FROM user_encryption_keys
     WHERE "userId" IN (:ids) AND "isActive"=true ORDER BY "userId","createdAt" DESC`,
    { replacements: { ids: authorizedIds }, type: sequelize.QueryTypes.SELECT }
  );
  const data = {};
  for (const row of rows) data[row.userId] = { keyId: row.keyId, publicKey: row.publicKey };
  res.json({ status: 'success', data });
}));

router.get('/keys/:userId', asyncHandler(async (req, res) => {
  const targetId  = parseInt(req.params.userId, 10);
  if (!targetId)  return res.status(400).json({ status: 'error', message: 'Invalid userId' });

  const sequelize = getSequelize();

  const authorized = await _canSeeEncryptionKey(req.user.id, targetId, sequelize);
  if (!authorized) {
    return res.status(403).json({ status: 'error', message: 'You cannot message this user' });
  }

  const rows = await sequelize.query(
    `SELECT "keyId","publicKey","createdAt" FROM user_encryption_keys
     WHERE "userId"=:targetId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { targetId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.json({ status: 'success', data: null, message: 'User has not enabled encryption' });
  }
  res.json({ status: 'success', data: rows[0] });
}));

// GET /api/encryption/keys/:userId/version/:keyId — fetch a SPECIFIC
// historical public key for a user, regardless of whether it is still the
// active one.
//
// FIX (HISTORICAL-KEY-LOOKUP): every v2 message envelope carries `kid` —
// the exact keyId that was active on the sender's side at encryption time
// — but until now the server could only answer "give me whatever key is
// active right now" (the route above), never "give me key <keyId>
// specifically". If the sender has since rotated keys (new device,
// reinstall, cleared storage), that "current key" answer is the WRONG key
// for an older message and AES-GCM auth on it fails.
//
// Rows are never deleted on rotation — POST /keys above sets
// "isActive"=false, it does not DELETE — so every keyId a user has ever
// registered is still here. This route lets a client resolve the EXACT key
// that authenticated a given ciphertext instead of gambling on whatever
// happens to be current. Gated by the same authorization as the
// current-key route; a specific historical key is exactly as sensitive as
// the current one.
router.get('/keys/:userId/version/:keyId', asyncHandler(async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  const { keyId } = req.params;
  if (!targetId) return res.status(400).json({ status: 'error', message: 'Invalid userId' });
  if (!keyId || typeof keyId !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Invalid keyId' });
  }

  const sequelize = getSequelize();
  const authorized = await _canSeeEncryptionKey(req.user.id, targetId, sequelize);
  if (!authorized) {
    return res.status(403).json({ status: 'error', message: 'You cannot message this user' });
  }

  const rows = await sequelize.query(
    `SELECT "keyId","publicKey","createdAt","isActive" FROM user_encryption_keys
     WHERE "userId"=:targetId AND "keyId"=:keyId LIMIT 1`,
    { replacements: { targetId, keyId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.json({ status: 'success', data: null, message: 'That key version is not on record for this user' });
  }
  res.json({ status: 'success', data: rows[0] });
}));

// DELETE /api/encryption/keys — revoke own key
router.delete('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  await sequelize.query(
    `UPDATE user_encryption_keys SET "isActive"=false, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );
  res.json({ status: 'success', message: 'Encryption keys revoked' });
}));

// GET /api/encryption/safety/:userId — safety number fingerprint
router.get('/safety/:userId', asyncHandler(async (req, res) => {
  const myId      = req.user.id;
  const theirId   = parseInt(req.params.userId, 10);
  const sequelize = getSequelize();

  const [myKey, theirKey] = await Promise.all([
    sequelize.query(
      `SELECT "publicKey","keyId" FROM user_encryption_keys WHERE "userId"=:uid AND "isActive"=true LIMIT 1`,
      { replacements: { uid: myId }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT "publicKey","keyId" FROM user_encryption_keys WHERE "userId"=:uid AND "isActive"=true LIMIT 1`,
      { replacements: { uid: theirId }, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  if (!myKey?.length || !theirKey?.length) {
    return res.json({ status: 'success', data: null, message: 'One or both users have not enabled encryption' });
  }

  // Deterministic ordering for consistent safety numbers
  const a = myKey[0].publicKey;
  const b = theirKey[0].publicKey;
  const combined = a < b ? a + b : b + a;
  const hash = require('crypto').createHash('sha256').update(combined).digest('hex');
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(hash.slice(i * 4, i * 4 + 4).toUpperCase());

  res.json({ status: 'success', data: { fingerprint: groups.join(' '), hex: hash.toUpperCase() } });
}));


// POST /api/encryption/verify/:userId
router.post('/verify/:userId', asyncHandler(async (req, res) => {
  const { fingerprint } = req.body;
  const sequelize = getSequelize();
  try {
    await sequelize.query(`CREATE TABLE IF NOT EXISTS key_verifications (id SERIAL PRIMARY KEY,"verifierId" INTEGER NOT NULL,"verifiedId" INTEGER NOT NULL,fingerprint TEXT NOT NULL,"verifiedAt" TIMESTAMPTZ DEFAULT NOW(),"updatedAt" TIMESTAMPTZ DEFAULT NOW(),UNIQUE("verifierId","verifiedId"))`,{type:sequelize.QueryTypes.RAW});
    await sequelize.query(`INSERT INTO key_verifications ("verifierId","verifiedId",fingerprint,"verifiedAt","updatedAt") VALUES (:vid,:rid,:fp,NOW(),NOW()) ON CONFLICT ("verifierId","verifiedId") DO UPDATE SET fingerprint=EXCLUDED.fingerprint,"updatedAt"=NOW()`,{replacements:{vid:req.user.id,rid:parseInt(req.params.userId,10),fp:fingerprint}});
    res.json({status:'success'});
  } catch(e) { res.status(500).json({status:'error'}); }
}));

// POST /api/encryption/prekeys — upload/replace signing identity key, signed
// prekey (with its signature), and top up the one-time prekey pool.
// FIX (X3DH-UPGRADE): see ensurePrekeyTables() above for why this exists.
router.post('/prekeys', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { signingPubKey, signedPreKey, oneTimePreKeys, deviceId: rawDeviceId } = req.body;
  const deviceId = (typeof rawDeviceId === 'string' && rawDeviceId) || 'primary';

  if (!signingPubKey || typeof signingPubKey !== 'string') {
    return res.status(400).json({ status: 'error', message: 'signingPubKey required' });
  }
  if (!signedPreKey?.keyId || !signedPreKey?.publicKey || !signedPreKey?.signature) {
    return res.status(400).json({ status: 'error', message: 'signedPreKey {keyId, publicKey, signature} required' });
  }

  const sequelize = getSequelize();

  await sequelize.query(
    `INSERT INTO user_signed_prekeys ("userId","deviceId","signingPubKey","signedPreKeyId","signedPreKey","signature","createdAt","updatedAt")
     VALUES (:userId,:deviceId,:signingPubKey,:keyId,:pubKey,:signature,NOW(),NOW())
     ON CONFLICT ("userId","deviceId") DO UPDATE
       SET "signingPubKey"=:signingPubKey, "signedPreKeyId"=:keyId, "signedPreKey"=:pubKey,
           "signature"=:signature, "updatedAt"=NOW()`,
    { replacements: { userId, deviceId, signingPubKey, keyId: signedPreKey.keyId, pubKey: signedPreKey.publicKey, signature: signedPreKey.signature } }
  );

  let inserted = 0;
  if (Array.isArray(oneTimePreKeys) && oneTimePreKeys.length > 0) {
    for (const otpk of oneTimePreKeys.slice(0, 200)) { // hard cap per request
      if (!otpk?.keyId || !otpk?.publicKey) continue;
      await sequelize.query(
        `INSERT INTO user_one_time_prekeys ("userId","deviceId","keyId","publicKey","createdAt")
         VALUES (:userId,:deviceId,:keyId,:pubKey,NOW())
         ON CONFLICT ("userId","keyId") DO NOTHING`,
        { replacements: { userId, deviceId, keyId: otpk.keyId, pubKey: otpk.publicKey } }
      );
      inserted++;
    }
  }

  // Registering prekeys is also proof-of-life for the device — touch it so
  // it shows up for fan-out without needing a separate /devices call first.
  await sequelize.query(
    `INSERT INTO user_devices ("userId","deviceId",active,"createdAt","lastSeenAt")
     VALUES (:userId,:deviceId,true,NOW(),NOW())
     ON CONFLICT ("userId","deviceId") DO UPDATE SET active=true, "lastSeenAt"=NOW()`,
    { replacements: { userId, deviceId } }
  ).catch(() => {});

  res.status(201).json({ status: 'success', data: { deviceId, signedPreKeyId: signedPreKey.keyId, oneTimePreKeysAdded: inserted } });
}));

// GET /api/encryption/prekeys/count — how many unconsumed one-time prekeys
// this user still has server-side, so the client knows when to top up.
// ?deviceId= scopes to one device; omitted defaults to 'primary' (matches
// pre-multi-device client behavior exactly).
router.get('/prekeys/count', asyncHandler(async (req, res) => {
  const sequelize = getSequelize();
  const deviceId = (typeof req.query.deviceId === 'string' && req.query.deviceId) || 'primary';
  const rows = await sequelize.query(
    `SELECT COUNT(*)::int AS count FROM user_one_time_prekeys WHERE "userId"=:userId AND "deviceId"=:deviceId AND consumed=false`,
    { replacements: { userId: req.user.id, deviceId }, type: sequelize.QueryTypes.SELECT }
  );
  res.json({ status: 'success', data: { count: rows?.[0]?.count ?? 0 } });
}));

// GET /api/encryption/prekeys/:userId — fetch a prekey bundle to start a new
// X3DH session with ONE specific device of this user (?deviceId=, default
// 'primary' — unchanged behavior for clients that don't know about
// multi-device yet), atomically claiming (and permanently consuming) ONE of
// that device's one-time prekeys.
router.get('/prekeys/:userId', asyncHandler(async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return res.status(400).json({ status: 'error', message: 'Invalid userId' });
  const deviceId = (typeof req.query.deviceId === 'string' && req.query.deviceId) || 'primary';

  const sequelize = getSequelize();

  // FIX-NEW-CHAT-KEY-403: same relationship-vs-friendship fix as /keys/:userId above.
  const authorized = await _canSeeEncryptionKey(req.user.id, targetId, sequelize);
  if (!authorized) {
    return res.status(403).json({ status: 'error', message: 'No shared conversation or friendship' });
  }

  const [identityRows, spkRows] = await Promise.all([
    sequelize.query(
      `SELECT "keyId","publicKey" FROM user_encryption_keys WHERE "userId"=:targetId AND "deviceId"=:deviceId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
      { replacements: { targetId, deviceId }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT "signingPubKey","signedPreKeyId","signedPreKey","signature" FROM user_signed_prekeys WHERE "userId"=:targetId AND "deviceId"=:deviceId LIMIT 1`,
      { replacements: { targetId, deviceId }, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  if (!identityRows?.length) {
    return res.json({ status: 'success', data: null, message: 'User has not enabled encryption on this device' });
  }
  if (!spkRows?.length) {
    // Identity key exists but they haven't uploaded X3DH prekeys yet (e.g.
    // haven't logged in since this feature shipped) — caller should fall
    // back to identity-only session bootstrap.
    return res.json({ status: 'success', data: { identityKeyId: identityRows[0].keyId, identityPubKey: identityRows[0].publicKey, signingPubKey: null, signedPreKey: null, oneTimePreKey: null } });
  }

  // Atomically claim and consume one unused one-time prekey FROM THIS DEVICE.
  const claimed = await sequelize.query(
    `UPDATE user_one_time_prekeys SET consumed=true, "consumedAt"=NOW(), "consumedBy"=:requesterId
     WHERE id = (
       SELECT id FROM user_one_time_prekeys
       WHERE "userId"=:targetId AND "deviceId"=:deviceId AND consumed=false
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING "keyId","publicKey"`,
    { replacements: { targetId, deviceId, requesterId: req.user.id }, type: sequelize.QueryTypes.UPDATE }
  );
  const otpkRow = Array.isArray(claimed) && Array.isArray(claimed[0]) ? claimed[0][0] : (claimed?.[0] || null);

  const spk = spkRows[0];
  res.json({
    status: 'success',
    data: {
      deviceId,
      identityKeyId: identityRows[0].keyId,
      identityPubKey: identityRows[0].publicKey,
      signingPubKey: spk.signingPubKey,
      signedPreKey: { keyId: spk.signedPreKeyId, publicKey: spk.signedPreKey, signature: spk.signature },
      oneTimePreKey: otpkRow ? { keyId: otpkRow.keyId, publicKey: otpkRow.publicKey } : null,
    },
  });
}));

module.exports = router;
