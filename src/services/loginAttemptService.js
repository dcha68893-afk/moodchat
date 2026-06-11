'use strict';
/**
 * loginAttemptService.js
 * P1 FIX (Forensic Audit): "Account lockout tracked in-memory only (resets on
 * server restart)".
 *
 * Previously, failed login attempts were tracked in a plain JS `Map` inside
 * authController/auth.js. This meant:
 *   - A server restart (deploy, crash, scale event) instantly cleared every
 *     lockout, letting an attacker resume a brute-force attack.
 *   - In a multi-instance deployment, attempts on one instance were invisible
 *     to the others, making the 5-attempt limit easy to bypass by hitting
 *     different instances.
 *
 * Fix: store attempt counters in Redis (shared across restarts and instances)
 * with a TTL matching the lockout window. If Redis is unavailable, fall back
 * to the previous in-memory Map so login still functions (degraded but not
 * broken).
 */
const redisClient = require('../utils/redisClient');

const PREFIX = 'loginattempt:';
const WINDOW_SECONDS = 15 * 60; // 15 minutes
const MAX_ATTEMPTS = 5;

// In-memory fallback (used only if Redis is unavailable)
const memoryStore = new Map();

function _key(identifier, ip) {
  return `${PREFIX}${identifier}:${ip}`;
}

/**
 * Get current attempt count and whether the identifier/IP is currently locked.
 */
async function getAttempts(identifier, ip) {
  const key = _key(identifier, ip);

  const redisVal = await redisClient.get(key);
  if (redisVal !== null) {
    const count = parseInt(redisVal, 10) || 0;
    return { count, source: 'redis' };
  }

  // Redis unreachable or key not set — check memory fallback
  const mem = memoryStore.get(key);
  if (mem && mem.expiresAt > Date.now()) {
    return { count: mem.count, source: 'memory' };
  }
  return { count: 0, source: redisVal === null ? 'redis' : 'memory' };
}

/**
 * Record a failed login attempt. Returns the new attempt count.
 */
async function recordFailedAttempt(identifier, ip) {
  const key = _key(identifier, ip);

  // Try Redis INCR with expiry
  const current = await redisClient.get(key);
  if (current !== null || await redisClient.set(key, '1', WINDOW_SECONDS)) {
    if (current !== null) {
      const newCount = await redisClient.incr(key);
      return newCount;
    }
    return 1;
  }

  // Memory fallback
  const existing = memoryStore.get(key) || { count: 0, expiresAt: Date.now() + WINDOW_SECONDS * 1000 };
  existing.count += 1;
  existing.expiresAt = Date.now() + WINDOW_SECONDS * 1000;
  memoryStore.set(key, existing);
  return existing.count;
}

/**
 * Clear attempts on successful login.
 */
async function clearAttempts(identifier, ip) {
  const key = _key(identifier, ip);
  await redisClient.del(key);
  memoryStore.delete(key);
}

/**
 * Check whether the identifier/IP is currently locked out.
 * Returns { locked: boolean, remainingSeconds: number }
 */
async function checkLockout(identifier, ip) {
  const key = _key(identifier, ip);

  const redisVal = await redisClient.get(key);
  if (redisVal !== null) {
    const count = parseInt(redisVal, 10) || 0;
    if (count >= MAX_ATTEMPTS) {
      const ttl = await redisClient.ttl(key);
      return { locked: true, remainingSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    }
    return { locked: false, remainingSeconds: 0 };
  }

  const mem = memoryStore.get(key);
  if (mem && mem.expiresAt > Date.now() && mem.count >= MAX_ATTEMPTS) {
    return { locked: true, remainingSeconds: Math.ceil((mem.expiresAt - Date.now()) / 1000) };
  }
  return { locked: false, remainingSeconds: 0 };
}

// Periodic cleanup of expired memory-fallback entries
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of memoryStore.entries()) {
    if (val.expiresAt <= now) memoryStore.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = {
  getAttempts,
  recordFailedAttempt,
  clearAttempts,
  checkLockout,
  MAX_ATTEMPTS,
  WINDOW_SECONDS,
};
