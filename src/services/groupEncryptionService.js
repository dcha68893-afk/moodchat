'use strict';

const crypto = require('crypto');

const MAX_DISTRIBUTIONS = 500;
const MAX_CIPHERTEXT = 64 * 1024;

function now() {
  return new Date().toISOString();
}

function signingSecret() {
  const secret = process.env.GROUP_ENCRYPTION_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('GROUP_ENCRYPTION_SIGNING_SECRET or JWT_SECRET must be configured with at least 32 characters');
  }
  return secret;
}

function signEvent(event) {
  return crypto.createHmac('sha256', signingSecret())
    .update(JSON.stringify(event))
    .digest('base64url');
}

function verifyEvent(event, signature) {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signEvent(event);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function memberFingerprint(members) {
  const ids = (members || [])
    .map(m => String(m.userId ?? m.id))
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(ids.join(',')).digest('hex');
}

function cleanDistribution(item) {
  if (!item || item.userId == null || !item.deviceId || !item.ciphertext) return null;
  if (typeof item.deviceId !== 'string' || item.deviceId.length > 128) return null;
  if (typeof item.ciphertext !== 'string' || item.ciphertext.length > MAX_CIPHERTEXT) return null;
  return {
    userId: Number(item.userId),
    deviceId: item.deviceId,
    ciphertext: item.ciphertext,
    nonce: typeof item.nonce === 'string' ? item.nonce.slice(0, 512) : null,
    ephemeralPublicKey: typeof item.ephemeralPublicKey === 'string' ? item.ephemeralPublicKey.slice(0, 2048) : null,
    algorithm: typeof item.algorithm === 'string' ? item.algorithm.slice(0, 64) : 'ECDH-P256-AES256GCM',
  };
}

function normalizeState(metadata) {
  const state = metadata?.groupEncryption;
  if (!state || typeof state !== 'object') {
    return {
      version: 0,
      algorithm: 'ECDH-P256-AES256GCM',
      memberFingerprint: null,
      distributions: [],
      pendingRotation: false,
      reason: null,
      updatedAt: null,
      lastRotationAt: null,
      eventSequence: 0,
    };
  }
  return {
    version: Number(state.version) || 0,
    algorithm: state.algorithm || 'ECDH-P256-AES256GCM',
    memberFingerprint: state.memberFingerprint || null,
    distributions: Array.isArray(state.distributions) ? state.distributions : [],
    pendingRotation: !!state.pendingRotation,
    reason: state.reason || null,
    updatedAt: state.updatedAt || null,
    lastRotationAt: state.lastRotationAt || null,
    eventSequence: Number(state.eventSequence) || 0,
  };
}

async function currentMembers(ChatParticipant, chatId) {
  const rows = await ChatParticipant.findAll({ where: { chatId }, attributes: ['userId'] });
  return rows.map(r => ({ userId: r.userId }));
}

async function reconcile(chat, ChatParticipant) {
  const metadata = (chat.metadata && typeof chat.metadata === 'object') ? { ...chat.metadata } : {};
  const state = normalizeState(metadata);
  const members = await currentMembers(ChatParticipant, chat.id);
  const fingerprint = memberFingerprint(members);

  if (state.memberFingerprint && state.memberFingerprint !== fingerprint) {
    state.version = Math.max(1, state.version + 1);
    state.pendingRotation = true;
    state.reason = 'membership_changed';
    state.distributions = [];
    state.eventSequence += 1;
    state.updatedAt = now();
    metadata.groupEncryption = state;
    await chat.update({ metadata, updatedAt: new Date() });
  } else if (!state.memberFingerprint) {
    state.memberFingerprint = fingerprint;
    state.updatedAt = now();
    metadata.groupEncryption = state;
    await chat.update({ metadata, updatedAt: new Date() });
  }

  return { state, members };
}

async function saveRotation(chat, ChatParticipant, actorId, input) {
  const metadata = (chat.metadata && typeof chat.metadata === 'object') ? { ...chat.metadata } : {};
  const state = normalizeState(metadata);
  const members = await currentMembers(ChatParticipant, chat.id);
  const fingerprint = memberFingerprint(members);
  const expectedVersion = state.version + 1;
  const requestedVersion = Number(input.version);

  if (!Number.isInteger(requestedVersion) || requestedVersion !== expectedVersion) {
    const err = new Error(`Invalid key version. Expected ${expectedVersion}.`);
    err.status = 409;
    throw err;
  }

  const allowedUsers = new Set(members.map(m => String(m.userId)));
  const distributions = Array.isArray(input.distributions) ? input.distributions.slice(0, MAX_DISTRIBUTIONS) : [];
  const cleaned = distributions.map(cleanDistribution).filter(Boolean);
  const invalid = cleaned.find(d => !allowedUsers.has(String(d.userId)));
  if (invalid) {
    const err = new Error('Key distribution contains a non-member');
    err.status = 403;
    throw err;
  }

  // The server stores only encrypted key envelopes. The actual group key must
  // be generated and encrypted by the client for each recipient device.
  const event = {
    type: 'group:key_rotated',
    groupId: String(chat.id),
    version: requestedVersion,
    reason: String(input.reason || state.reason || 'manual_rotation').slice(0, 120),
    actorId: Number(actorId),
    memberFingerprint: fingerprint,
    timestamp: now(),
    eventSequence: state.eventSequence + 1,
  };

  state.version = requestedVersion;
  state.algorithm = String(input.algorithm || state.algorithm || 'ECDH-P256-AES256GCM').slice(0, 64);
  state.memberFingerprint = fingerprint;
  state.distributions = cleaned;
  state.pendingRotation = false;
  state.reason = null;
  state.updatedAt = event.timestamp;
  state.lastRotationAt = event.timestamp;
  state.eventSequence = event.eventSequence;
  state.lastEvent = { ...event, signature: signEvent(event) };
  metadata.groupEncryption = state;
  await chat.update({ metadata, updatedAt: new Date() });

  return { state, event: state.lastEvent, members };
}

module.exports = {
  memberFingerprint,
  normalizeState,
  reconcile,
  saveRotation,
  signEvent,
  verifyEvent,
};
