'use strict';

const express = require('express');
const router = express.Router();
const db = require('../models');
const Chat = db.Chat;
const ChatParticipant = db.ChatParticipant;
const { reconcile, saveRotation, verifyEvent, normalizeState, currentMembers, memberFingerprint, computeMissingMemberIds } = require('../services/groupEncryptionService');

function uid(req) { return req.user?.userId || req.user?.id || req.user?.sub; }
async function loadGroup(chatId) {
  const chat = await Chat.findByPk(chatId);
  if (!chat || chat.type !== 'group' || chat.isActive === false) {
    const e = new Error('Group not found'); e.status = 404; throw e;
  }
  return chat;
}
async function membership(chatId, userId) {
  return ChatParticipant.findOne({ where: { chatId, userId } });
}
async function requireMember(chat, userId) {
  const p = await membership(chat.id, userId);
  if (!p) { const e = new Error('You are not a member of this group'); e.status = 403; throw e; }
  return p;
}
async function emitGroup(req, event, payload) {
  const io = req.io || global.__socketIO;
  if (!io) return;
  try {
    const ids = await ChatParticipant.findAll({ where: { chatId: payload.groupId }, attributes: ['userId'] });
    for (const row of ids) {
      io.to(`user:${row.userId}`).emit(event, payload);
      io.to(`user_${row.userId}`).emit(event, payload);
    }
  } catch (_) {}
}

// GET /api/group-encryption/:chatId/state
// Returns only encrypted envelopes. The server never returns a plaintext group key.
router.get('/:chatId/state', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    await requireMember(chat, uid(req));
    const { state, members } = await reconcile(chat, ChatParticipant);
    const myUserId = String(uid(req));
    const mine = state.distributions.filter(d => String(d.userId) === myUserId);
    // FIX (group messages not going through): rotation no longer waits for
    // every member to be reachable, so a version can be "current" while some
    // members still have no wrapped copy of it. Expose exactly who so (a)
    // any client that already holds the key can top up the stragglers via
    // POST /distribute without a full re-rotation, and (b) the UI can show
    // a small "some members can't read this yet" notice instead of nothing.
    const missingMemberIds = computeMissingMemberIds(state, members);
    return res.json({
      success: true,
      data: {
        groupId: chat.id,
        version: state.version,
        algorithm: state.algorithm,
        pendingRotation: state.pendingRotation,
        reason: state.reason,
        eventSequence: state.eventSequence,
        memberCount: members.length,
        distributions: mine,
<<<<<<< HEAD
        missingMemberIds,
=======
>>>>>>> origin/main
        history: (Array.isArray(state.history) ? state.history : [])
          .map(h => ({
            version:Number(h.version),
            actorId:Number(h.actorId)||null,
            algorithm:h.algorithm||state.algorithm,
            distributions:Array.isArray(h.distributions) ? h.distributions.filter(d => String(d?.userId) === myUserId) : [],
            timestamp:h.timestamp||null,
          }))
          .filter(h => h.distributions.length > 0),
        lastEvent: state.lastEvent || null,
        updatedAt: state.updatedAt,
        lastRotationAt: state.lastRotationAt,
      },
    });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// POST /api/group-encryption/:chatId/rotate
// Client supplies one encrypted envelope per recipient device. The server
// stores ciphertext only and advances the group key version atomically from
// the current metadata state. Rotation is required after membership changes.
router.post('/:chatId/rotate', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    const participant = await requireMember(chat, actor);
    const { state, members } = await reconcile(chat, ChatParticipant);

    if (state.pendingRotation === false && Number(req.body?.version) <= state.version) {
      return res.status(409).json({ success: false, message: 'A newer group key version is already active', currentVersion: state.version });
    }

    const result = await saveRotation(chat, ChatParticipant, actor, req.body || {});
    const payload = {
      groupId: chat.id,
      version: result.state.version,
      algorithm: result.state.algorithm,
      reason: result.event.reason,
      actorId: Number(actor),
      eventSequence: result.event.eventSequence,
      memberCount: members.length,
      event: result.event,
      timestamp: result.event.timestamp,
    };
    await emitGroup(req, 'group:key_rotated', payload);
    await emitGroup(req, 'GROUP_KEY_ROTATED', payload);
    return res.status(201).json({ success: true, data: payload });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message, currentVersion: e.currentVersion });
  }
});

// POST /api/group-encryption/:chatId/ack
// Devices acknowledge that they have installed a key version. Acknowledgements
// are deliberately not used to expose key material.
router.post('/:chatId/ack', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    await requireMember(chat, actor);
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) return res.status(400).json({ success: false, message: 'Valid key version is required' });
    const metadata = (chat.metadata && typeof chat.metadata === 'object') ? { ...chat.metadata } : {};
    const state = metadata.groupEncryption && typeof metadata.groupEncryption === 'object' ? { ...metadata.groupEncryption } : null;
    if (!state || version > Number(state.version || 0)) return res.status(409).json({ success: false, message: 'Unknown group key version' });
    const acks = Array.isArray(state.acks) ? state.acks.slice() : [];
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.slice(0, 128) : 'primary';
    const entry = { userId: Number(actor), deviceId, version, acknowledgedAt: new Date().toISOString() };
    const filtered = acks.filter(a => !(String(a.userId) === String(actor) && String(a.deviceId) === deviceId));
    filtered.push(entry);
    state.acks = filtered.slice(-1000);
    state.updatedAt = entry.acknowledgedAt;
    metadata.groupEncryption = state;
    await chat.update({ metadata, updatedAt: new Date() });
    return res.json({ success: true, data: entry });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// POST /api/group-encryption/:chatId/distribute
// Tops up the CURRENT key version with wrapped copies for members who were
// unreachable at rotation time. Does not advance the version and does not
// require the requester to be the original rotation actor — any member who
// already holds the current key (proven by them already having their own
// distribution entry for it) can run this once a straggler's public key
// becomes available. Existing entries are never overwritten by this route.
router.post('/:chatId/distribute', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    await requireMember(chat, actor);
    const { state, members } = await reconcile(chat, ChatParticipant);

    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ success: false, message: 'Valid key version is required' });
    }
    if (version !== Number(state.version)) {
      return res.status(409).json({ success: false, message: 'That key version is no longer current', currentVersion: state.version });
    }
    const actorHasKey = state.distributions.some(d => String(d.userId) === String(actor));
    if (!actorHasKey) {
      return res.status(403).json({ success: false, message: 'You do not hold this key version yet, so you cannot distribute it' });
    }

    const allowedUsers = new Set(members.map(m => String(m.userId)));
    const haveAlready = new Set(state.distributions.map(d => String(d.userId)));
    const incoming = Array.isArray(req.body?.distributions) ? req.body.distributions.slice(0, 500) : [];
    const cleaned = incoming.map(d => cleanDistribution(d, actor)).filter(Boolean);
    const invalid = cleaned.find(d => !allowedUsers.has(String(d.userId)));
    if (invalid) {
      return res.status(403).json({ success: false, message: 'Key distribution contains a non-member' });
    }
    // Only ever ADD missing members here — never replace an existing
    // member's wrapped key with a new one from this route.
    const additions = cleaned.filter(d => !haveAlready.has(String(d.userId)));
    // De-dupe within this single request too (last one wins per userId).
    const byUser = new Map();
    for (const d of additions) byUser.set(String(d.userId), d);
    const toAdd = [...byUser.values()];
    if (!toAdd.length) {
      return res.json({ success: true, data: { groupId: chat.id, version, added: [] } });
    }

    const metadata = { ...(chat.metadata && typeof chat.metadata === 'object' ? chat.metadata : {}) };
    const liveState = normalizeState(metadata);
    // Re-check the version is still current under the metadata we're about
    // to write (guards a rotate() that landed between reconcile() and now).
    if (Number(liveState.version) !== version) {
      return res.status(409).json({ success: false, message: 'That key version is no longer current', currentVersion: liveState.version });
    }
    liveState.distributions = [...liveState.distributions, ...toAdd];
    liveState.updatedAt = new Date().toISOString();
    metadata.groupEncryption = liveState;
    await chat.update({ metadata, updatedAt: new Date() });

    const payload = { groupId: chat.id, version, addedUserIds: toAdd.map(d => d.userId), distributorId: Number(actor) };
    await emitGroup(req, 'group:key_distributed', payload);
    return res.json({ success: true, data: { ...payload, added: toAdd.map(d => d.userId) } });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// GET /api/group-encryption/:chatId/event/:sequence
// Allows a member/device to validate the signed membership/key event before
// applying it locally. The signature is HMAC-backed by a server secret.
router.get('/:chatId/event/:sequence', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    await requireMember(chat, uid(req));
    const state = chat.metadata?.groupEncryption;
    const event = state?.lastEvent;
    if (!event || Number(event.eventSequence) !== Number(req.params.sequence)) return res.status(404).json({ success: false, message: 'Group security event not found' });
    const { signature, ...unsigned } = event;
    return res.json({ success: true, data: { event: unsigned, signature, valid: verifyEvent(unsigned, signature) } });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

module.exports = router;
