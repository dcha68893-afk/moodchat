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

// POST /api/encryption/keys — register or update public key
router.post('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const { publicKey, keyId } = req.body;

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
  const previousActive = await sequelize.query(
    `SELECT "keyId" FROM user_encryption_keys WHERE "userId"=:userId AND "isActive"=true LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  const isRotation = !!(previousActive && previousActive.length && previousActive[0].keyId !== keyId);

  // Deactivate old keys
  await sequelize.query(
    `UPDATE user_encryption_keys SET "isActive"=false, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );

  // Insert new key
  await sequelize.query(
    `INSERT INTO user_encryption_keys ("userId","publicKey","keyId","algorithm","isActive","createdAt","updatedAt")
     VALUES (:userId,:publicKey,:keyId,'ECDH-P256-AES256GCM',true,NOW(),NOW())
     ON CONFLICT ("userId","keyId") DO UPDATE
       SET "publicKey"=:publicKey, "isActive"=true, "updatedAt"=NOW()`,
    { replacements: { userId, publicKey, keyId } }
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

// GET /api/encryption/keys/:userId — fetch another user's public key
//
// FIX-NEW-CHAT-KEY-403 (paired with the frontend's no-plaintext-fallback
// fix): this used to ONLY allow the fetch if a chat_participants row
// already existed between requester and target. That row is created the
// moment the first message is sent — so for a conversation started from
// Friends/Calls/Status (i.e. every brand-new chat), the very first attempt
// to fetch the recipient's key for that all-important first message had
// nothing to authorize against and got a 403. The frontend used to treat a
// 403 as "transient, retry a few times then give up and send in plaintext"
// — silently downgrading security for exactly the case (a first message to
// someone) where getting it right matters most. Now that the frontend
// waits indefinitely instead of giving up, a permanent 403 here would mean
// a new conversation's first message could never send at all. Fix the
// actual authorization gap instead of relying on the client to paper over
// it: an accepted friendship is real proof these two people are allowed to
// message each other, and — per this app's own flow — is a precondition
// for a Friends-list chat to exist in the first place. Allow either an
// existing shared chat OR an accepted friendship.
async function _canSeeEncryptionKey(requesterId, targetId, sequelize) {
  const [rel] = await sequelize.query(
    `SELECT 1 FROM chat_participants cp1
     JOIN chat_participants cp2 ON cp2."chatId"=cp1."chatId" AND cp2."userId"=:targetId
     WHERE cp1."userId"=:requesterId LIMIT 1`,
    { replacements: { requesterId, targetId } }
  );
  if (rel && rel.length > 0) return true;

  const [friend] = await sequelize.query(
    `SELECT 1 FROM friends
     WHERE status = 'accepted'
       AND ((requester_id = :requesterId AND receiver_id = :targetId)
         OR (requester_id = :targetId AND receiver_id = :requesterId))
     LIMIT 1`,
    { replacements: { requesterId, targetId } }
  );
  return !!(friend && friend.length > 0);
}

router.get('/keys/:userId', asyncHandler(async (req, res) => {
  const targetId  = parseInt(req.params.userId, 10);
  if (!targetId)  return res.status(400).json({ status: 'error', message: 'Invalid userId' });

  const sequelize = getSequelize();

  const authorized = await _canSeeEncryptionKey(req.user.id, targetId, sequelize);
  if (!authorized) {
    return res.status(403).json({ status: 'error', message: 'No shared conversation or friendship' });
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
  const { signingPubKey, signedPreKey, oneTimePreKeys } = req.body;

  if (!signingPubKey || typeof signingPubKey !== 'string') {
    return res.status(400).json({ status: 'error', message: 'signingPubKey required' });
  }
  if (!signedPreKey?.keyId || !signedPreKey?.publicKey || !signedPreKey?.signature) {
    return res.status(400).json({ status: 'error', message: 'signedPreKey {keyId, publicKey, signature} required' });
  }

  const sequelize = getSequelize();

  await sequelize.query(
    `INSERT INTO user_signed_prekeys ("userId","signingPubKey","signedPreKeyId","signedPreKey","signature","createdAt","updatedAt")
     VALUES (:userId,:signingPubKey,:keyId,:pubKey,:signature,NOW(),NOW())
     ON CONFLICT ("userId") DO UPDATE
       SET "signingPubKey"=:signingPubKey, "signedPreKeyId"=:keyId, "signedPreKey"=:pubKey,
           "signature"=:signature, "updatedAt"=NOW()`,
    { replacements: { userId, signingPubKey, keyId: signedPreKey.keyId, pubKey: signedPreKey.publicKey, signature: signedPreKey.signature } }
  );

  let inserted = 0;
  if (Array.isArray(oneTimePreKeys) && oneTimePreKeys.length > 0) {
    for (const otpk of oneTimePreKeys.slice(0, 200)) { // hard cap per request
      if (!otpk?.keyId || !otpk?.publicKey) continue;
      await sequelize.query(
        `INSERT INTO user_one_time_prekeys ("userId","keyId","publicKey","createdAt")
         VALUES (:userId,:keyId,:pubKey,NOW())
         ON CONFLICT ("userId","keyId") DO NOTHING`,
        { replacements: { userId, keyId: otpk.keyId, pubKey: otpk.publicKey } }
      );
      inserted++;
    }
  }

  res.status(201).json({ status: 'success', data: { signedPreKeyId: signedPreKey.keyId, oneTimePreKeysAdded: inserted } });
}));

// GET /api/encryption/prekeys/count — how many unconsumed one-time prekeys
// this user still has server-side, so the client knows when to top up.
router.get('/prekeys/count', asyncHandler(async (req, res) => {
  const sequelize = getSequelize();
  const rows = await sequelize.query(
    `SELECT COUNT(*)::int AS count FROM user_one_time_prekeys WHERE "userId"=:userId AND consumed=false`,
    { replacements: { userId: req.user.id }, type: sequelize.QueryTypes.SELECT }
  );
  res.json({ status: 'success', data: { count: rows?.[0]?.count ?? 0 } });
}));

// GET /api/encryption/prekeys/:userId — fetch a prekey bundle to start a new
// X3DH session with this user, atomically claiming (and permanently
// consuming) ONE of their one-time prekeys so it can never be reused for a
// second session. `FOR UPDATE SKIP LOCKED` makes the claim race-safe if two
// people start a session with this user at the same moment.
router.get('/prekeys/:userId', asyncHandler(async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return res.status(400).json({ status: 'error', message: 'Invalid userId' });

  const sequelize = getSequelize();

  // FIX-NEW-CHAT-KEY-403: same relationship-vs-friendship fix as /keys/:userId above.
  const authorized = await _canSeeEncryptionKey(req.user.id, targetId, sequelize);
  if (!authorized) {
    return res.status(403).json({ status: 'error', message: 'No shared conversation or friendship' });
  }

  const [identityRows, spkRows] = await Promise.all([
    sequelize.query(
      `SELECT "keyId","publicKey" FROM user_encryption_keys WHERE "userId"=:targetId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
      { replacements: { targetId }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT "signingPubKey","signedPreKeyId","signedPreKey","signature" FROM user_signed_prekeys WHERE "userId"=:targetId LIMIT 1`,
      { replacements: { targetId }, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  if (!identityRows?.length) {
    return res.json({ status: 'success', data: null, message: 'User has not enabled encryption' });
  }
  if (!spkRows?.length) {
    // Identity key exists but they haven't uploaded X3DH prekeys yet (e.g.
    // haven't logged in since this feature shipped) — caller should fall
    // back to identity-only session bootstrap.
    return res.json({ status: 'success', data: { identityKeyId: identityRows[0].keyId, identityPubKey: identityRows[0].publicKey, signingPubKey: null, signedPreKey: null, oneTimePreKey: null } });
  }

  // Atomically claim and consume one unused one-time prekey.
  const claimed = await sequelize.query(
    `UPDATE user_one_time_prekeys SET consumed=true, "consumedAt"=NOW(), "consumedBy"=:requesterId
     WHERE id = (
       SELECT id FROM user_one_time_prekeys
       WHERE "userId"=:targetId AND consumed=false
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING "keyId","publicKey"`,
    { replacements: { targetId, requesterId: req.user.id }, type: sequelize.QueryTypes.UPDATE }
  );
  const otpkRow = Array.isArray(claimed) && Array.isArray(claimed[0]) ? claimed[0][0] : (claimed?.[0] || null);

  const spk = spkRows[0];
  res.json({
    status: 'success',
    data: {
      identityKeyId: identityRows[0].keyId,
      identityPubKey: identityRows[0].publicKey,
      signingPubKey: spk.signingPubKey,
      signedPreKey: { keyId: spk.signedPreKeyId, publicKey: spk.signedPreKey, signature: spk.signature },
      oneTimePreKey: otpkRow ? { keyId: otpkRow.keyId, publicKey: otpkRow.publicKey } : null,
    },
  });
}));

module.exports = router;
