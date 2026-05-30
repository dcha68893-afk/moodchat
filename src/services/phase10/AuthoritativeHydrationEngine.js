'use strict';
/**
 * AuthoritativeHydrationEngine.js — Phase 10
 *
 * Eliminates stale cache resurrection of deleted entities.
 *
 * How it works:
 *  - Every delete is versioned and stored in a DeletionLedger
 *  - Clients receive a deletion version on hydration
 *  - Any cache entry older than its deletion version is rejected
 *  - Provides REST endpoint: GET /api/deletions?since=<ts>
 */

const EventEmitter = require('events');

// ── DeletionLedger ────────────────────────────────────────────────────────────
class DeletionLedger {
  constructor() {
    // type:id -> { version, ts, reason, chatId }
    this._entries   = new Map();
    this._version   = 0;
    this._TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  record(type, id, chatId, reason = 'deleted') {
    this._version++;
    const key   = `${type}:${id}`;
    const entry = { version: this._version, ts: Date.now(), type, id: String(id), chatId, reason };
    this._entries.set(key, entry);
    return entry;
  }

  isDeletable(type, id) {
    return this._entries.has(`${type}:${id}`);
  }

  getVersion(type, id) {
    return this._entries.get(`${type}:${id}`)?.version ?? 0;
  }

  getSince(since = 0) {
    const out = [];
    for (const entry of this._entries.values()) {
      if (entry.ts > since) out.push(entry);
    }
    return out.sort((a,b) => a.ts - b.ts);
  }

  purgeExpired() {
    const cutoff = Date.now() - this._TTL;
    for (const [key, entry] of this._entries) {
      if (entry.ts < cutoff) this._entries.delete(key);
    }
  }

  currentVersion() { return this._version; }

  stats() { return { entries: this._entries.size, version: this._version }; }
}

// ── EntityVersionRegistry ─────────────────────────────────────────────────────
class EntityVersionRegistry {
  constructor() {
    // type:id -> { version, updatedAt }
    this._versions = new Map();
  }

  bump(type, id) {
    const key     = `${type}:${id}`;
    const current = (this._versions.get(key)?.version || 0) + 1;
    this._versions.set(key, { version: current, updatedAt: Date.now() });
    return current;
  }

  get(type, id) { return this._versions.get(`${type}:${id}`) || null; }

  isStale(type, id, clientVersion) {
    const entry = this._versions.get(`${type}:${id}`);
    if (!entry) return false; // unknown entity, let through
    return clientVersion < entry.version;
  }
}

// ── AuthoritativeHydrationEngine ─────────────────────────────────────────────
class AuthoritativeHydrationEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.log      = options.logger || console;
    this.ledger   = new DeletionLedger();
    this.versions = new EntityVersionRegistry();
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    setInterval(() => this.ledger.purgeExpired(), 3_600_000); // 1h
    this.log.log('[AuthoritativeHydration] ✅ Started');
  }

  // Record that an entity was deleted
  recordDeletion(type, id, chatId, reason) {
    const entry = this.ledger.record(type, id, chatId, reason);
    this.versions.bump(type, id); // bump version so staleness checks work
    this.emit('deleted', entry);
    return entry;
  }

  // Record that an entity was updated (so stale hydration can be detected)
  recordUpdate(type, id) {
    return this.versions.bump(type, id);
  }

  // Filter out deleted entities from a hydration payload
  filterHydration(type, entities) {
    if (!Array.isArray(entities)) return entities;
    return entities.filter(e => !this.ledger.isDeletable(type, e.id || e.messageId));
  }

  // Validate a specific entity against deletion ledger
  isDeleted(type, id) { return this.ledger.isDeletable(type, id); }

  // Get all deletions since a timestamp (for client cache invalidation)
  getDeletionsSince(since = 0) { return this.ledger.getSince(since); }

  // Register REST endpoint for clients to pull deletion manifest
  registerRoutes(app, authMiddleware) {
    const guard = authMiddleware || ((req, res, next) => next());

    app.get('/api/deletions', guard, (req, res) => {
      try {
        const since   = parseInt(req.query.since) || 0;
        const entries = this.getDeletionsSince(since);
        res.json({
          ok         : true,
          version    : this.ledger.currentVersion(),
          deletions  : entries,
          count      : entries.length,
          since,
          serverTime : Date.now(),
        });
      } catch (err) {
        this.log.error('[AuthHydration] /api/deletions error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.get('/api/deletions/check/:type/:id', guard, (req, res) => {
      const { type, id } = req.params;
      res.json({
        ok      : true,
        deleted : this.isDeleted(type, id),
        version : this.ledger.getVersion(type, id),
      });
    });
  }

  getDiagnostics() {
    return {
      ledger  : this.ledger.stats(),
      running : this._running,
    };
  }
}

let _instance = null;
function getHydrationEngine(options) {
  if (!_instance) { _instance = new AuthoritativeHydrationEngine(options); _instance.start(); }
  return _instance;
}

module.exports = { AuthoritativeHydrationEngine, getHydrationEngine };
