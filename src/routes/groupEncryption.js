'use strict';

const express = require('express');
const router = express.Router();
const db = require('../models');
const Chat = db.Chat;
const ChatParticipant = db.ChatParticipant;
const { reconcile, saveRotation, verifyEvent } = require('../services/groupEncryptionService');

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
