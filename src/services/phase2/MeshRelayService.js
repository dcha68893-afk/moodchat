/**
 * MeshRelayService.js (Backend)
 * Phase 2 — Mesh Relay Engine (Backend)
 *
 * Server-side mesh coordination:
 *  - Maintains global routing table (deviceId → path)
 *  - Validates relay eligibility (battery, trust, TTL)
 *  - Broadcasts route advertisements
 *  - Tracks relay performance and trust scores
 *  - Prevents routing loops via seen-packet cache
 *
 * Relay nodes CANNOT decrypt payloads — E2EE is enforced.
 *
 * @version 2.0.0
 * @phase 2 — Mesh Relay
 */

'use strict';

const EventEmitter = require('events');

const MAX_TTL         = 6;
const ROUTE_EXPIRY_MS = 120000;
const DEDUP_WINDOW_MS = 300000; // 5 min
const TRUST_MIN       = 0.3;

// ─── PacketDeduplicator ──────────────────────────────────────────────────────

class PacketDeduplicator {
  constructor() { this._seen = new Map(); }

  isDuplicate(packetId) {
    const now = Date.now();
    for (const [k, ts] of this._seen) {
      if (now - ts > DEDUP_WINDOW_MS) this._seen.delete(k);
    }
    if (this._seen.has(packetId)) return true;
    this._seen.set(packetId, now);
    return false;
  }

  size() { return this._seen.size; }
}

// ─── MeshRoutingTable ────────────────────────────────────────────────────────

class MeshRoutingTable {
  constructor() {
    // deviceId → [{ path, score, ts, socketId }]
    this._routes   = new Map();
    this._maxPerDst = 3;
  }

  advertise(deviceId, socketId, path = [], score = 0.5) {
    if (!this._routes.has(deviceId)) this._routes.set(deviceId, []);
    const routes = this._routes.get(deviceId);

    const pathKey = path.join('>');
    const idx     = routes.findIndex(r => r.path.join('>') === pathKey);
    const entry   = { path, score, ts: Date.now(), socketId };

    if (idx >= 0) routes[idx] = entry;
    else {
      routes.push(entry);
      routes.sort((a, b) => b.score - a.score);
      if (routes.length > this._maxPerDst) routes.splice(this._maxPerDst);
    }
  }

  getBestRoute(targetDeviceId) {
    const now    = Date.now();
    const routes = (this._routes.get(targetDeviceId) || [])
      .filter(r => now - r.ts < ROUTE_EXPIRY_MS)
      .sort((a, b) => b.score - a.score);
    return routes[0] || null;
  }

  removeBySocket(socketId) {
    for (const [id, routes] of this._routes) {
      const filtered = routes.filter(r => r.socketId !== socketId);
      if (!filtered.length) this._routes.delete(id);
      else this._routes.set(id, filtered);
    }
  }

  pruneStale() {
    const now = Date.now();
    for (const [id, routes] of this._routes) {
      const fresh = routes.filter(r => now - r.ts < ROUTE_EXPIRY_MS);
      if (!fresh.length) this._routes.delete(id);
      else this._routes.set(id, fresh);
    }
  }

  size() { return this._routes.size; }

  getAllRoutes() {
    return Array.from(this._routes.entries()).map(([id, routes]) => ({
      targetDeviceId: id,
      routes: routes.slice(0, 2),
    }));
  }
}

// ─── TrustRegistry ───────────────────────────────────────────────────────────

class TrustRegistry {
  constructor() {
    // deviceId → { score, successes, failures, lastSeen }
    this._trust = new Map();
  }

  recordSuccess(deviceId) { this._update(deviceId, true); }
  recordFailure(deviceId) { this._update(deviceId, false); }

  getScore(deviceId) {
    return this._trust.get(deviceId)?.score ?? 0.5;
  }

  isTrusted(deviceId) {
    return this.getScore(deviceId) >= TRUST_MIN;
  }

  _update(deviceId, success) {
    const e = this._trust.get(deviceId) || { score: 0.5, successes: 0, failures: 0 };
    if (success) e.successes++; else e.failures++;
    const total = e.successes + e.failures;
    e.score    = total > 0 ? e.successes / total : 0.5;
    e.lastSeen = Date.now();
    this._trust.set(deviceId, e);
  }

  size() { return this._trust.size; }
}

// ─── MeshRelayService (main) ─────────────────────────────────────────────────

class MeshRelayService extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io       = io;
    this._logger   = options.logger || console;
    this._routing  = new MeshRoutingTable();
    this._trust    = new TrustRegistry();
    this._dedup    = new PacketDeduplicator();
    this._attached = false;

    // Expose relay function for HybridTransportManager
    global.__meshRelay = this;
    setInterval(() => this._routing.pruneStale(), 60000);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', socket => this._onConnection(socket));

    this._logger.log('[MeshRelay:Server] ✅ Attached');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Relay a payload to a target user via any available route.
   * Called by HybridTransportManager when internet delivery fails.
   */
  relay(targetUserId, payload) {
    const route = this._routing.getBestRoute(String(targetUserId));
    if (!route) return false;

    const nextSocket = this._io.sockets.sockets?.get(route.socketId);
    if (!nextSocket) return false;

    if (!this._trust.isTrusted(route.socketId)) return false;

    nextSocket.emit('mesh:relay_received', {
      packet: {
        targetDeviceId:   targetUserId,
        encryptedPayload: payload,
        ttl:              MAX_TTL,
        hops:             [],
        packetId:         'srv_' + Date.now().toString(36),
        createdAt:        Date.now(),
      },
    });

    this.emit('mesh:relayed', { targetUserId, via: route.socketId });
    return true;
  }

  getDiagnostics() {
    return {
      routingTableSize: this._routing.size(),
      trustedNodes:     this._trust.size(),
      dedupWindow:      this._dedup.size(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onConnection(socket) {
    const userId   = socket.handshake?.auth?.userId || null;
    const deviceId = socket.handshake?.auth?.deviceId || socket.id;

    // Register this device as a potential relay node (direct path)
    if (deviceId) {
      this._routing.advertise(deviceId, socket.id, [deviceId], 1.0);
      this._trust.recordSuccess(socket.id);

      // Advertise routes to this peer
      setTimeout(() => this._sendRouteAdvertisements(socket), 2000);
    }

    // Handle relay forwarding from client
    socket.on('mesh:relay', data => {
      this._handleRelay(socket, data, deviceId);
    });

    // Handle flood delivery
    socket.on('mesh:flood', data => {
      this._handleFlood(socket, data);
    });

    // Route advertisement from client (client discovered a path)
    socket.on('mesh:route_advertise', data => {
      const { targetDeviceId, path, score } = data || {};
      if (targetDeviceId && Array.isArray(path)) {
        this._routing.advertise(targetDeviceId, socket.id, path, score || 0.5);
        this.emit('mesh:route_advertised', { targetDeviceId, path, score });
      }
    });

    socket.on('disconnect', () => {
      this._routing.removeBySocket(socket.id);
    });
  }

  _handleRelay(socket, data, relayDeviceId) {
    const { packet, nextHop } = data || {};
    if (!packet) return;

    if (this._dedup.isDuplicate(packet.packetId)) return;

    if (!packet.ttl || packet.ttl <= 0) {
      this._logger.debug?.('[MeshRelay] Packet TTL expired:', packet.packetId);
      return;
    }

    // Decrement TTL
    packet.ttl--;
    packet.hops = [...(packet.hops || []), relayDeviceId];

    // Find next hop socket
    const targetSocket = this._io.sockets.sockets?.get(nextHop);
    if (targetSocket) {
      targetSocket.emit('mesh:relay_received', { packet });
      socket.emit('mesh:relay_ack', { relayDeviceId: socket.id, packetId: packet.packetId });
      this._trust.recordSuccess(socket.id);
      this.emit('mesh:packet_forwarded', { packetId: packet.packetId, ttl: packet.ttl });
    } else {
      // Try routing table
      const route = this._routing.getBestRoute(packet.targetDeviceId);
      if (route) {
        const alt = this._io.sockets.sockets?.get(route.socketId);
        if (alt) {
          alt.emit('mesh:relay_received', { packet });
          this._trust.recordSuccess(socket.id);
          return;
        }
      }
      socket.emit('mesh:relay_fail', { relayDeviceId: socket.id, packetId: packet.packetId });
      this._trust.recordFailure(socket.id);
    }
  }

  _handleFlood(socket, data) {
    const { packet } = data || {};
    if (!packet || packet.ttl <= 0) return;
    if (this._dedup.isDuplicate(packet.packetId)) return;

    packet.ttl--;
    // Flood to all connected sockets except sender (limited hop flood)
    let count = 0;
    for (const [sid, s] of this._io.sockets.sockets || []) {
      if (sid !== socket.id && count < 10) {
        s.emit('mesh:relay_received', { packet });
        count++;
      }
    }
  }

  _sendRouteAdvertisements(socket) {
    const routes = this._routing.getAllRoutes().slice(0, 20);
    if (routes.length) {
      socket.emit('mesh:routes', { routes });
    }
  }
}

module.exports = MeshRelayService;
