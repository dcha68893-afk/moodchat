'use strict';
/**
 * HybridTransportRuntime.js — Phase 10 Production
 *
 * THE canonical transport authority on the backend.
 * Routes ALL delivery (messages, calls, status, groups, presence)
 * through the best available channel:
 *   1. Socket.IO (internet)
 *   2. LAN relay (same subnet)
 *   3. Mesh relay
 *   4. Offline queue (persistent, retry on reconnect)
 *
 * No module may bypass this. All delivery goes through deliver().
 */

const EventEmitter = require('events');

const TRANSPORT = Object.freeze({
  INTERNET : 'INTERNET',
  LAN      : 'LAN',
  MESH     : 'MESH',
  OFFLINE  : 'OFFLINE',
});

const PRIORITY = [TRANSPORT.INTERNET, TRANSPORT.LAN, TRANSPORT.MESH, TRANSPORT.OFFLINE];

// ── Health per transport ──────────────────────────────────────────────────────
class TransportHealth {
  constructor() {
    this._map = {
      [TRANSPORT.INTERNET]: { ok: true,  failures: 0, latency: 0, lastCheck: Date.now() },
      [TRANSPORT.LAN]     : { ok: false, failures: 0, latency: 0, lastCheck: 0 },
      [TRANSPORT.MESH]    : { ok: false, failures: 0, latency: 0, lastCheck: 0 },
      [TRANSPORT.OFFLINE] : { ok: true,  failures: 0, latency: 0, lastCheck: Date.now() },
    };
  }
  mark(t, success, latency = 0) {
    const h = this._map[t]; if (!h) return;
    if (success) { h.ok = true; h.failures = 0; h.latency = latency; }
    else {
      // FIX BUG #2: INTERNET transport is NEVER marked unavailable from individual delivery
      // attempts. Empty rooms = user offline, not transport failure. Only LAN/MESH can fail.
      if (t !== TRANSPORT.INTERNET) {
        h.failures++;
        if (h.failures >= 3) h.ok = false;
      }
    }
    h.lastCheck = Date.now();
  }
  available(t)  { return this._map[t]?.ok ?? false; }
  best()        { return PRIORITY.find(t => this.available(t)) || TRANSPORT.OFFLINE; }
  snapshot()    { return JSON.parse(JSON.stringify(this._map)); }
  setAvail(t,v) { if (this._map[t]) this._map[t].ok = v; }
}

// ── Offline delivery queue ────────────────────────────────────────────────────
class OfflineDeliveryQueue {
  constructor() {
    this._q    = new Map(); // userId -> [{event,data,ts,attempts}]
    this._MAX  = 500;
    this._TTL  = 7 * 24 * 60 * 60 * 1000;
  }

  enqueue(userId, event, data) {
    if (!this._q.has(userId)) this._q.set(userId, []);
    const q = this._q.get(userId);
    if (q.length >= this._MAX) q.shift();
    q.push({ event, data, ts: Date.now(), attempts: 0 });
  }

  flush(userId, deliverFn) {
    const q = this._q.get(userId) || [];
    if (!q.length) return;
    const now = Date.now();
    const fresh = q.filter(e => now - e.ts < this._TTL);
    this._q.set(userId, []);
    for (const entry of fresh) {
      try { deliverFn(entry.event, entry.data); }
      catch (_) { entry.attempts++; /* re-enqueue on failure */ }
    }
  }

  pendingCount(userId) { return (this._q.get(userId) || []).length; }

  purgeExpired() {
    const now = Date.now();
    for (const [uid, q] of this._q) {
      const fresh = q.filter(e => now - e.ts < this._TTL);
      if (!fresh.length) this._q.delete(uid); else this._q.set(uid, fresh);
    }
  }

  stats() {
    let total = 0;
    for (const q of this._q.values()) total += q.length;
    return { users: this._q.size, total };
  }
}

// ── LAN delivery registry (used for same-subnet routing) ─────────────────────
class LANDeliveryRegistry {
  constructor() {
    // userId -> { socketId, subnetKey, lastSeen }
    this._peers = new Map();
    this._TTL   = 90_000;
  }

  register(userId, socketId, subnetKey) {
    this._peers.set(String(userId), { socketId, subnetKey, lastSeen: Date.now() });
  }

  unregister(userId) { this._peers.delete(String(userId)); }

  getLANSocket(userId, requesterSubnet) {
    const peer = this._peers.get(String(userId));
    if (!peer) return null;
    if (Date.now() - peer.lastSeen > this._TTL) { this._peers.delete(String(userId)); return null; }
    if (requesterSubnet && peer.subnetKey !== requesterSubnet) return null;
    return peer.socketId;
  }

  prune() {
    const now = Date.now();
    for (const [uid, p] of this._peers) {
      if (now - p.lastSeen > this._TTL) this._peers.delete(uid);
    }
  }

  _subnetKey(ip) {
    if (!ip) return 'unknown';
    const p = ip.split('.');
    return p.length >= 3 ? p.slice(0,3).join('.') : 'unknown';
  }
}

// ── THE Transport Runtime ─────────────────────────────────────────────────────
class HybridTransportRuntime extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this.io      = io;
    this.log     = options.logger || console;
    this.health  = new TransportHealth();
    this.offline = new OfflineDeliveryQueue();
    this.lan     = new LANDeliveryRegistry();
    this._meshRelay = null; // injected by phase2
    this._lanSvc    = null;
    this._running   = false;
    this._stats     = { delivered: 0, queued: 0, failed: 0, lanDelivered: 0 };
  }

  // ── Dependency injection ─────────────────────────────────────────────────
  setMeshRelay(relay) { this._meshRelay = relay; }
  setLANService(svc)  { this._lanSvc = svc; }

  start() {
    if (this._running) return;
    this._running = true;
    this._attachSocketEvents();
    this._startMaintenance();
    this.log.log('[HybridTransportRuntime] ✅ Started — canonical transport authority active');
  }

  // ── CANONICAL DELIVER — all modules call this ────────────────────────────
  /**
   * deliver(userId, event, data, options)
   *   options.transport  — force a specific transport
   *   options.priority   — 'high' | 'normal' | 'low'
   *   options.senderSubnet — requester's subnet for LAN routing
   */
  async deliver(userId, event, data, options = {}) {
    const uid = String(userId);

    // FIX BUG #3: Always try INTERNET first regardless of preferred transport.
    // INTERNET transport emits to socket rooms — if user is online they get it.
    // If rooms are empty (user offline), _sendViaInternet returns false but that
    // is NOT a transport failure; fall through to LAN/MESH then offline queue.
    const preferred = options.transport;
    const orderedTransports = preferred && preferred !== TRANSPORT.INTERNET
      ? [TRANSPORT.INTERNET, preferred, ...PRIORITY.filter(x => x !== TRANSPORT.INTERNET && x !== preferred)]
      : PRIORITY;

    for (const t of orderedTransports) {
      if (!this.health.available(t)) continue;
      const ok = await this._sendVia(t, uid, event, data, options);
      if (ok) {
        // Only mark non-INTERNET transports as succeeded (INTERNET health is static)
        if (t !== TRANSPORT.INTERNET) this.health.mark(t, true);
        this._stats.delivered++;
        this.emit('delivered', { transport: t, userId: uid, event });
        return { ok: true, transport: t };
      }
      // FIX BUG #2: Don't mark INTERNET as failed — mark only LAN/MESH
      if (t !== TRANSPORT.INTERNET) this.health.mark(t, false);
    }

    // All transports failed — enqueue offline
    this.offline.enqueue(uid, event, data);
    this._stats.queued++;
    this.emit('queued', { userId: uid, event });
    return { ok: false, queued: true };
  }

  // Broadcast to multiple users
  async deliverToMany(userIds, event, data, options = {}) {
    const results = await Promise.allSettled(
      userIds.map(uid => this.deliver(uid, event, data, options))
    );
    return results.map((r,i) => ({ userId: userIds[i], ...(r.value || { ok: false }) }));
  }

  // Broadcast to a room (group, chat, etc.)
  broadcastToRoom(room, event, data) {
    try {
      if (!this.io) return false;
      this.io.to(room).emit(event, data);
      this._stats.delivered++;
      return true;
    } catch (err) {
      this.log.error('[HTR] broadcastToRoom error:', err.message);
      return false;
    }
  }

  // Flush offline queue when user reconnects
  flushOfflineQueue(userId) {
    this.offline.flush(String(userId), (event, data) => {
      this._sendViaInternet(String(userId), event, data);
    });
  }

  getDiagnostics() {
    return {
      health   : this.health.snapshot(),
      best     : this.health.best(),
      offline  : this.offline.stats(),
      stats    : { ...this._stats },
      running  : this._running,
    };
  }

  // ── Private: per-transport send ─────────────────────────────────────────
  async _sendVia(transport, uid, event, data, options) {
    switch (transport) {
      case TRANSPORT.INTERNET: return this._sendViaInternet(uid, event, data);
      case TRANSPORT.LAN:      return this._sendViaLAN(uid, event, data, options.senderSubnet);
      case TRANSPORT.MESH:     return this._sendViaMesh(uid, event, data);
      case TRANSPORT.OFFLINE:  return false; // always goes to queue
      default:                 return false;
    }
  }

  _sendViaInternet(uid, event, data) {
    try {
      if (!this.io) return false;
      const strUid = String(uid);
      const numUid = String(Number(uid));
      const rooms = [...new Set([
        `user:${strUid}`,
        `user_${strUid}`,
        `user:${numUid}`,
        `user_${numUid}`,
      ])];
      let sent = false;
      for (const room of rooms) {
        try {
          // FIX-ROOT-CAUSE: Check actual room membership BEFORE marking as sent.
          // io.to(room).emit() is fire-and-forget and NEVER throws, even when the
          // room has zero members. The old code set sent=true unconditionally, so
          // HTR always returned { ok: true } — causing sendToUser to return early
          // without ever reaching the per-socket-ID fallback delivery. Receivers
          // that were online but whose room join was slightly delayed (race on
          // connect) silently missed messages. Now we only count as delivered when
          // at least one socket is actually in the room.
          const roomSockets = this.io.sockets?.adapter?.rooms?.get(room);
          if (roomSockets && roomSockets.size > 0) {
            this.io.to(room).emit(event, data);
            sent = true;
          }
        } catch (_) {}
      }
      return sent;
    } catch (err) {
      this.log.warn(`[HTR] Internet send failed for uid=${uid}:`, err.message);
      return false;
    }
  }

  _sendViaLAN(uid, event, data, senderSubnet) {
    try {
      const socketId = this.lan.getLANSocket(uid, senderSubnet);
      if (!socketId || !this.io) return false;
      const sock = this.io.sockets.sockets.get(socketId);
      if (!sock || !sock.connected) return false;
      sock.emit(event, { ...data, _transport: 'LAN' });
      this._stats.lanDelivered++;
      return true;
    } catch (_) { return false; }
  }

  _sendViaMesh(uid, event, data) {
    try {
      if (!this._meshRelay) return false;
      return this._meshRelay.relay(uid, event, data) !== false;
    } catch (_) { return false; }
  }

  // ── Socket.IO integration ────────────────────────────────────────────────
  _attachSocketEvents() {
    if (!this.io) return;

    this.io.on('connection', socket => {
      const uid = socket._authenticatedUserId;
      if (!uid) return;

      // Register for LAN routing
      const ip = socket.handshake?.address || socket.request?.connection?.remoteAddress || '';
      const subnetKey = ip.split('.').slice(0,3).join('.');
      this.lan.register(uid, socket.id, subnetKey);

      // Flush queued offline messages
      this.flushOfflineQueue(uid);

      // Update health — internet is reachable via this socket
      this.health.setAvail(TRANSPORT.INTERNET, true);

      socket.on('disconnect', () => {
        this.lan.unregister(uid);
      });

      // Allow modules to request transport diagnostics
      socket.on('transport:diagnostics', () => {
        socket.emit('transport:diagnostics:result', this.getDiagnostics());
      });
    });
  }

  _startMaintenance() {
    // Prune expired offline entries and stale LAN peers every 60s
    setInterval(() => {
      this.offline.purgeExpired();
      this.lan.prune();
    }, 60_000);

    // Ping internet health every 30s
    setInterval(() => {
      const connected = this.io?.engine?.clientsCount > 0;
      this.health.setAvail(TRANSPORT.INTERNET, connected || true); // always allow internet attempts
    }, 30_000);
  }
}

module.exports = { HybridTransportRuntime, TRANSPORT };
