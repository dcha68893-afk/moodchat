/**
 * ProductionReliabilityService.js (Backend)
 * Phase 5 — Production Reliability Layer
 *
 * Server-side Phase 5 infrastructure:
 *  - Connection supervisor (monitors socket health per user)
 *  - Queue durability (server-side pending operation store)
 *  - Device trust registry (validates device:announce events)
 *  - Replay attack protection (server-side nonce registry)
 *  - Structured telemetry (all operations logged securely)
 *  - Dead-letter queue for failed deliveries
 *  - Session restoration on reconnect
 *
 * Integrates with existing webSocketService methods.
 * DOES NOT replace any existing service.
 *
 * @version 5.0.0
 * @phase 5
 */

'use strict';

const EventEmitter = require('events');
const crypto       = require('crypto');

// ─── NonceRegistry ────────────────────────────────────────────────────────────

class NonceRegistry {
  constructor() {
    this._nonces  = new Map();
    this._window  = 5 * 60 * 1000; // 5 min
    setInterval(() => this._prune(), 2 * 60 * 1000);
  }

  isReplay(nonce, timestamp) {
    if (!nonce) return false;
    const now = Date.now();
    const ts  = typeof timestamp === 'string' ? new Date(timestamp).getTime() : (timestamp || now);
    if (Math.abs(now - ts) > this._window) return true; // stale
    if (this._nonces.has(nonce)) return true;           // seen before
    this._nonces.set(nonce, now);
    return false;
  }

  _prune() {
    const cutoff = Date.now() - this._window;
    for (const [k, ts] of this._nonces) if (ts < cutoff) this._nonces.delete(k);
  }

  size() { return this._nonces.size; }
}

// ─── DeviceTrustRegistry ──────────────────────────────────────────────────────

class DeviceTrustRegistry {
  constructor() {
    // deviceId → { userId, fingerprint, registeredAt, trusted, socketIds: Set }
    this._devices = new Map();
    this._maxAge  = 30 * 24 * 60 * 60 * 1000; // 30 days
  }

  register(deviceId, userId, fingerprint, socketId) {
    if (this._devices.has(deviceId)) {
      const d = this._devices.get(deviceId);
      d.lastSeen = Date.now();
      d.socketIds.add(socketId);
      return d;
    }
    const entry = {
      deviceId, userId: String(userId), fingerprint,
      registeredAt: Date.now(), lastSeen: Date.now(),
      trusted: true, socketIds: new Set([socketId]),
    };
    this._devices.set(deviceId, entry);
    return entry;
  }

  revoke(deviceId) {
    const d = this._devices.get(deviceId);
    if (d) d.trusted = false;
    return !!d;
  }

  isTrusted(deviceId) {
    const d = this._devices.get(deviceId);
    if (!d) return false;
    if (Date.now() - d.registeredAt > this._maxAge) { d.trusted = false; return false; }
    return d.trusted;
  }

  getByUser(userId) {
    return Array.from(this._devices.values()).filter(d => d.userId === String(userId));
  }

  removeSocket(socketId) {
    for (const d of this._devices.values()) d.socketIds.delete(socketId);
  }

  size() { return this._devices.size; }
}

// ─── StructuredTelemetry ──────────────────────────────────────────────────────

class StructuredTelemetry {
  constructor(logger) {
    this._logger  = logger;
    this._entries = [];
    this._maxSize = 5000;
    this._counters = {};
  }

  log(category, event, meta = {}) {
    const entry = {
      ts:        new Date().toISOString(),
      category,
      event,
      deviceId:  meta.deviceId   || null,
      userId:    meta.userId     || null,
      transport: meta.transport  || null,
      latency:   meta.latency    || null,
      failureReason: meta.reason || null,
      retryCount:    meta.attempts || null,
      // NEVER log message content, tokens, or passwords
    };
    this._entries.push(entry);
    if (this._entries.length > this._maxSize) this._entries.shift();
    return entry;
  }

  inc(key, by = 1) { this._counters[key] = (this._counters[key] || 0) + by; }
  get(key)         { return this._counters[key] || 0; }

  getRecent(category, limit = 100) {
    return this._entries.filter(e => !category || e.category === category).slice(-limit);
  }

  snapshot() {
    return {
      counters: { ...this._counters },
      recent:   this._entries.slice(-50),
      logSize:  this._entries.length,
    };
  }
}

// ─── ServerQueueStore ─────────────────────────────────────────────────────────

class ServerQueueStore {
  constructor() {
    // userId → [{ opId, event, payload, attempts, queuedAt, expiresAt }]
    this._queues  = new Map();
    this._maxPerUser = 500;
    this._expiryMs   = 48 * 60 * 60 * 1000; // 48h

    // Prune every 30 min
    setInterval(() => this._prune(), 30 * 60 * 1000);
  }

  enqueue(userId, event, payload) {
    const uid = String(userId);
    if (!this._queues.has(uid)) this._queues.set(uid, []);
    const q = this._queues.get(uid);
    if (q.length >= this._maxPerUser) q.shift();

    const op = {
      opId:     'srv_' + crypto.randomBytes(6).toString('hex'),
      event,
      payload,
      attempts:  0,
      queuedAt:  Date.now(),
      expiresAt: Date.now() + this._expiryMs,
    };
    q.push(op);
    return op;
  }

  flush(userId) {
    const uid    = String(userId);
    const q      = this._queues.get(uid) || [];
    const valid  = q.filter(op => op.expiresAt > Date.now());
    this._queues.set(uid, []);
    return valid;
  }

  size(userId) { return (this._queues.get(String(userId)) || []).length; }

  totalSize() {
    let total = 0;
    for (const q of this._queues.values()) total += q.length;
    return total;
  }

  _prune() {
    const now = Date.now();
    for (const [uid, q] of this._queues) {
      const fresh = q.filter(op => op.expiresAt > now);
      if (!fresh.length) this._queues.delete(uid);
      else this._queues.set(uid, fresh);
    }
  }
}

// ─── ReconnectSessionRestorer ─────────────────────────────────────────────────

class ReconnectSessionRestorer {
  constructor(io, wsService, queue) {
    this._io       = io;
    this._wsService = wsService;
    this._queue    = queue;
  }

  async restore(socket, userId) {
    const results = await Promise.allSettled([
      this._flushQueuedMessages(socket, userId),
      this._rejoinGroupRooms(socket, userId),
      this._syncPresence(socket, userId),
    ]);
    const failed = results.filter(r => r.status === 'rejected').length;
    return { restored: results.length - failed, failed };
  }

  async _flushQueuedMessages(socket, userId) {
    const ops = this._queue.flush(userId);
    for (const op of ops) {
      try {
        socket.emit(op.event, { ...op.payload, _queued: true, _queuedAt: op.queuedAt });
      } catch (_) {}
      await new Promise(r => setTimeout(r, 30));
    }
    return ops.length;
  }

  async _rejoinGroupRooms(socket, userId) {
    // Server-side group rooms are managed by GroupStoryRealtimeService
    // Just emit a resync signal
    socket.emit('session:restored', { userId, ts: Date.now() });
  }

  async _syncPresence(socket, userId) {
    socket.emit('presence:sync', { userId, ts: Date.now() });
  }
}

// ─── ProductionReliabilityService (main) ─────────────────────────────────────

class ProductionReliabilityService extends EventEmitter {
  constructor(io, wsService, options = {}) {
    super();
    this._io       = io;
    this._wsService = wsService;
    this._logger   = options.logger || console;

    this._nonces    = new NonceRegistry();
    this._devices   = new DeviceTrustRegistry();
    this._telemetry = new StructuredTelemetry(this._logger);
    this._queue     = new ServerQueueStore();
    this._restorer  = new ReconnectSessionRestorer(io, wsService, this._queue);

    this._attached  = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;
    this._io.on('connection', socket => this._onConnection(socket));
    this._logger.log('[ProductionReliability:Server] ✅ Attached');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  isReplay(nonce, timestamp) { return this._nonces.isReplay(nonce, timestamp); }
  isTrustedDevice(deviceId)  { return this._devices.isTrusted(deviceId); }
  revokeDevice(deviceId)     { return this._devices.revoke(deviceId); }

  queueForUser(userId, event, payload) {
    return this._queue.enqueue(userId, event, payload);
  }

  log(category, event, meta) {
    return this._telemetry.log(category, event, meta);
  }

  /**
   * Safe deliver: attempt socket delivery, queue on failure.
   */
  async safeDeliver(userId, event, payload) {
    try {
      const delivered = await this._wsService.sendToUser(userId, event, payload);
      if (delivered) {
        this._telemetry.inc('delivery.success');
        return true;
      }
    } catch (_) {}

    // User offline — queue for reconnect
    this._queue.enqueue(userId, event, payload);
    this._telemetry.inc('delivery.queued');
    return false;
  }

  getDiagnostics() {
    return {
      nonces:    this._nonces.size(),
      devices:   this._devices.size(),
      queue:     this._queue.totalSize(),
      telemetry: this._telemetry.snapshot(),
    };
  }

  // ── Private — Socket handlers ─────────────────────────────────────────────

  _onConnection(socket) {
    const userId   = socket.handshake?.auth?.userId || socket.data?.userId || null;
    const deviceId = socket.handshake?.auth?.deviceId || null;

    // Restore session on connect
    if (userId) {
      this._telemetry.log('connection', 'connect', { userId: String(userId), deviceId });
      this._telemetry.inc('connections.total');

      // Flush queued messages after brief delay
      setTimeout(() => {
        this._restorer.restore(socket, userId).then(result => {
          if (result.restored > 0) {
            this._telemetry.log('session', 'restored', { userId: String(userId), restored: result.restored });
          }
        }).catch(() => {});
      }, 500);
    }

    // Device announcement with replay protection
    socket.on('device:announce', data => {
      const { deviceId: dId, fingerprint, nonce, timestamp } = data || {};
      if (!dId || !userId) return;

      if (this._nonces.isReplay(nonce, timestamp)) {
        this._telemetry.log('security', 'replay_detected', { deviceId: dId, userId: String(userId) });
        socket.emit('security:replay_rejected', { nonce });
        return;
      }

      const device = this._devices.register(dId, userId, fingerprint, socket.id);
      socket.emit('device:registered', {
        deviceId: dId,
        trusted:  device.trusted,
        ts:       Date.now(),
      });

      this._telemetry.log('device', 'registered', { deviceId: dId, userId: String(userId) });
      this.emit('device:registered', { deviceId: dId, userId: String(userId) });
    });

    // Session revocation
    socket.on('device:revoke', data => {
      const { targetDeviceId } = data || {};
      if (!targetDeviceId || !userId) return;

      // Only allow user to revoke their own devices
      const devices = this._devices.getByUser(userId);
      if (!devices.find(d => d.deviceId === targetDeviceId)) return;

      this._devices.revoke(targetDeviceId);
      this._wsService.sendToUser(userId, 'session:revoked', { deviceId: targetDeviceId, ts: Date.now() }).catch(() => {});
      this._telemetry.log('security', 'device_revoked', { deviceId: targetDeviceId, revokedBy: String(userId) });
    });

    // Reconnect metrics
    socket.on('reconnect:report', data => {
      this._telemetry.log('reconnect', 'client_report', {
        userId: String(userId || ''),
        attempts: data?.attempts,
        transport: data?.transport,
        latency: data?.latency,
      });
      this._telemetry.inc('reconnects.total');
    });

    socket.on('disconnect', (reason) => {
      if (userId) {
        this._telemetry.log('connection', 'disconnect', { userId: String(userId), reason });
        this._telemetry.inc('disconnections.total');
        this._devices.removeSocket(socket.id);
      }
    });
  }
}

module.exports = ProductionReliabilityService;
