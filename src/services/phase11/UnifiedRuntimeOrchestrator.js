'use strict';
/**
 * UnifiedRuntimeOrchestrator.js — Phase 11 Backend
 *
 * THE central authority for all backend message routing, delivery,
 * and state synchronization.
 *
 * Wires together:
 *  - HybridTransportRuntime (Phase 10)
 *  - MessageEntityStore (Phase 10)
 *  - AuthoritativeHydrationEngine (Phase 10)
 *  - webSocketService
 *  - messageService
 *  - callService
 *  - LANDiscoveryService
 *  - MeshRelay
 *
 * All delivery for messages, calls, status, groups routes through here.
 */

const EventEmitter = require('events');

// ── Canonical Event Registry ──────────────────────────────────────────────────
const CANONICAL = Object.freeze({
  // Messages
  'new_message'          : 'message:chat:created',
  'MESSAGE_RECEIVED'     : 'message:chat:created',
  'message:deleted'      : 'message:chat:deleted',
  'message:edited'       : 'message:chat:updated',
  'message:reaction'     : 'message:chat:reacted',
  // Groups
  'group:message'        : 'message:group:created',
  'new_group_message'    : 'message:group:created',
  'group:membership_change': 'group:member:changed',
  // Calls
  'call:incoming'        : 'call:session:incoming',
  'incoming_call'        : 'call:session:incoming',
  'call:accepted'        : 'call:session:accepted',
  'call:ended'           : 'call:session:ended',
  // Status
  'status:new'           : 'status:post:created',
  'status:deleted'       : 'status:post:deleted',
  // Presence
  'user:online'          : 'presence:user:online',
  'user:offline'         : 'presence:user:offline',
  // Entity
  'entity:deleted'       : 'entity:any:deleted',
});

function normalize(event) {
  return CANONICAL[event] || event;
}

// ── Delivery State Machine ────────────────────────────────────────────────────
const DELIVERY_STATE = Object.freeze({
  QUEUED    : 'QUEUED',
  ROUTING   : 'ROUTING',
  SENT      : 'SENT',
  ACKED     : 'ACKED',
  FAILED    : 'FAILED',
});

class DeliveryTracker {
  constructor() {
    this._entries = new Map(); // id → { state, ts, transport }
  }

  track(id, state, meta = {}) {
    this._entries.set(String(id), { state, ts: Date.now(), ...meta });
  }

  get(id)   { return this._entries.get(String(id)); }
  state(id) { return this._entries.get(String(id))?.state; }

  prune() {
    const cutoff = Date.now() - 3600_000;
    for (const [id, e] of this._entries) {
      if (e.ts < cutoff) this._entries.delete(id);
    }
  }

  stats() {
    let byState = {};
    for (const e of this._entries.values()) {
      byState[e.state] = (byState[e.state] || 0) + 1;
    }
    return { total: this._entries.size, byState };
  }
}

// ── User Routing Table ────────────────────────────────────────────────────────
class UserRoutingTable {
  constructor() {
    this._routes = new Map(); // userId → { socketId, transport, subnetKey, ts }
  }

  register(userId, socketId, transport, subnetKey) {
    this._routes.set(String(userId), { socketId, transport, subnetKey, ts: Date.now() });
  }

  unregister(userId) { this._routes.delete(String(userId)); }

  getRoute(userId) {
    const r = this._routes.get(String(userId));
    if (!r) return null;
    if (Date.now() - r.ts > 120_000) { this._routes.delete(String(userId)); return null; }
    return r;
  }

  getBestTransport(userId, requesterSubnetKey) {
    const r = this.getRoute(userId);
    if (!r) return 'OFFLINE';
    // If same subnet → LAN
    if (requesterSubnetKey && r.subnetKey === requesterSubnetKey) return 'LAN';
    return 'INTERNET';
  }

  prune() {
    const now = Date.now();
    for (const [uid, r] of this._routes) {
      if (now - r.ts > 120_000) this._routes.delete(uid);
    }
  }

  stats() { return { routes: this._routes.size }; }
}

// ── UnifiedRuntimeOrchestrator ────────────────────────────────────────────────
class UnifiedRuntimeOrchestrator extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this.io       = io;
    this.log      = options.logger || console;
    this._tracker = new DeliveryTracker();
    this._routing = new UserRoutingTable();
    this._running = false;
    this._stats   = { delivered: 0, failed: 0, routed_lan: 0, routed_internet: 0 };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._attachSocketEvents();
    this._startMaintenance();
    this.log.log('[URO] ✅ UnifiedRuntimeOrchestrator v11.0.0 active');
  }

  // ── THE canonical deliver API ─────────────────────────────────────────────
  /**
   * deliver(userId, event, data, options)
   * Intelligently routes to the best transport.
   * Falls back to offline queue on failure.
   */
  async deliver(userId, event, data, options = {}) {
    const uid    = String(userId);
    const normEv = normalize(event);

    this._tracker.track(`${uid}:${event}:${Date.now()}`, DELIVERY_STATE.ROUTING, { userId: uid, event });

    // Determine best transport
    const transport = this._routing.getBestTransport(uid, options.senderSubnet);

    // Try HybridTransportRuntime first (Phase 10 — has LAN registry + offline queue)
    const htr = global.__HybridTransportRuntime;
    if (htr) {
      const result = await htr.deliver(uid, event, data, options).catch(() => null);
      if (result?.ok) {
        this._stats.delivered++;
        this._stats[`routed_${transport.toLowerCase()}`]++;
        this._tracker.track(`${uid}:${event}`, DELIVERY_STATE.SENT, { transport });
        this.emit('delivered', { userId: uid, event: normEv, transport });
        return { ok: true, transport };
      }
      if (result?.queued) {
        this.emit('queued', { userId: uid, event: normEv });
        return { ok: true, queued: true };
      }
    }

    // Fallback: direct Socket.IO
    const delivered = this._sendSocketIO(uid, event, data);
    if (delivered) {
      this._stats.delivered++;
      this._tracker.track(`${uid}:${event}`, DELIVERY_STATE.SENT, { transport: 'INTERNET' });
      return { ok: true, transport: 'INTERNET' };
    }

    // Queue offline
    htr?.offline?.enqueue(uid, event, data);
    this._stats.failed++;
    this.emit('queued', { userId: uid, event: normEv });
    return { ok: false, queued: true };
  }

  // Broadcast to a room
  broadcastToRoom(room, event, data) {
    if (!this.io) return false;
    try {
      this.io.to(room).emit(event, data);
      return true;
    } catch (_) { return false; }
  }

  // Normalize an event name to canonical form
  normalize(event) { return normalize(event); }

  getDiagnostics() {
    return {
      running  : this._running,
      stats    : { ...this._stats },
      delivery : this._tracker.stats(),
      routing  : this._routing.stats(),
      htr      : global.__HybridTransportRuntime?.getDiagnostics?.() || null,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _sendSocketIO(uid, event, data) {
    try {
      if (!this.io) return false;
      const rooms = [`user:${uid}`, `user_${uid}`];
      let sent = false;
      for (const room of rooms) {
        try { this.io.to(room).emit(event, data); sent = true; } catch (_) {}
      }
      return sent;
    } catch (_) { return false; }
  }

  _attachSocketEvents() {
    if (!this.io) return;
    this.io.on('connection', (socket) => {
      const uid = socket._authenticatedUserId;
      if (!uid) return;

      const ip         = socket.handshake?.address || '';
      const subnetKey  = ip.split('.').slice(0, 3).join('.');

      this._routing.register(uid, socket.id, 'INTERNET', subnetKey);

      socket.on('disconnect', () => {
        this._routing.unregister(uid);
      });

      // Transport diagnostics request
      socket.on('cor:diagnostics', () => {
        socket.emit('cor:diagnostics:result', this.getDiagnostics());
      });
    });
  }

  _startMaintenance() {
    setInterval(() => {
      this._tracker.prune();
      this._routing.prune();
    }, 60_000);
  }
}

// Singleton
let _instance = null;
function getURO(io, options) {
  if (!_instance) {
    _instance = new UnifiedRuntimeOrchestrator(io, options);
  }
  return _instance;
}

module.exports = { UnifiedRuntimeOrchestrator, getURO, normalize };
