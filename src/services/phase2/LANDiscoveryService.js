/**
 * LANDiscoveryService.js (Backend)
 * Phase 2 — LAN Communication Engine
 *
 * Server-side LAN peer discovery and coordination:
 *  - Maintains per-subnet peer registries
 *  - Pushes peer lists to clients on same subnet
 *  - Handles AP isolation fallback (routes via server)
 *  - mDNS-like discovery via socket events
 *
 * @version 2.0.0
 * @phase 2 — LAN Engine
 */

'use strict';

const EventEmitter = require('events');

const PEER_TTL_MS      = 90000;   // peer stale after 90s
const SWEEP_INTERVAL   = 30000;   // sweep every 30s
const MAX_PEERS_SUBNET = 50;      // max tracked peers per subnet

// ─── SubnetRegistry ──────────────────────────────────────────────────────────

class SubnetRegistry {
  constructor() {
    // subnetKey -> Map<socketId, peerRecord>
    this._subnets = new Map();
  }

  _subnetKey(ip) {
    if (!ip) return 'unknown';
    const parts = ip.split('.');
    return parts.length >= 3 ? parts.slice(0, 3).join('.') : 'unknown';
  }

  register(socketId, userId, ip, deviceId, meta = {}) {
    const key = this._subnetKey(ip);
    if (!this._subnets.has(key)) this._subnets.set(key, new Map());
    const subnet = this._subnets.get(key);

    if (subnet.size >= MAX_PEERS_SUBNET) {
      // Evict oldest
      const oldest = [...subnet.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) subnet.delete(oldest[0]);
    }

    subnet.set(socketId, {
      socketId,
      userId:    String(userId),
      ip,
      deviceId:  deviceId || null,
      wsPort:    meta.wsPort || null,
      lastSeen:  Date.now(),
      subnetKey: key,
    });

    return key;
  }

  unregister(socketId) {
    for (const [key, subnet] of this._subnets) {
      if (subnet.has(socketId)) {
        subnet.delete(socketId);
        if (subnet.size === 0) this._subnets.delete(key);
        return key;
      }
    }
    return null;
  }

  getPeersOnSubnet(ip, excludeSocketId = null) {
    const key    = this._subnetKey(ip);
    const subnet = this._subnets.get(key);
    if (!subnet) return [];
    return [...subnet.values()].filter(p => p.socketId !== excludeSocketId);
  }

  getSubnetFor(socketId) {
    for (const [, subnet] of this._subnets) {
      if (subnet.has(socketId)) return subnet.get(socketId);
    }
    return null;
  }

  pruneStale() {
    const cutoff = Date.now() - PEER_TTL_MS;
    let pruned   = 0;
    for (const [key, subnet] of this._subnets) {
      for (const [sid, peer] of subnet) {
        if (peer.lastSeen < cutoff) { subnet.delete(sid); pruned++; }
      }
      if (subnet.size === 0) this._subnets.delete(key);
    }
    return pruned;
  }

  touch(socketId) {
    const peer = this.getSubnetFor(socketId);
    if (peer) peer.lastSeen = Date.now();
  }

  totalPeers() {
    let total = 0;
    for (const s of this._subnets.values()) total += s.size;
    return total;
  }

  subnetCount() { return this._subnets.size; }
}

// ─── APIsloationDetector ─────────────────────────────────────────────────────

class APIsloationDetector {
  /**
   * Heuristic: if two peers are on the same subnet but can't exchange
   * direct WS connections, AP isolation is likely active.
   * We detect this by tracking failed LAN relay attempts.
   */
  constructor() {
    this._failures = new Map(); // subnetKey -> failCount
  }

  recordFailure(subnetKey) {
    this._failures.set(subnetKey, (this._failures.get(subnetKey) || 0) + 1);
  }

  isIsolated(subnetKey) {
    return (this._failures.get(subnetKey) || 0) >= 3;
  }

  reset(subnetKey) { this._failures.delete(subnetKey); }
}

// ─── LANDiscoveryService (main) ──────────────────────────────────────────────

class LANDiscoveryService extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io         = io;
    this._logger     = options.logger || console;
    this._registry   = new SubnetRegistry();
    this._apDetector = new APIsloationDetector();
    this._attached   = false;
    this._sweepTimer = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._io.on('connection', socket => this._onConnection(socket));

    // Periodic stale peer sweep
    this._sweepTimer = setInterval(() => {
      const pruned = this._registry.pruneStale();
      if (pruned > 0) {
        this._logger.log(`[LANDiscovery:Server] Pruned ${pruned} stale LAN peers`);
      }
    }, SWEEP_INTERVAL);

    this._logger.log('[LANDiscovery:Server] ✅ Attached');
    return this;
  }

  stop() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getPeersForSocket(socketId) {
    const peer = this._registry.getSubnetFor(socketId);
    if (!peer) return [];
    return this._registry.getPeersOnSubnet(peer.ip, socketId);
  }

  isAPIsolated(socketId) {
    const peer = this._registry.getSubnetFor(socketId);
    if (!peer) return false;
    return this._apDetector.isIsolated(peer.subnetKey);
  }

  getDiagnostics() {
    return {
      totalPeers:   this._registry.totalPeers(),
      subnetCount:  this._registry.subnetCount(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onConnection(socket) {
    const userId   = socket.handshake?.auth?.userId || socket.data?.userId || null;
    const deviceId = socket.handshake?.auth?.deviceId || null;
    const ip       = this._extractIP(socket);

    if (userId && ip && ip !== '::1' && ip !== '127.0.0.1') {
      const key = this._registry.register(socket.id, userId, ip, deviceId);
      this._pushPeerListToSubnet(socket, ip, key);
      this._logger.log(`[LANDiscovery] Peer joined subnet ${key}: user=${userId} ip=${ip}`);
    }

    // Handle explicit LAN announcement (with local IP from browser)
    socket.on('lan:announce', data => {
      const localIP = data?.localIP || ip;
      if (!localIP || !userId) return;

      this._registry.register(socket.id, userId, localIP, data.deviceId || deviceId, {
        wsPort: data.wsPort || null,
      });

      const key   = localIP.split('.').slice(0, 3).join('.');
      const peers = this._registry.getPeersOnSubnet(localIP, socket.id);

      // Send peer list back to this socket
      // Include ALL same-subnet peers — even without local WS (use server relay for AP isolation)
      const peerList = peers.map(p => ({
        id:         p.socketId,
        userId:     p.userId,
        deviceId:   p.deviceId,
        socketId:   p.socketId,   // for server-relay fallback
        wsUrl:      p.wsPort && p.ip ? `ws://${p.ip}:${p.wsPort}` : null,
        sameSubnet: true,
        relayable:  true,         // can always relay via server
      }));

      socket.emit('lan:peer_list', { peers: peerList, subnetKey: key });

      // Notify existing peers about new arrival
      for (const peer of peers) {
        const peerSocket = this._io.sockets.sockets?.get(peer.socketId);
        if (peerSocket) {
          peerSocket.emit('lan:peer_joined', {
            userId:   userId,
            deviceId: deviceId,
            ip:       localIP,
          });
        }
      }

      this.emit('lan:peer_joined', { userId, ip: localIP, subnetKey: key });
    });

    // Handle LAN relay failure (AP isolation detection)
    socket.on('lan:relay_failed', data => {
      const peer = this._registry.getSubnetFor(socket.id);
      if (peer) {
        this._apDetector.recordFailure(peer.subnetKey);
        if (this._apDetector.isIsolated(peer.subnetKey)) {
          this._logger.warn(`[LANDiscovery] AP isolation detected on subnet ${peer.subnetKey}`);
          // Notify client to use server relay instead
          socket.emit('lan:ap_isolated', { subnetKey: peer.subnetKey });
          this.emit('lan:ap_isolated', { subnetKey: peer.subnetKey });
        }
      }
    });

    // Heartbeat — refresh peer TTL
    socket.on('heartbeat', () => {
      this._registry.touch(socket.id);
    });

    socket.on('disconnect', () => {
      const key    = this._registry.unregister(socket.id);
      const peers  = key ? this._registry.getPeersOnSubnet(
        this._extractIP(socket), socket.id
      ) : [];

      // Notify peers that this peer left
      for (const peer of peers) {
        const peerSocket = this._io.sockets.sockets?.get(peer.socketId);
        if (peerSocket) {
          peerSocket.emit('lan:peer_left', { socketId: socket.id });
        }
      }

      if (key) this.emit('lan:peer_left', { socketId: socket.id, subnetKey: key });
    });
  }

  _pushPeerListToSubnet(socket, ip, subnetKey) {
    const peers = this._registry.getPeersOnSubnet(ip, socket.id);
    if (!peers.length) return;

    // Notify existing peers about new arrival
    for (const peer of peers) {
      const s = this._io.sockets.sockets?.get(peer.socketId);
      if (s) s.emit('lan:peer_joined', { socketId: socket.id, ip });
    }
  }

  _extractIP(socket) {
    const raw = socket.handshake?.headers?.['x-forwarded-for']
      || socket.handshake?.address
      || socket.conn?.remoteAddress
      || null;
    if (!raw) return null;
    // Handle IPv4-mapped IPv6
    return raw.replace(/^::ffff:/, '').split(',')[0].trim();
  }
}

module.exports = LANDiscoveryService;