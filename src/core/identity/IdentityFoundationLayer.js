/**
 * IdentityFoundationLayer.js (Backend)
 * Phase 1 — Identity Foundation
 *
 * Server-side:
 *  - Device fingerprint verification
 *  - Session identity coordination
 *  - Trusted device registry (preparation for Phase 2 mesh trust)
 *  - Connection fingerprinting per socket
 *
 * DOES NOT alter existing auth middleware.
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');
const crypto       = require('crypto');

// ─── DeviceRecord ─────────────────────────────────────────────────────────────

class DeviceRecord {
  constructor(deviceId, userId, meta = {}) {
    this.deviceId     = deviceId;
    this.userId       = userId;
    this.firstSeenAt  = Date.now();
    this.lastSeenAt   = Date.now();
    this.trusted      = false;
    this.fingerprint  = meta.fingerprint || null;
    this.userAgent    = meta.userAgent   || null;
    this.ipAddress    = meta.ipAddress   || null;
    this.sessionCount = 0;
  }

  touch(meta = {}) {
    this.lastSeenAt = Date.now();
    this.sessionCount++;
    if (meta.ipAddress)   this.ipAddress  = meta.ipAddress;
    if (meta.fingerprint) this.fingerprint = meta.fingerprint;
  }
}

// ─── TrustedDeviceRegistry ───────────────────────────────────────────────────

class TrustedDeviceRegistry {
  constructor() {
    // deviceId -> DeviceRecord
    this._devices = new Map();
  }

  register(deviceId, userId, meta = {}) {
    if (this._devices.has(deviceId)) {
      this._devices.get(deviceId).touch(meta);
    } else {
      this._devices.set(deviceId, new DeviceRecord(deviceId, userId, meta));
    }
    return this._devices.get(deviceId);
  }

  trust(deviceId) {
    const record = this._devices.get(deviceId);
    if (record) record.trusted = true;
    return !!record;
  }

  revoke(deviceId) {
    const record = this._devices.get(deviceId);
    if (record) record.trusted = false;
    return !!record;
  }

  isTrusted(deviceId) {
    return this._devices.get(deviceId)?.trusted || false;
  }

  getByUser(userId) {
    return Array.from(this._devices.values()).filter((d) => d.userId === userId);
  }

  get(deviceId) { return this._devices.get(deviceId) || null; }
  size()        { return this._devices.size; }
}

// ─── SessionIdentityCoordinator ──────────────────────────────────────────────

class SessionIdentityCoordinator {
  constructor() {
    // sessionId -> { userId, deviceId, socketId, startedAt, ipAddress }
    this._sessions = new Map();
    // socketId -> sessionId
    this._socketSession = new Map();
  }

  createSession(socketId, userId, deviceId, meta = {}) {
    const sessionId = 'sess_' + crypto.randomBytes(12).toString('hex');
    const session   = {
      sessionId,
      socketId,
      userId,
      deviceId,
      startedAt:  Date.now(),
      ipAddress:  meta.ipAddress || null,
      userAgent:  meta.userAgent || null,
    };
    this._sessions.set(sessionId, session);
    this._socketSession.set(socketId, sessionId);
    return session;
  }

  endSession(socketId) {
    const sessionId = this._socketSession.get(socketId);
    if (!sessionId) return null;
    const session = this._sessions.get(sessionId);
    this._socketSession.delete(socketId);
    this._sessions.delete(sessionId);
    return session;
  }

  getBySocket(socketId) {
    const sessionId = this._socketSession.get(socketId);
    return sessionId ? this._sessions.get(sessionId) : null;
  }

  getByUser(userId) {
    return Array.from(this._sessions.values()).filter((s) => s.userId === userId);
  }

  count() { return this._sessions.size; }
}

// ─── ConnectionFingerprintManager ────────────────────────────────────────────

class ConnectionFingerprintManager {
  constructor() {
    // socketId -> fingerprint data
    this._fingerprints = new Map();
  }

  record(socketId, data) {
    const fp = {
      socketId,
      userId:     data.userId     || null,
      deviceId:   data.deviceId   || null,
      fingerprint: data.fingerprint || null,
      ipAddress:  data.ipAddress  || null,
      userAgent:  data.userAgent  || null,
      connectedAt: Date.now(),
      networkType: data.networkType || null,
    };
    this._fingerprints.set(socketId, fp);
    return fp;
  }

  get(socketId) { return this._fingerprints.get(socketId) || null; }

  remove(socketId) { this._fingerprints.delete(socketId); }

  /**
   * Detect suspicious patterns — multiple different device IDs from same IP
   * (Phase 2 will use this for mesh trust decisions)
   */
  analyzeTrust(socketId) {
    const fp = this.get(socketId);
    if (!fp) return { trusted: false, reason: 'no_fingerprint' };

    const sameIp = Array.from(this._fingerprints.values())
      .filter((f) => f.ipAddress === fp.ipAddress && f.socketId !== socketId);

    const differentUsers = new Set(sameIp.map((f) => f.userId)).size;
    if (differentUsers > 10) {
      return { trusted: false, reason: 'ip_shared_by_many_users', count: differentUsers };
    }

    return { trusted: true };
  }

  size() { return this._fingerprints.size; }
}

// ─── IdentityFoundationLayer (main) ──────────────────────────────────────────

class IdentityFoundationLayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger   = options.logger || console;
    this._devices  = new TrustedDeviceRegistry();
    this._sessions = new SessionIdentityCoordinator();
    this._connFP   = new ConnectionFingerprintManager();
    this._attached = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Attach to Socket.IO to auto-register device identity on connection.
   */
  attachToIO(io) {
    if (this._attached) return this;
    this._attached = true;

    io.on('connection', (socket) => {
      const auth      = socket.handshake?.auth || {};
      const query     = socket.handshake?.query || {};
      const userId    = auth.userId    || query.userId    || null;
      const deviceId  = auth.deviceId  || query.deviceId  || null;
      const fpHash    = auth.fingerprint || null;
      const userAgent = socket.handshake?.headers?.['user-agent'] || null;
      const ipAddress = socket.handshake?.address || socket.conn?.remoteAddress || null;

      if (userId && deviceId) {
        // Register device
        const record = this._devices.register(deviceId, userId, {
          fingerprint: fpHash,
          userAgent,
          ipAddress,
        });

        // Create session
        const session = this._sessions.createSession(socket.id, userId, deviceId, {
          ipAddress,
          userAgent,
        });

        // Record connection fingerprint
        const fp = this._connFP.record(socket.id, {
          userId,
          deviceId,
          fingerprint: fpHash,
          ipAddress,
          userAgent,
        });

        this.emit('identity:registered', { socketId: socket.id, userId, deviceId, session });
      }

      socket.on('disconnect', () => {
        const session = this._sessions.endSession(socket.id);
        this._connFP.remove(socket.id);
        if (session) {
          this.emit('identity:session_ended', {
            socketId: socket.id,
            userId: session.userId,
            deviceId: session.deviceId,
          });
        }
      });
    });

    this._logger.log('[IdentityFoundation:Server] ✅ Attached to Socket.IO');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  trustDevice(deviceId) {
    return this._devices.trust(deviceId);
  }

  revokeDevice(deviceId) {
    return this._devices.revoke(deviceId);
  }

  isTrustedDevice(deviceId) {
    return this._devices.isTrusted(deviceId);
  }

  getDevicesForUser(userId) {
    return this._devices.getByUser(userId);
  }

  getSessionBySocket(socketId) {
    return this._sessions.getBySocket(socketId);
  }

  getSessionsForUser(userId) {
    return this._sessions.getByUser(userId);
  }

  analyzeTrust(socketId) {
    return this._connFP.analyzeTrust(socketId);
  }

  /**
   * Generate a server-side fingerprint for a request (for future peer-verification).
   */
  fingerprintRequest(req) {
    const components = [
      req.headers?.['user-agent'] || '',
      req.headers?.['accept-language'] || '',
      req.ip || req.connection?.remoteAddress || '',
    ].join('|');
    return crypto.createHash('sha256').update(components).digest('hex').slice(0, 32);
  }

  getDiagnostics() {
    return {
      registeredDevices: this._devices.size(),
      activeSessions:    this._sessions.count(),
      connectionFingerprints: this._connFP.size(),
    };
  }
}

module.exports = IdentityFoundationLayer;
