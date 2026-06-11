'use strict';
/**
 * passwordUtils.js
 * P1 FIX (Forensic Audit): bcrypt silently truncates inputs longer than 72 bytes.
 * A user with a long passphrase (>72 bytes, e.g. many emoji/unicode chars or a
 * long passphrase) would have it silently truncated, weakening their effective
 * password and creating subtle hash-collision risk between long passwords that
 * share the same first 72 bytes.
 *
 * Fix: pre-hash the raw password with SHA-256 (base64) before handing it to
 * bcrypt. SHA-256 output is a fixed 44-char base64 string — always under the
 * 72-byte limit — while still being a strong, irreversible representation of
 * the original password. bcrypt.hash/compare then operate on this fixed-length
 * value, so bcrypt's own per-hash random salt + cost-factor-12 work factor
 * still apply on top.
 *
 * IMPORTANT: Use hashPassword/comparePassword consistently for ALL password
 * hashing and verification (register, login, reset-password, change-password)
 * so existing and new hashes stay compatible.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_COST = 12;

function _preHash(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest('base64');
}

async function hashPassword(plainPassword) {
  const preHashed = _preHash(plainPassword);
  return bcrypt.hash(preHashed, BCRYPT_COST);
}

// BACKWARD COMPATIBILITY: Existing users were hashed with the OLD scheme
// (bcrypt.hash(plainPassword, 12) directly — truncated at 72 bytes for long
// passwords). New hashes use the SHA-256 pre-hash scheme above. To avoid
// invalidating every existing password, comparePassword first tries the new
// (pre-hashed) scheme, and if that fails, falls back to comparing the raw
// plaintext directly against the stored hash (the old scheme). This means
// both old and new hashes continue to work for login.
async function comparePassword(plainPassword, storedHash) {
  if (!storedHash) return false;

  const preHashed = _preHash(plainPassword);
  if (await bcrypt.compare(preHashed, storedHash)) return true;

  // Fallback for hashes created before this fix
  return bcrypt.compare(String(plainPassword), storedHash);
}

module.exports = { hashPassword, comparePassword, BCRYPT_COST };
