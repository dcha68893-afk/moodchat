'use strict';
/**
 * pwnedPasswordCheck.js
 * P2 FIX (Forensic Audit): "Add common password check (HaveIBeenPwned k-anonymity API)"
 *
 * On register (and password reset/change), checks whether the chosen
 * password appears in known data breaches via the HaveIBeenPwned
 * Pwned Passwords API using k-anonymity (only the first 5 hex chars of the
 * SHA-1 hash are sent — the full password or hash never leaves the server).
 *
 * Fails OPEN: if the HIBP API is unreachable or slow, registration is NOT
 * blocked — this is a UX/security hardening feature, not a hard dependency.
 */
const crypto = require('crypto');

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3000;

/**
 * Returns { pwned: boolean, count: number, error?: string }
 */
async function checkPwnedPassword(password) {
  try {
    const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let resp;
    try {
      resp = await fetch(HIBP_RANGE_URL + prefix, {
        signal: controller.signal,
        headers: { 'Add-Padding': 'true' } // mitigates response-size side-channel
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      return { pwned: false, count: 0, error: `HIBP returned ${resp.status}` };
    }

    const body = await resp.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, countStr] = line.trim().split(':');
      if (hashSuffix && hashSuffix.toUpperCase() === suffix) {
        return { pwned: true, count: parseInt(countStr, 10) || 0 };
      }
    }
    return { pwned: false, count: 0 };
  } catch (err) {
    // Fail open — never block registration because of a third-party outage
    return { pwned: false, count: 0, error: err.message };
  }
}

module.exports = { checkPwnedPassword };
