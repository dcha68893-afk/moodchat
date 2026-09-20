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
  const entries = (members || [])
    .map(m => `${String(m.userId ?? m.id)}:${String(m.role || 'member')}`)
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(entries.join(',')).digest('hex');
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
      lastEvent: null,
      history: [],
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
    lastEvent: state.lastEvent || null,
    history: Array.isArray(state.history) ? state.history : [],
  };
}

async function currentMembers(ChatParticipant, chatId) {
  const rows = await ChatParticipant.findAll({ where: { chatId }, attributes: ['userId', 'role'] });
  return rows.map(r => ({ userId: r.userId, role: r.role }));
}

async function emitMembershipEvent(chat, ChatParticipant, event) {
  try {
    const io = global.__socketIO;
    if (!io) return;
    const rows = await ChatParticipant.findAll({ where: { chatId: chat.id }, attributes: ['userId'] });
    const payload = { ...event };
    for (const row of rows) {
      io.to(`user:${row.userId}`).emit('group:security:membership_changed', payload);
      io.to(`user_${row.userId}`).emit('group:security:membership_changed', payload);
      io.to(`user:${row.userId}`).emit('GROUP_MEMBERSHIP_CHANGED', payload);
      io.to(`user_${row.userId}`).emit('GROUP_MEMBERSHIP_CHANGED', payload);
    }
  } catch (err) {
    console.warn('[groupEncryption] membership event broadcast failed:', err.message);
  }
}

/**
 * Immediately invalidates the current group key after a membership/role change.
 * The server never creates or receives the plaintext group key. It only
 * advances the version, clears old encrypted envelopes and records a signed
 * event. A client must generate the new key and POST fresh envelopes through
 * /group-encryption/:chatId/rotate before messages can use the new version.
 */
async function markMembershipChange(chat, ChatParticipant, changeType, actorId = null, targetUserId = null) {
  if (!chat || chat.type !== 'group') return null;

  const metadata = (chat.metadata && typeof chat.metadata === 'object') ? { ...chat.metadata } : {};
  const state = normalizeState(metadata);
  const members = await currentMembers(ChatParticipant, chat.id);
  const fingerprint = memberFingerprint(members);
  const nextVersion = Math.max(1, state.version + 1);
  const event = {
    type: 'group:membership_changed',
    groupId: String(chat.id),
    version: nextVersion,
    reason: String(changeType || 'membership_changed').slice(0, 120),
    actorId: actorId == null ? null : Number(actorId),
    targetUserId: targetUserId == null ? null : Number(targetUserId),
    memberFingerprint: fingerprint,
    timestamp: now(),
    eventSequence: state.eventSequence + 1,
  };

  state.version = nextVersion;
  state.memberFingerprint = fingerprint;
  // Preserve encrypted distributions for previous epochs. Old messages must
  // remain decryptable after a membership change; reading history never rotates.
  state.pendingRotation = true;
  state.reason = event.reason;
  state.updatedAt = event.timestamp;
  state.lastEvent = { ...event, signature: signEvent(event) };
  state.eventSequence = event.eventSequence;
  metadata.groupEncryption = state;
  await chat.update({ metadata, updatedAt: new Date() });

  await emitMembershipEvent(chat, ChatParticipant, state.lastEvent);
  return state.lastEvent;
}

async function reconcile(chat, ChatParticipant) {
  const metadata = (chat.metadata && typeof chat.metadata === 'object') ? { ...chat.metadata } : {};
  const state = normalizeState(metadata);
  const members = await currentMembers(ChatParticipant, chat.id);
  const fingerprint = memberFingerprint(members);

  if (state.memberFingerprint && state.memberFingerprint !== fingerprint) {
    return { state: await markMembershipChange(chat, ChatParticipant, 'membership_changed'), members };
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

  const previousVersion = Number(state.version) || 0;
  const previousAlgorithm = state.algorithm;
  const previousDistributions = Array.isArray(state.distributions) ? state.distributions : [];
  const history = Array.isArray(state.history) ? state.history.slice() : [];
  if (previousVersion > 0 && previousDistributions.length &&
      !history.some(h => Number(h?.version) === previousVersion)) {
    history.push({
      version: previousVersion,
      actorId: Number(state.lastEvent?.actorId) || null,
      algorithm: previousAlgorithm,
      distributions: previousDistributions,
      timestamp: state.lastRotationAt || state.updatedAt || event.timestamp,
    });
  }
  state.version = requestedVersion;
  state.algorithm = String(input.algorithm || state.algorithm || 'ECDH-P256-AES256GCM').slice(0, 64);
  state.memberFingerprint = fingerprint;
  history.push({ version: requestedVersion, actorId: Number(actorId), algorithm: state.algorithm, distributions: cleaned, timestamp: event.timestamp });
  state.history = history.filter((h,i,a)=>a.findIndex(x=>Number(x?.version)===Number(h?.version))===i).sort((a,b)=>Number(a.version)-Number(b.version)).slice(-50);
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
  currentMembers,
  reconcile,
  saveRotation,
  markMembershipChange,
  signEvent,
  verifyEvent,
};
