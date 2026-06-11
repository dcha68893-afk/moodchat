'use strict';
/**
 * tokenBlacklistService.js
 * P1 FIX (Forensic Audit): "No token blacklist for access tokens"
 *
 * Problem: JWT access tokens are stateless and valid for up to 24h. Logout
 * only revoked the *refresh* token in the DB — the access token the user
 * already holds remained valid (and usable for impersonation) until its
 * natural expiry, even after logout.
 *
 * Fix: On logout, store SHA-256(accessToken) in Redis with a TTL equal to
 * the token's remaining lifetime (decoded `exp` - now). The auth middleware
 * checks this blacklist on every request and rejects blacklisted tokens
 * with 401, even if the JWT signature itself is still valid.
 *
 * Fails open (does not block requests) if Redis is unavailable, matching
 * the existing graceful-degradation pattern used by redisClient — but logs
 * a warning so operators are aware logout-side revocation is degraded.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const redisClient = require('../utils/redisClient');

const PREFIX = 'blacklist:access:';

function _hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Blacklist an access token until its natural expiry.
 * @param {string} token - the raw JWT access token
 */
async function blacklistAccessToken(token) {
  if (!token) return false;

  let ttlSeconds = 24 * 60 * 60; // fallback: max access token lifetime
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.exp) {
      const remaining = decoded.exp - Math.floor(Date.now() / 1000);
      if (remaining > 0) ttlSeconds = remaining;
      else return true; // already expired, nothing to do
    }
  } catch (_) {
    // keep fallback TTL
  }

  const key = PREFIX + _hashToken(token);
  const ok = await redisClient.set(key, '1', ttlSeconds);
  if (!ok) {
    console.warn('[TokenBlacklist] Redis unavailable — access token NOT blacklisted on logout');
  }
  return ok;
}

/**
 * Check whether an access token has been blacklisted (i.e. user logged out).
 * @param {string} token - the raw JWT access token
 * @returns {Promise<boolean>}
 */
async function isAccessTokenBlacklisted(token) {
  if (!token) return false;
  const key = PREFIX + _hashToken(token);
  const value = await redisClient.get(key);
  return value !== null;
}

module.exports = { blacklistAccessToken, isAccessTokenBlacklisted };
