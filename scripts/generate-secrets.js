#!/usr/bin/env node
/**
 * generate-secrets.js
 * P1 FIX (Forensic Audit): generates new high-entropy secrets for
 * JWT_SECRET, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, and SESSION_SECRET.
 *
 * Usage:
 *   node scripts/generate-secrets.js
 *
 * This does NOT write to .env or any file — it only prints values to the
 * console. Copy these into your Render/host environment variable dashboard,
 * then restart the service. Rotating these will invalidate ALL existing JWTs
 * (every user will be logged out) and ALL active sessions.
 *
 * IMPORTANT: After rotating, also rotate your database password separately
 * via your hosting provider's dashboard (e.g. Render PostgreSQL) — this
 * script does not touch database credentials.
 */
const crypto = require('crypto');

function gen() {
  return crypto.randomBytes(64).toString('hex');
}

console.log('# P1 FIX: New high-entropy secrets — copy these into your environment variables.');
console.log('# Rotating these invalidates ALL existing JWTs and sessions (users will be logged out).');
console.log('');
console.log(`JWT_SECRET=${gen()}`);
console.log(`JWT_ACCESS_SECRET=${gen()}`);
console.log(`JWT_REFRESH_SECRET=${gen()}`);
console.log(`SESSION_SECRET=${gen()}`);
console.log('');
console.log('# Remember to also rotate DB_PASSWORD via your hosting provider dashboard.');
