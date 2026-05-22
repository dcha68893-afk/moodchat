/**
 * ConflictResolutionEngine.js (Backend)
 * Phase 2 — Conflict Resolution Engine
 *
 * Prevents state corruption when:
 *  - Reconnecting after offline period
 *  - Multi-device syncing
 *  - Simultaneous edits
 *
 * Uses Lamport timestamps + server-truth-wins strategy.
 *
 * @version 2.0.0
 * @phase 2 — Conflict Resolution
 */

'use strict';

const EventEmitter = require('events');

// ─── LamportClock ─────────────────────────────────────────────────────────────

class LamportClock {
  constructor() { this._t = BigInt(0); }

  tick()         { return ++this._t; }
  update(remote) {
    const r = BigInt(remote || 0);
    this._t = (r > this._t ? r : this._t) + BigInt(1);
    return this._t;
  }
  get value()    { return Number(this._t); }
}

// ─── ConflictResolver ────────────────────────────────────────────────────────

class ConflictResolver {
  /**
   * Determine winning version.
   * Rules:
   *  1. Deletion always wins (server validated)
   *  2. Higher Lamport timestamp wins
   *  3. Server version wins on tie
   */
  resolve(local, server) {
    if (!local)  return server;
    if (!server) return local;

    // Server deletion wins unconditionally
    if (server.isDeleted || server.deleted) return server;

    const serverLT = Number(server.lamport || server.updatedAt || 0);
    const localLT  = Number(local.lamport  || local.updatedAt  || 0);

    if (serverLT > localLT) return server;
    if (localLT > serverLT) return local;

    // Tie: server wins
    return server;
  }

  /**
   * Three-way merge for collections.
   * base = common ancestor, local = client version, server = authoritative
   */
  mergeCollections(base, local, server, idKey = 'id') {
    const baseMap   = new Map((base   || []).map(i => [String(i[idKey]), i]));
    const serverMap = new Map((server || []).map(i => [String(i[idKey]), i]));
    const localMap  = new Map((local  || []).map(i => [String(i[idKey]), i]));

    const merged = [];
    const allIds  = new Set([...serverMap.keys(), ...localMap.keys()]);

    for (const id of allIds) {
      const s = serverMap.get(id);
      const l = localMap.get(id);
      const b = baseMap.get(id);

      if (!s && b) continue;           // deleted on server
      if (!s && !b && l) {             // local-only new item
        merged.push(l);
        continue;
      }
      if (!l) { merged.push(s); continue; } // server only
      merged.push(this.resolve(l, s));
    }

    return merged.sort((a, b) =>
      Number(a.lamport || a.createdAt || 0) - Number(b.lamport || b.createdAt || 0)
    );
  }
}

// ─── OperationLog ────────────────────────────────────────────────────────────

class OperationLog {
  constructor() {
    this._log     = [];
    this._maxSize = 500;
  }

  record(op) {
    this._log.push({ ...op, ts: Date.now(), lamport: op.lamport || 0 });
    if (this._log.length > this._maxSize) this._log.shift();
  }

  getSince(lamport) {
    return this._log.filter(op => op.lamport > Number(lamport));
  }

  getByEntity(type, id) {
    return this._log.filter(op => op.entityType === type && String(op.entityId) === String(id));
  }

  size() { return this._log.length; }
}

// ─── ConflictResolutionEngine (main) ─────────────────────────────────────────

class ConflictResolutionEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger   = options.logger || console;
    this._clock    = new LamportClock();
    this._resolver = new ConflictResolver();
    this._opLog    = new OperationLog();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Stamp an outgoing entity with the next Lamport timestamp.
   */
  stamp(entity) {
    const lamport = Number(this._clock.tick());
    return { ...entity, lamport };
  }

  /**
   * Process an incoming entity — update clock, resolve conflict.
   */
  processIncoming(entityType, incoming, existing = null) {
    if (incoming.lamport) this._clock.update(incoming.lamport);

    const winner = this._resolver.resolve(existing, incoming);

    // Log the operation
    this._opLog.record({
      entityType,
      entityId:  incoming.id || incoming.messageId,
      lamport:   Number(incoming.lamport || 0),
      winner:    winner === incoming ? 'incoming' : 'existing',
      action:    incoming.deleted ? 'delete' : 'upsert',
    });

    if (winner !== incoming) {
      this.emit('conflict:resolved', {
        entityType,
        id:     incoming.id,
        winner: 'existing',
        incoming,
        existing,
      });
    }

    return winner;
  }

  /**
   * Reconcile a collection. Server truth wins.
   */
  reconcileCollection(entityType, local, server, idKey = 'id') {
    return this._resolver.mergeCollections(null, local, server, idKey);
  }

  /**
   * Get operation log since a Lamport timestamp.
   * Used for delta sync.
   */
  getOpsSince(lamport) {
    return this._opLog.getSince(lamport);
  }

  get currentLamport() { return this._clock.value; }

  /**
   * Express middleware: stamp all server responses with Lamport clock.
   */
  stampMiddleware() {
    const self = this;
    return (req, res, next) => {
      const origJson = res.json.bind(res);
      res.json = function (data) {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          data.__serverLamport = Number(self._clock.tick());
          data.__serverTs      = Date.now();
        }
        return origJson(data);
      };
      next();
    };
  }

  /**
   * Attach to Socket.IO to update clock from client events.
   */
  attachToIO(io) {
    io.on('connection', socket => {
      socket.on('sync:lamport', data => {
        if (data?.lamport) this._clock.update(data.lamport);
        socket.emit('sync:lamport_ack', { lamport: this._clock.value });
      });
    });
    return this;
  }

  getDiagnostics() {
    return {
      lamport:  this._clock.value,
      opsLogged: this._opLog.size(),
    };
  }
}

module.exports = ConflictResolutionEngine;
