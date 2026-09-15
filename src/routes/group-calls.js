'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../models');
const Chat = db.Chats || db.Chat;
const ChatParticipant = db.ChatParticipant;

// REST signaling is intentionally self-contained so group calls do not depend
// on the existing one-to-one call state machine. The media itself remains
// peer-to-peer WebRTC; this API only exchanges SDP/ICE and tracks membership.
// Rooms expire automatically. For a multi-instance deployment, replace the
// in-memory registry with Redis before running more than one backend instance.
const rooms = new Map();
const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
const SIGNAL_TTL_MS = 2 * 60 * 1000;
const MAX_SIGNAL_QUEUE = 500;

function uid(req) {
  return String(req.user?.userId || req.user?.id || '');
}

async function participant(chatId, userId) {
  if (!ChatParticipant) return null;
  return ChatParticipant.findOne({ where: { chatId, userId } });
}

async function groupAccess(chatId, userId) {
  const p = await participant(chatId, userId);
  if (!p) return null;
  if (!Chat) return p;
  const chat = await Chat.findByPk(chatId, { attributes: ['id', 'type', 'createdBy', 'name'] }).catch(() => null);
  if (!chat || chat.type !== 'group') return null;
  return { participant: p, chat };
}

function getRoom(callId) {
  const room = rooms.get(String(callId));
  if (!room) return null;
  if (room.expiresAt <= Date.now()) {
    rooms.delete(String(callId));
    return null;
  }
  return room;
}

function makeRoom(chatId, hostId, callType) {
  const callId = 'gcall_' + crypto.randomBytes(10).toString('hex');
  const room = {
    callId,
    chatId: String(chatId),
    hostId: String(hostId),
    callType: callType === 'video' ? 'video' : 'audio',
    createdAt: Date.now(),
    expiresAt: Date.now() + ROOM_TTL_MS,
    participants: new Map(),
    signals: [],
    sequence: 0,
    active: true,
  };
  rooms.set(callId, room);
  return room;
}

function publicRoom(room) {
  return {
    callId: room.callId,
    chatId: Number(room.chatId),
    hostId: room.hostId,
    callType: room.callType,
    active: room.active,
    createdAt: room.createdAt,
    participants: [...room.participants.values()].map(p => ({
      userId: p.userId,
      joinedAt: p.joinedAt,
      media: p.media,
    })),
  };
}

// Create a group call. Any current group member can start one.
router.post('/', async (req, res) => {
  try {
    const userId = uid(req);
    const chatId = String(req.body?.chatId || '');
    if (!userId || !chatId) return res.status(400).json({ success: false, message: 'chatId is required' });

    const access = await groupAccess(chatId, userId);
    if (!access) return res.status(403).json({ success: false, message: 'You are not a member of this group' });

    // Prevent one user from creating multiple simultaneous rooms for the same group.
    for (const room of rooms.values()) {
      if (room.active && room.chatId === chatId && room.participants.has(userId)) {
        return res.json({ success: true, room: publicRoom(room), existing: true });
      }
    }

    const room = makeRoom(chatId, userId, req.body?.callType);
    room.participants.set(userId, {
      userId,
      joinedAt: Date.now(),
      media: req.body?.callType === 'video' ? 'video' : 'audio',
    });

    return res.status(201).json({ success: true, room: publicRoom(room) });
  } catch (err) {
    console.error('[GroupCalls] create failed:', err.message);
    return res.status(500).json({ success: false, message: 'Unable to create group call' });
  }
});

router.get('/:callId', async (req, res) => {
  try {
    const userId = uid(req);
    const room = getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });

    const access = await groupAccess(room.chatId, userId);
    if (!access) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    if (!room.participants.has(userId)) return res.status(403).json({ success: false, message: 'Join the call first' });

    return res.json({ success: true, room: publicRoom(room) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Unable to load call' });
  }
});

router.post('/:callId/join', async (req, res) => {
  try {
    const userId = uid(req);
    const room = getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });

    const access = await groupAccess(room.chatId, userId);
    if (!access) return res.status(403).json({ success: false, message: 'You are not a member of this group' });

    if (room.participants.size >= 50 && !room.participants.has(userId)) {
      return res.status(409).json({ success: false, message: 'Group call is full' });
    }

    room.participants.set(userId, {
      userId,
      joinedAt: room.participants.get(userId)?.joinedAt || Date.now(),
      media: req.body?.media === 'video' ? 'video' : 'audio',
    });

    room.signals.push({
      id: ++room.sequence,
      from: userId,
      to: null,
      kind: 'participant-joined',
      data: { userId },
      createdAt: Date.now(),
    });

    return res.json({ success: true, room: publicRoom(room) });
  } catch (err) {
    console.error('[GroupCalls] join failed:', err.message);
    return res.status(500).json({ success: false, message: 'Unable to join group call' });
  }
});

router.post('/:callId/leave', async (req, res) => {
  try {
    const userId = uid(req);
    const room = getRoom(req.params.callId);
    if (!room) return res.json({ success: true });
    if (!room.participants.has(userId)) return res.json({ success: true });

    room.participants.delete(userId);
    room.signals.push({
      id: ++room.sequence,
      from: userId,
      to: null,
      kind: 'participant-left',
      data: { userId },
      createdAt: Date.now(),
    });

    if (room.hostId === userId && room.participants.size) {
      const next = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = next.userId;
      room.signals.push({
        id: ++room.sequence,
        from: 'server',
        to: null,
        kind: 'host-changed',
        data: { hostId: next.userId },
        createdAt: Date.now(),
      });
    }

    if (!room.participants.size) {
      room.active = false;
      rooms.delete(room.callId);
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Unable to leave call' });
  }
});

// SDP offer/answer and ICE candidate exchange. The server never inspects SDP.
router.post('/:callId/signals', async (req, res) => {
  try {
    const userId = uid(req);
    const room = getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });
    if (!room.participants.has(userId)) return res.status(403).json({ success: false, message: 'Not in this call' });

    const kind = String(req.body?.kind || '');
    const allowed = new Set(['offer', 'answer', 'ice-candidate', 'participant-joined', 'participant-left']);
    if (!allowed.has(kind)) return res.status(400).json({ success: false, message: 'Unsupported signal type' });

    const to = req.body?.to == null ? null : String(req.body.to);
    if (to && !room.participants.has(to)) return res.status(404).json({ success: false, message: 'Target is not in this call' });

    const data = req.body?.data;
    if (!data || typeof data !== 'object') return res.status(400).json({ success: false, message: 'Signal data is required' });

    // Keep signaling payloads bounded; this prevents accidental/hostile memory growth.
    const serialized = JSON.stringify(data);
    if (serialized.length > 200000) return res.status(413).json({ success: false, message: 'Signal payload too large' });

    const signal = {
      id: ++room.sequence,
      from: userId,
      to,
      kind,
      data,
      createdAt: Date.now(),
    };
    room.signals.push(signal);
    if (room.signals.length > MAX_SIGNAL_QUEUE) room.signals.splice(0, room.signals.length - MAX_SIGNAL_QUEUE);

    return res.status(201).json({ success: true, id: signal.id });
  } catch (err) {
    console.error('[GroupCalls] signal failed:', err.message);
    return res.status(500).json({ success: false, message: 'Unable to relay call signal' });
  }
});

router.get('/:callId/signals', async (req, res) => {
  try {
    const userId = uid(req);
    const room = getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });
    if (!room.participants.has(userId)) return res.status(403).json({ success: false, message: 'Not in this call' });

    const after = Number(req.query.after || 0);
    const now = Date.now();
    const signals = room.signals.filter(s =>
      s.id > after &&
      now - s.createdAt <= SIGNAL_TTL_MS &&
      s.from !== userId &&
      (!s.to || s.to === userId)
    );

    return res.json({ success: true, cursor: room.sequence, signals });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Unable to read call signals' });
  }
});

router.post('/:callId/end', async (req, res) => {
  try {
    const userId = uid(req);
    const room = getRoom(req.params.callId);
    if (!room) return res.json({ success: true });
    if (room.hostId !== userId) return res.status(403).json({ success: false, message: 'Only the call host can end the call' });
    room.active = false;
    rooms.delete(room.callId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Unable to end call' });
  }
});

// Reclaim stale in-memory rooms so a Render process cannot grow indefinitely.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) if (room.expiresAt <= now) rooms.delete(id);
}, 5 * 60 * 1000).unref?.();

module.exports = router;
