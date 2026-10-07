'use strict';
// =============================================================================
// utils/e2eEnvelope.js — server-side guard: client-originated 1:1 message
// content must be an end-to-end-encrypted envelope.
//
// WHY: the server never inspected content, so any client path that forgot to
// encrypt (service-worker quick-reply, a raw REST helper, an old cached build)
// silently stored/broadcast PLAINTEXT. Receivers then showed it unencrypted or
// failed to decrypt it. Rejecting at the transport boundary turns every such
// bypass into a loud, visible send failure instead of a silent leak.
//
// Accepted shape (what js/message-e2e-core.js and NecpraRatchet.java emit):
//   JSON object, integer v >= 1, string iv + string ct (v3 also needs hdr{}).
//
// Kill switch: set E2E_ALLOW_PLAINTEXT=1 on the server to disable enforcement.
// =============================================================================

// Encrypted envelopes carry base64 ciphertext + ephemeral keys, so they are
// larger than the plaintext. Never truncate them (a cut-off envelope is invalid
// JSON and can never be decrypted).
const MAX_ENVELOPE_CHARS = 200000;

function parseEnvelope(content) {
  if (typeof content !== 'string') return null;
  const t = content.trim();
  if (t.charCodeAt(0) !== 123 /* { */) return null;
  let o;
  try { o = JSON.parse(t); } catch (_) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (!Number.isInteger(o.v) || o.v < 1) return null;
  if (typeof o.iv === 'string' && o.iv && typeof o.ct === 'string' && o.ct) {
    if (o.v === 3 && (!o.hdr || typeof o.hdr !== 'object')) return null;
    return o;
  }
  if (o.devices && typeof o.devices === 'object') {
    const ok = Object.values(o.devices).some(d => d && typeof d.ct === 'string' && typeof d.iv === 'string');
    if (ok) return o;
  }
  return null;
}

function isEnvelope(content) { return !!parseEnvelope(content); }

function enforcementEnabled() {
  return String(process.env.E2E_ALLOW_PLAINTEXT || '') !== '1';
}

// Throws an Error carrying status 400 / code E2E_REQUIRED when content is
// non-empty and not an envelope. Empty content (attachment-only) is allowed.
function assertEncryptedContent(content) {
  if (!enforcementEnabled()) return;
  if (content === undefined || content === null || String(content).trim() === '') return;
  if (String(content).length > MAX_ENVELOPE_CHARS) {
    const e = new Error('Message is too large'); e.status = 413; e.code = 'MESSAGE_TOO_LARGE'; throw e;
  }
  if (!isEnvelope(content)) {
    const e = new Error('Message must be end-to-end encrypted before sending');
    e.status = 400; e.code = 'E2E_REQUIRED'; throw e;
  }
}

module.exports = { isEnvelope, parseEnvelope, assertEncryptedContent, MAX_ENVELOPE_CHARS, enforcementEnabled };
