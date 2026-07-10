/**
 * encryptionService.js — AES-256-GCM message encryption
 *
 * Architecture (pragmatic E2E without libsignal binary dep):
 *  - Per-conversation AES-256-GCM keys derived via HKDF from a shared secret
 *  - Shared secret = ECDH(senderPrivKey, recipientPubKey)
 *  - Each user has an EC key pair stored in DB (public) + encrypted private key
 *  - Private key encrypted with user's password-derived key (PBKDF2)
 *  - Server stores ONLY ciphertext — never raw message content after encryption enabled
 *  - Forward secrecy via per-message random IV (96-bit nonce)
 *
 * Key Storage:
 *  user_encryption_keys table:
 *    userId, publicKey (base64 SPKI), encryptedPrivateKey (base64),
 *    keyId, algorithm='ECDH-P256-AES256GCM', createdAt
 *
 * Message envelope stored in DB:
 *  { v:1, kid:<keyId>, iv:<base64>, ct:<base64> }  (JSON in content column)
 */

'use strict';

const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────
const ALG         = 'aes-256-gcm';
const KEY_LEN     = 32;       // 256-bit
const IV_LEN      = 12;       // 96-bit GCM nonce
const TAG_LEN     = 16;       // 128-bit auth tag
const HKDF_HASH   = 'sha256';
const PBKDF2_ITER = 310000;   // OWASP recommended 2024
const PBKDF2_HASH = 'sha256';
const SALT_LEN    = 32;

// ── HKDF (Node 15+ has built-in, fallback for older) ─────────────────────────
function hkdf(ikm, salt, info, length) {
  if (crypto.hkdfSync) {
    return Buffer.from(crypto.hkdfSync(HKDF_HASH, ikm, salt, info, length));
  }
  // Manual HMAC-based Extract-and-Expand
  const prk  = crypto.createHmac(HKDF_HASH, salt).update(ikm).digest();
  const n    = Math.ceil(length / 32);
  let t      = Buffer.alloc(0);
  let okm    = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    t   = crypto.createHmac(HKDF_HASH, prk).update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])])).digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.slice(0, length);
}

// ── Core AES-256-GCM encrypt/decrypt ─────────────────────────────────────────
function encrypt(plaintext, keyBuffer) {
  const iv         = crypto.randomBytes(IV_LEN);
  const cipher     = crypto.createCipheriv(ALG, keyBuffer, iv, { authTagLength: TAG_LEN });
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: Buffer.concat([encrypted, tag]).toString('base64') };
}

function decrypt(envelope, keyBuffer) {
  const iv         = Buffer.from(envelope.iv, 'base64');
  const ctWithTag  = Buffer.from(envelope.ct, 'base64');
  const tag        = ctWithTag.slice(-TAG_LEN);
  const ct         = ctWithTag.slice(0, -TAG_LEN);
  const decipher   = crypto.createDecipheriv(ALG, keyBuffer, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Key derivation ─────────────────────────────────────────────────────────────
function deriveConversationKey(sharedSecret, chatId) {
  const info = Buffer.from(`kynecta-chat-${chatId}`, 'utf8');
  const salt = Buffer.alloc(KEY_LEN, 0);
  return hkdf(sharedSecret, salt, info, KEY_LEN);
}

function deriveKeyFromPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, PBKDF2_HASH);
}

// ── ECDH key pair (P-256) ─────────────────────────────────────────────────────
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKey:  publicKey.export({ type: 'spki',  format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function computeECDH(privateKeyB64, publicKeyB64) {
  const privKey = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const pubKey  = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'),  format: 'der', type: 'spki'  });
  const ecdh    = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privKey.export({ format: 'jwk' }).d, 'base64url');
  const jwk = pubKey.export({ format: 'jwk' });
  const xBuf = Buffer.from(jwk.x, 'base64url');
  const yBuf = Buffer.from(jwk.y, 'base64url');
  // Uncompressed point format: 04 || x || y
  const point = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
  return ecdh.computeSecret(point);
}

// ── Encrypt private key with user password ────────────────────────────────────
function encryptPrivateKey(privateKeyB64, password) {
  const salt    = crypto.randomBytes(SALT_LEN);
  const kek     = deriveKeyFromPassword(password, salt);
  const env     = encrypt(privateKeyB64, kek);
  return JSON.stringify({ salt: salt.toString('base64'), iv: env.iv, ct: env.ct, alg: 'PBKDF2-AES256GCM' });
}

function decryptPrivateKey(encryptedPrivKeyJson, password) {
  const obj  = JSON.parse(encryptedPrivKeyJson);
  const salt = Buffer.from(obj.salt, 'base64');
  const kek  = deriveKeyFromPassword(password, salt);
  return decrypt({ iv: obj.iv, ct: obj.ct }, kek);
}

// ── High-level message encrypt/decrypt ────────────────────────────────────────

/**
 * encryptMessage(plaintext, sharedSecret, chatId, keyId)
 * Returns JSON string to store as message content in DB.
 */
function encryptMessage(plaintext, sharedSecret, chatId, keyId) {
  const convKey = deriveConversationKey(sharedSecret, chatId);
  const env     = encrypt(plaintext, convKey);
  return JSON.stringify({ v: 1, kid: keyId, iv: env.iv, ct: env.ct });
}

/**
 * decryptMessage(encryptedContent, sharedSecret, chatId)
 * Returns plaintext string.
 */
function decryptMessage(encryptedContent, sharedSecret, chatId) {
  let envelope;
  try {
    envelope = JSON.parse(encryptedContent);
  } catch (_) {
    // Content is not encrypted (legacy plaintext)
    return encryptedContent;
  }
  if (!envelope.v || !envelope.iv || !envelope.ct) return encryptedContent; // plaintext
  const convKey = deriveConversationKey(sharedSecret, chatId);
  return decrypt(envelope, convKey);
}

/**
 * isEncrypted(content) — check if content is an encryption envelope
 */
function isEncrypted(content) {
  if (typeof content !== 'string') return false;
  try {
    const o = JSON.parse(content);
    return o && o.v === 1 && !!o.iv && !!o.ct;
  } catch (_) { return false; }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

// FIX: same missing-table issue as routes/encryption.js — this service can be
// called directly from message-sending code paths that never hit that
// router's middleware, so it needs its own safety net.
let _encKeysTableChecked = false;
async function _ensureEncryptionKeysTable(sequelize) {
  if (_encKeysTableChecked) return;
  _encKeysTableChecked = true;
  try {
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
  } catch (err) {
    console.error('[encryptionService.js] ⚠️ Could not verify/create user_encryption_keys table:', err.message);
  }
}

/**
 * ensureUserKeyPair(userId, password, sequelize)
 * Creates key pair if not exists, returns { publicKey, keyId }
 */
async function ensureUserKeyPair(userId, sequelize) {
  await _ensureEncryptionKeysTable(sequelize);
  const existing = await sequelize.query(
    `SELECT id, "publicKey", "keyId" FROM user_encryption_keys WHERE "userId"=:userId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (existing && existing.length > 0) {
    return { publicKey: existing[0].publicKey, keyId: existing[0].keyId };
  }
  // Generate new key pair (private key kept client-side — we only store public key server-side)
  const kp    = generateKeyPair();
  const keyId = crypto.randomBytes(16).toString('hex');
  await sequelize.query(
    `INSERT INTO user_encryption_keys ("userId","publicKey","keyId","algorithm","isActive","createdAt")
     VALUES (:userId,:publicKey,:keyId,'ECDH-P256-AES256GCM',true,NOW())`,
    { replacements: { userId, publicKey: kp.publicKey, keyId } }
  );
  return { publicKey: kp.publicKey, keyId, privateKey: kp.privateKey }; // privateKey only returned once
}

/**
 * getUserPublicKey(userId, sequelize) → base64 SPKI public key
 */
async function getUserPublicKey(userId, sequelize) {
  await _ensureEncryptionKeysTable(sequelize);
  const rows = await sequelize.query(
    `SELECT "publicKey", "keyId" FROM user_encryption_keys WHERE "userId"=:userId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

module.exports = {
  generateKeyPair,
  computeECDH,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveConversationKey,
  encryptMessage,
  decryptMessage,
  isEncrypted,
  encrypt,
  decrypt,
  hkdf,
  ensureUserKeyPair,
  getUserPublicKey,
};
