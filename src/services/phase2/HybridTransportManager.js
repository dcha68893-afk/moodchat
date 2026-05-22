/**
 * HybridTransportManager.js (Backend)
 * Phase 2 — Hybrid Transport Engine
 *
 * Server-side transport orchestration:
 *  - Routes messages through best available transport
 *  - Manages LAN peer registry
 *  - Coordinates mesh relay
 *  - Falls back gracefully between transports
 *
 * @version 2.0.0
 * @phase 2 — Hybrid Transport
 */

'use strict';

const EventEmitter = require('events');

const TRANSPORT = Object.freeze({
  INTERNET: 'INTERNET',
  LAN:      'LAN',
  MESH:     'MESH',
  OFFLINE:  'OFFLINE',
});

// ─── LANPeerRegistry ────────────────────────────────────────────────────────

class LANPeerRegistry {
  constructor() {
    // userId -> [{ deviceId, localIP, wsPort, socketId, lastSeen }]
    this._peers = new Map();
    this._timeout = 60000; // 60s stale threshold
  }

  register(userId, deviceId, peerInfo) {
    if (!this._peers.has(userId)) this._peers.set(userId, []);
    const list    = this._peers.get(userId);
    const existing = list.findIndex(p => p.deviceId === deviceId);
    const entry   = {
      deviceId,
      localIP:    peerInfo.localIP    || null,
      wsPort:     peerInfo.wsPort     || null,
      socketId:   peerInfo.socketId   || null,
      lastSeen:   Date.now(),
      subnetHash: this._subnetHash(peerInfo.localIP),
    };
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
  }

  unregister(userId, deviceId) {
    const list = this._peers.get(userId) || [];
    this._peers.set(userId, list.filter(p => p.deviceId !== deviceId));
  }

  getPeers(userId) {
    const now  = Date.now();
    return (this._peers.get(userId) || [])
      .filter(p => now - p.lastSeen < this._timeout);
  }

  getSameSubnetPeers(userId, localIP) {
    const hash = this._subnetHash(localIP);
    return this.getPeers(userId).filter(p => p.subnetHash === hash);
  }

  prune() {
    const now = Date.now();
    for (const [uid, peers] of this._peers) {
      const fresh = peers.filter(p => now - p.lastSeen < this._timeout);
      if (!fresh.length) this._peers.delete(uid);
      else this._peers.set(uid, fresh);
    }
  }

  _subnetHash(ip) {
    if (!ip) return null;
    const parts = ip.split('.');
    return parts.length >= 3 ? parts.slice(0, 3).join('.') : null;
  }

  getAllPeersForUser(targetUserId, requesterIP) {
    const peers  = this.getPeers(targetUserId);
    const myHash = this._subnetHash(requesterIP);
    return peers.map(p => ({
      ...p,
      sameSubnet: p.subnetHash === myHash,
    }));
  }
}

// ─── MeshRoutingTable ────────────────────────────────────────────────────────

class MeshRoutingTable {
  constructor() {
    // targetDeviceId -> [{ path, score, ts }]
    this._routes = new Map();
    this._maxRoutes = 3;
    this._routeExpiry = 120000;
  }

  addRoute(targetDeviceId, path, score) {
    if (!this._routes.has(targetDeviceId)) this._routes.set(targetDeviceId, []);
    const routes = this._routes.get(targetDeviceId);

    const idx = routes.findIndex(r => r.path.join(',') === path.join(','));
    if (idx >= 0) {
      routes[idx] = { path, score, ts: Date.now() };
    } else {
      routes.push({ path, score, ts: Date.now() });
      routes.sort((a, b) => b.score - a.score);
      if (routes.length > this._maxRoutes) routes.splice(this._maxRoutes);
    }
  }

  getBestRoute(targetDeviceId) {
    const now    = Date.now();
    const routes = (this._routes.get(targetDeviceId) || [])
      .filter(r => now - r.ts < this._routeExpiry)
      .sort((a, b) => b.score - a.score);
    return routes[0] || null;
  }

  removeStale() {
    const now = Date.now();
    for (const [id, routes] of this._routes) {
      const fresh = routes.filter(r => now - r.ts < this._routeExpiry);
      if (!fresh.length) this._routes.delete(id);
      else this._routes.set(id, fresh);
    }
  }

  size() { return this._routes.size; }
}

// ─── HybridTransportManager (main) ──────────────────────────────────────────

class HybridTransportManager extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io       = io;
    this._logger   = options.logger || console;
    this._lanPeers = new LANPeerRegistry();
    this._meshRoutes = new MeshRoutingTable();
    this._attached = false;

    // Prune stale peers and routes every 30s
    setInterval(() => {
      this._lanPeers.prune();
      this._meshRoutes.removeStale();
    }, 30000);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', socket => this._onConnection(socket));

    this._logger.log('[HybridTransport:Server] ✅ Attached');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a message to a user via the best available transport.
   * Priority: Internet socket → LAN notification → Mesh relay → Queue
   */
  async deliverToUser(targetUserId, event, payload, options = {}) {
    const senderIP   = options.senderIP   || null;
    const senderDevice = options.deviceId || null;

    // 1. Internet socket (most reliable)
    const delivered = this._deliverViaSocket(targetUserId, event, payload);
    if (delivered) {
      this.emit('delivery:internet', { targetUserId, event });
      return { transport: TRANSPORT.INTERNET, delivered: true };
    }

    // 2. LAN notification (push to same-subnet device)
    if (senderIP) {
      const lanDelivered = this._notifyLANPeers(targetUserId, senderIP, event, payload);
      if (lanDelivered) {
        this.emit('delivery:lan', { targetUserId, event });
        return { transport: TRANSPORT.LAN, delivered: true };
      }
    }

    // 3. Mesh relay
    if (senderDevice) {
      const meshDelivered = this._relayViaMesh(targetUserId, event, payload, senderDevice);
      if (meshDelivered) {
        this.emit('delivery:mesh', { targetUserId, event });
        return { transport: TRANSPORT.MESH, delivered: true };
      }
    }

    // 4. Queue for later delivery
    this.emit('delivery:queued', { targetUserId, event });
    return { transport: TRANSPORT.OFFLINE, delivered: false };
  }

  getLANPeers(userId, requesterIP) {
    return this._lanPeers.getAllPeersForUser(userId, requesterIP);
  }

  addMeshRoute(targetDeviceId, path, score) {
    this._meshRoutes.addRoute(targetDeviceId, path, score);
  }

  getDiagnostics() {
    return {
      meshRoutingTableSize: this._meshRoutes.size(),
      transport: TRANSPORT,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onConnection(socket) {
    const userId   = socket.handshake?.auth?.userId || socket.data?.userId || null;
    const deviceId = socket.handshake?.auth?.deviceId || null;
    const ip       = socket.handshake?.address || null;

    // Handle LAN peer announcement
    socket.on('lan:announce', data => {
      if (!userId) return;
      this._lanPeers.register(userId, data.deviceId || deviceId || socket.id, {
        localIP:  data.localIP || ip,
        wsPort:   data.wsPort  || null,
        socketId: socket.id,
      });

      // Broadcast updated peer list to the announcing user's contacts
      this._broadcastLANPeerList(userId, socket);
      this._logger.log(`[HybridTransport] LAN peer registered: user=${userId} ip=${data.localIP}`);
    });

    // Handle mesh relay forwarding
    socket.on('mesh:relay', data => {
      this._handleMeshRelay(socket, data, userId);
    });

    socket.on('mesh:flood', data => {
      this._handleMeshFlood(socket, data, userId);
    });

    socket.on('disconnect', () => {
      if (userId && deviceId) {
        this._lanPeers.unregister(userId, deviceId);
      }
    });
  }

  _deliverViaSocket(userId, event, payload) {
    const io = this._io;
    const rooms = [
      `user:${userId}`,
      `user_${userId}`,
      `user:${String(userId)}`,
      `user_${String(userId)}`,
    ];
    let delivered = false;
    for (const room of rooms) {
      const sockets = io.sockets.adapter.rooms?.get(room);
      if (sockets && sockets.size > 0) {
        io.to(room).emit(event, payload);
        delivered = true;
      }
    }
    return delivered;
  }

  _notifyLANPeers(userId, senderIP, event, payload) {
    const peers = this._lanPeers.getSameSubnetPeers(userId, senderIP);
    if (!peers.length) return false;

    for (const peer of peers) {
      if (peer.socketId) {
        const targetSocket = this._io.sockets.sockets?.get(peer.socketId);
        if (targetSocket) {
          targetSocket.emit('lan:message', { event, payload, transport: 'LAN' });
          return true;
        }
      }
    }
    return false;
  }

  _relayViaMesh(targetUserId, event, payload, senderDeviceId) {
    // Look up best route via mesh table
    // Mesh routing is device-based — look up any device for the user
    const io = this._io;
    // Use server mesh relay module if available
    const meshRelay = global.__meshRelay;
    if (meshRelay && typeof meshRelay.relay === 'function') {
      return meshRelay.relay(targetUserId, { event, payload });
    }
    return false;
  }

  _handleMeshRelay(socket, data, userId) {
    const { packet, nextHop } = data || {};
    if (!packet || packet.ttl <= 0) return;

    // Forward to next hop socket
    const targetSocket = this._io.sockets.sockets?.get(nextHop);
    if (targetSocket) {
      packet.ttl--;
      targetSocket.emit('mesh:relay_received', { packet });
      socket.emit('mesh:relay_ack', { relayDeviceId: socket.id, packetId: packet.packetId });
    } else {
      socket.emit('mesh:relay_fail', { relayDeviceId: socket.id, packetId: packet.packetId });
    }
  }

  _handleMeshFlood(socket, data, userId) {
    const { packet } = data || {};
    if (!packet || packet.ttl <= 0) return;
    packet.ttl--;
    socket.broadcast.emit('mesh:relay_received', { packet });
  }

  _broadcastLANPeerList(userId, socket) {
    const peers = this._lanPeers.getPeers(userId);
    socket.emit('lan:peer_list', { peers });
  }
}

module.exports = { HybridTransportManager, TRANSPORT };
