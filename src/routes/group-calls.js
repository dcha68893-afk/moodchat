'use strict';

const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');
const router = express.Router();

const db = require('../models');
const Chat = db.Chats || db.Chat;
const ChatParticipant = db.ChatParticipant;

// Group media remains WebRTC peer-to-peer. Redis stores only ephemeral call
// control/signaling state so any backend instance can serve the next request.
// This removes the previous single-process Map limitation.
const ROOM_TTL_SEC = 4 * 60 * 60;
const SIGNAL_TTL_MS = 2 * 60 * 1000;
const MAX_SIGNAL_QUEUE = 500;
const MAX_PARTICIPANTS = 50;
const redisUrl = String(process.env.REDIS_URL || process.env.REDIS_TLS_URL || '').trim();
let redis = null;

if (redisUrl) {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  redis.on('error', err => console.error('[GroupCalls] Redis error:', err.message));
}

// Development/test fallback only. Production with more than one instance must
// provide REDIS_URL so all instances share call state.
const memoryRooms = new Map();

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

function key(callId) { return `group-call:${String(callId)}`; }
function signalKey(callId) { return `group-call:${String(callId)}:signals`; }

async function redisReady() {
  if (!redis) return false;
  try {
    if (redis.status === 'wait') await redis.connect();
    return redis.status === 'ready';
  } catch (_) {
    return false;
  }
}

function normalizeRoom(room) {
  if (!room) return null;
  room.participants = room.participants && typeof room.participants === 'object' ? room.participants : {};
  room.signals = undefined;
  return room;
}

async function getRoom(callId) {
  if (await redisReady()) {
    const raw = await redis.get(key(callId));
    if (!raw) return null;
    try {
      const room = JSON.parse(raw);
      if (Number(room.expiresAt) <= Date.now() || room.active === false) {
        await redis.del(key(callId), signalKey(callId));
        return null;
      }
      return normalizeRoom(room);
    } catch (_) {
      await redis.del(key(callId), signalKey(callId));
      return null;
    }
  }
  const room = memoryRooms.get(String(callId));
  if (!room || room.expiresAt <= Date.now()) {
    memoryRooms.delete(String(callId));
    return null;
  }
  return normalizeRoom({ ...room, participants: { ...room.participants } });
}

async function saveRoom(room) {
  const value = JSON.stringify({ ...room, signals: undefined });
  if (await redisReady()) {
    await redis.set(key(room.callId), value, 'EX', ROOM_TTL_SEC);
  } else {
    memoryRooms.set(String(room.callId), { ...room, participants: { ...room.participants } });
  }
}

async function deleteRoom(callId) {
  if (await redisReady()) await redis.del(key(callId), signalKey(callId));
  memoryRooms.delete(String(callId));
}

async function appendSignal(callId, signal) {
  if (await redisReady()) {
    const k = signalKey(callId);
    await redis.rpush(k, JSON.stringify(signal));
    await redis.ltrim(k, -MAX_SIGNAL_QUEUE, -1);
    await redis.expire(k, Math.ceil(SIGNAL_TTL_MS / 1000));
    return;
  }
  const room = memoryRooms.get(String(callId));
  if (!room) return;
  room.signals = Array.isArray(room.signals) ? room.signals : [];
  room.signals.push(signal);
  if (room.signals.length > MAX_SIGNAL_QUEUE) room.signals.splice(0, room.signals.length - MAX_SIGNAL_QUEUE);
  memoryRooms.set(String(callId), room);
}

async function readSignals(callId) {
  if (await redisReady()) {
    const rows = await redis.lrange(signalKey(callId), 0, -1);
    return rows.map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean);
  }
  return memoryRooms.get(String(callId))?.signals || [];
}

function makeRoom(chatId, hostId, callType) {
  return {
    callId: 'gcall_' + crypto.randomBytes(10).toString('hex'),
    chatId: String(chatId),
    hostId: String(hostId),
    callType: callType === 'video' ? 'video' : 'audio',
    createdAt: Date.now(),
    expiresAt: Date.now() + ROOM_TTL_SEC * 1000,
    participants: {},
    sequence: 0,
    active: true,
  };
}

function publicRoom(room) {
  return {
    callId: room.callId,
    chatId: Number(room.chatId),
    hostId: room.hostId,
    callType: room.callType,
    active: room.active,
    createdAt: room.createdAt,
    participants: Object.values(room.participants || {}).map(p => ({
      userId: p.userId,
      joinedAt: p.joinedAt,
      media: p.media,
    })),
  };
}

// Create a group call. Any current member can start one.
router.post('/', async (req, res) => {
  try {
    const userId = uid(req);
    const chatId = String(req.body?.chatId || '');
    if (!userId || !chatId) return res.status(400).json({ success: false, message: 'chatId is required' });
    const access = await groupAccess(chatId, userId);
    if (!access) return res.status(403).json({ success: false, message: 'You are not a member of this group' });

    const roomIdList = [];
    // The call id is unknown before creation; scan is intentionally avoided in
    // Redis mode. A short-lived group index keeps the lookup distributed.
    if (await redisReady()) {
      const ids = await redis.smembers(`group-call:index:${chatId}`);
      for (const id of ids) {
        const existing = await getRoom(id);
        if (existing?.active && existing.participants?.[userId]) {
          return res.json({ success: true, room: publicRoom(existing), existing: true });
        }
        roomIdList.push(id);
      }
      if (roomIdList.length) await redis.srem(`group-call:index:${chatId}`, ...roomIdList);
    } else {
      for (const existing of memoryRooms.values()) {
        if (existing.active && existing.chatId === chatId && existing.participants?.[userId]) {
          return res.json({ success: true, room: publicRoom(existing), existing: true });
        }
      }
    }

    const room = makeRoom(chatId, userId, req.body?.callType);
    room.participants[userId] = { userId, joinedAt: Date.now(), media: room.callType === 'video' ? 'video' : 'audio' };
    await saveRoom(room);
    if (await redisReady()) {
      await redis.sadd(`group-call:index:${chatId}`, room.callId);
      await redis.expire(`group-call:index:${chatId}`, ROOM_TTL_SEC);
    }
    return res.status(201).json({ success: true, room: publicRoom(room) });
  } catch (err) {
    console.error('[GroupCalls] create failed:', err.message);
    return res.status(500).json({ success: false, message: 'Unable to create group call' });
  }
});

router.get('/:callId', async (req, res) => {
  try {
    const userId = uid(req);
    const room = await getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });
    const access = await groupAccess(room.chatId, userId);
    if (!access) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    if (!room.participants?.[userId]) return res.status(403).json({ success: false, message: 'Join the call first' });
    return res.json({ success: true, room: publicRoom(room) });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Unable to load call' });
  }
});

router.post('/:callId/join', async (req, res) => {
  try {
    const userId = uid(req);
    const room = await getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });
    const access = await groupAccess(room.chatId, userId);
    if (!access) return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    const count = Object.keys(room.participants || {}).length;
    if (count >= MAX_PARTICIPANTS && !room.participants[userId]) return res.status(409).json({ success: false, message: 'Group call is full' });

    room.participants[userId] = { userId, joinedAt: room.participants[userId]?.joinedAt || Date.now(), media: req.body?.media === 'video' ? 'video' : 'audio' };
    room.sequence += 1;
    await saveRoom(room);
    await appendSignal(room.callId, { id: room.sequence, from: userId, to: null, kind: 'participant-joined', data: { userId }, createdAt: Date.now() });
    return res.json({ success: true, room: publicRoom(room) });
  } catch (err) {
    console.error('[GroupCalls] join failed:', err.message);
    return res.status(500).json({ success: false, message: 'Unable to join group call' });
  }
});

router.post('/:callId/leave', async (req, res) => {
  try {
    const userId = uid(req);
    const room = await getRoom(req.params.callId);
    if (!room || !room.participants?.[userId]) return res.json({ success: true });
    delete room.participants[userId];
    room.sequence += 1;
    await appendSignal(room.callId, { id: room.sequence, from: userId, to: null, kind: 'participant-left', data: { userId }, createdAt: Date.now() });

    const remaining = Object.values(room.participants);
    if (room.hostId === userId && remaining.length) {
      remaining.sort((a, b) => a.joinedAt - b.joinedAt);
      room.hostId = remaining[0].userId;
      room.sequence += 1;
      await appendSignal(room.callId, { id: room.sequence, from: 'server', to: null, kind: 'host-changed', data: { hostId: room.hostId }, createdAt: Date.now() });
    }
    if (!remaining.length) {
      room.active = false;
      await deleteRoom(room.callId);
    } else {
      await saveRoom(room);
    }
    return res.json({ success: true });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Unable to leave call' });
  }
});

router.post('/:callId/signals', async (req, res) => {
  try {
    const userId = uid(req);
    const room = await getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });
    if (!room.participants?.[userId]) return res.status(403).json({ success: false, message: 'Not in this call' });

    const kind = String(req.body?.kind || '');
    const allowed = new Set(['offer', 'answer', 'ice-candidate', 'participant-joined', 'participant-left']);
    if (!allowed.has(kind)) return res.status(400).json({ success: false, message: 'Unsupported signal type' });
    const to = req.body?.to == null ? null : String(req.body.to);
    if (to && !room.participants?.[to]) return res.status(404).json({ success: false, message: 'Target is not in this call' });
    const data = req.body?.data;
    if (!data || typeof data !== 'object') return res.status(400).json({ success: false, message: 'Signal data is required' });
    if (JSON.stringify(data).length > 200000) return res.status(413).json({ success: false, message: 'Signal payload too large' });

    room.sequence += 1;
    const signal = { id: room.sequence, from: userId, to, kind, data, createdAt: Date.now() };
    await saveRoom(room);
    await appendSignal(room.callId, signal);
    return res.status(201).json({ success: true, id: signal.id });
  } catch (err) {
    console.error('[GroupCalls] signal failed:', err.message);
    return res.status(500).json({ success: false, message: 'Unable to relay call signal' });
  }
});

router.get('/:callId/signals', async (req, res) => {
  try {
    const userId = uid(req);
    const room = await getRoom(req.params.callId);
    if (!room) return res.status(404).json({ success: false, message: 'Call no longer exists' });
    if (!room.participants?.[userId]) return res.status(403).json({ success: false, message: 'Not in this call' });
    const after = Number(req.query.after || 0);
    const now = Date.now();
    const signals = (await readSignals(room.callId)).filter(s => s.id > after && now - s.createdAt <= SIGNAL_TTL_MS && s.from !== userId && (!s.to || s.to === userId));
    return res.json({ success: true, cursor: room.sequence, signals });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Unable to read call signals' });
  }
});

router.post('/:callId/end', async (req, res) => {
  try {
    const userId = uid(req);
    const room = await getRoom(req.params.callId);
    if (!room) return res.json({ success: true });
    if (room.hostId !== userId) return res.status(403).json({ success: false, message: 'Only the call host can end the call' });
    await deleteRoom(room.callId);
    return res.json({ success: true });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Unable to end call' });
  }
});

setInterval(async () => {
  if (await redisReady()) return;
  const now = Date.now();
  for (const [id, room] of memoryRooms) if (room.expiresAt <= now) memoryRooms.delete(id);
}, 5 * 60 * 1000).unref?.();

module.exports = router;
