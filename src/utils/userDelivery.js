'use strict';

/**
 * userDelivery.js — single, cluster-aware way to emit to one user.
 *
 * Why this exists (verified by a real two-instance test, see audit report):
 *   - Every layer of sendToUser (Phase11 -> URO -> Phase10 HTR -> original)
 *     used to decide "is the user online?" from io.sockets.adapter.rooms.
 *     With @socket.io/redis-adapter that map only holds sockets connected to
 *     THIS process, so a user connected to another instance looked offline:
 *     every layer fell through and re-emitted (7 copies of one message) and
 *     the message was wrongly written to offline_message_queue + push.
 *   - URO and HTR emitted to `user:<id>` and `user_<id>` in two separate
 *     .emit() calls; a socket in both rooms received each event twice.
 *
 * Contract:
 *   emitToUserOnce(io, uid, event, data)  — one emit, every room variant,
 *                                           each socket receives it once.
 *   userHasSocketAnywhere(io, uid)        — local check first (free); only if
 *                                           no local member AND the adapter is
 *                                           cluster-capable, ask the other
 *                                           nodes (bounded by a timeout).
 *   deliverToUser(io, uid, event, data)   — emit once, resolve to "someone,
 *                                           on any node, is in the room".
 */

const REMOTE_PRESENCE_TIMEOUT_MS = parseInt(process.env.WS_REMOTE_PRESENCE_TIMEOUT_MS, 10) || 1500;

function userRooms(uid) {
  const s = String(uid);
  return [`user:${s}`, `user_${s}`];
}

function hasLocalMember(io, rooms) {
  const roomMap = io && io.sockets && io.sockets.adapter && io.sockets.adapter.rooms;
  if (!roomMap) return false;
  for (const room of rooms) {
    const set = roomMap.get(room);
    if (set && set.size > 0) return true;
  }
  return false;
}

function isClusterAdapter(io) {
  const adapter = io && io.of && io.of('/').adapter;
  // Redis (and other cluster) adapters expose serverCount(); the default
  // in-memory adapter does not.
  return !!(adapter && typeof adapter.serverCount === 'function');
}

async function userHasSocketAnywhere(io, uid) {
  if (!io) return false;
  const rooms = userRooms(uid);
  if (hasLocalMember(io, rooms)) return true;
  if (!isClusterAdapter(io)) return false;

  try {
    const remote = await Promise.race([
      io.in(rooms).fetchSockets(),
      new Promise((resolve) => setTimeout(() => resolve(null), REMOTE_PRESENCE_TIMEOUT_MS)),
    ]);
    // Timeout (null) is treated as "unknown -> offline": the caller then uses
    // the durable queue + push path, which is safe (receiver dedupes by id).
    return Array.isArray(remote) && remote.length > 0;
  } catch (_) {
    return false;
  }
}

function emitToUserOnce(io, uid, event, data) {
  if (!io) return false;
  try {
    let emitter = io;
    for (const room of userRooms(uid)) emitter = emitter.to(room);
    emitter.emit(event, data);
    return true;
  } catch (_) {
    return false;
  }
}

async function deliverToUser(io, uid, event, data) {
  if (!io) return false;
  emitToUserOnce(io, uid, event, data);
  return userHasSocketAnywhere(io, uid);
}

module.exports = { userRooms, hasLocalMember, isClusterAdapter, userHasSocketAnywhere, emitToUserOnce, deliverToUser };
