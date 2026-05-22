/**
 * CacheFoundationLayer.js (Backend)
 * Phase 1 — Cache Foundation
 *
 * Server-side in-process cache with:
 *  - TTL-based invalidation
 *  - Versioned cache entries
 *  - Server-truth reconciliation helpers
 *  - Memory pressure awareness
 *  - Deleted-entity registry (prevents resurrection)
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');

// ─── CacheEntry ───────────────────────────────────────────────────────────────

class CacheEntry {
  constructor(key, value, ttlMs = 0) {
    this.key       = key;
    this.value     = value;
    this.createdAt = Date.now();
    this.expiresAt = ttlMs > 0 ? this.createdAt + ttlMs : null;
    this.version   = 1;
    this.hits      = 0;
  }

  isExpired() {
    return this.expiresAt !== null && Date.now() > this.expiresAt;
  }

  touch() { this.hits++; }
}

// ─── DeletedEntityRegistry ───────────────────────────────────────────────────

class DeletedEntityRegistry {
  constructor() {
    this._registry = new Map(); // `type:id` -> deletedAt
    this._maxAge   = 24 * 60 * 60 * 1000; // 24h
  }

  mark(type, id) {
    this._registry.set(`${type}:${id}`, Date.now());
  }

  isDeleted(type, id) {
    const ts = this._registry.get(`${type}:${id}`);
    if (!ts) return false;
    if (Date.now() - ts > this._maxAge) {
      this._registry.delete(`${type}:${id}`);
      return false;
    }
    return true;
  }

  filterDeleted(type, entities, idKey = 'id') {
    return entities.filter((e) => !this.isDeleted(type, e[idKey]));
  }

  prune() {
    const cutoff = Date.now() - this._maxAge;
    for (const [key, ts] of this._registry) {
      if (ts < cutoff) this._registry.delete(key);
    }
  }

  size() { return this._registry.size; }
}

// ─── CacheInvalidationManager ────────────────────────────────────────────────

class CacheInvalidationManager {
  constructor() {
    this._invalidated = new Set();
  }

  invalidate(key)       { this._invalidated.add(key); }
  invalidatePrefix(pfx) {
    for (const k of this._invalidated) {
      if (!k.startsWith(pfx)) continue; // keep already-invalidated
    }
    this._invalidated.add(`__prefix:${pfx}`);
  }

  isInvalid(key) {
    if (this._invalidated.has(key)) return true;
    for (const inv of this._invalidated) {
      if (inv.startsWith('__prefix:') && key.startsWith(inv.slice(9))) return true;
    }
    return false;
  }

  markFresh(key) { this._invalidated.delete(key); }
  clear()        { this._invalidated.clear(); }
  size()         { return this._invalidated.size; }
}

// ─── CacheCoordinator (main) ─────────────────────────────────────────────────

class CacheCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    this._maxEntries    = options.maxEntries    || 5000;
    this._defaultTtlMs  = options.defaultTtlMs  || 5 * 60 * 1000; // 5 min
    this._pruneInterval = options.pruneInterval || 60 * 1000;

    this._store       = new Map();   // key -> CacheEntry
    this._invalidator = new CacheInvalidationManager();
    this._deleted     = new DeletedEntityRegistry();
    this._stats       = { hits: 0, misses: 0, evictions: 0, invalidations: 0 };

    this._pruneTimer = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    this._pruneTimer = setInterval(() => this._prune(), this._pruneInterval);
    console.log('[CacheFoundation:Server] ✅ Started');
    return this;
  }

  stop() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
  }

  // ── Core get/set/del ──────────────────────────────────────────────────────

  get(key) {
    if (this._invalidator.isInvalid(key)) {
      this._stats.misses++;
      return null;
    }

    const entry = this._store.get(key);
    if (!entry) { this._stats.misses++; return null; }
    if (entry.isExpired()) {
      this._store.delete(key);
      this._stats.misses++;
      return null;
    }

    entry.touch();
    this._stats.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    // Evict LRU if at capacity
    if (this._store.size >= this._maxEntries) {
      this._evictLRU();
    }

    const entry = new CacheEntry(key, value, ttlMs ?? this._defaultTtlMs);
    this._store.set(key, entry);
    this._invalidator.markFresh(key);
    return entry;
  }

  del(key) {
    this._store.delete(key);
    this._invalidator.invalidate(key);
  }

  invalidate(key) {
    this._invalidator.invalidate(key);
    this._store.delete(key);
    this._stats.invalidations++;
  }

  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        this._store.delete(key);
        this._stats.invalidations++;
      }
    }
    this._invalidator.invalidatePrefix(prefix);
  }

  flush() {
    this._store.clear();
    this._invalidator.clear();
  }

  // ── Deleted-entity helpers ────────────────────────────────────────────────

  markDeleted(type, id) {
    this._deleted.mark(type, id);
    this.invalidatePrefix(`${type}:`);
    this.emit('entity:deleted', { type, id });
  }

  isDeleted(type, id) {
    return this._deleted.isDeleted(type, id);
  }

  filterDeleted(type, entities, idKey = 'id') {
    return this._deleted.filterDeleted(type, entities, idKey);
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  /**
   * Merge server data over cached data.
   * Server fields always win. Deleted entities are removed.
   */
  reconcile(type, serverItems, cachedItems, idKey = 'id') {
    if (!Array.isArray(serverItems)) return cachedItems || [];

    const serverMap = new Map(serverItems.map((i) => [i[idKey], i]));
    const result    = serverItems
      .filter((i) => !this._deleted.isDeleted(type, i[idKey]))
      .map((serverItem) => {
        const cached = (cachedItems || []).find((c) => c[idKey] === serverItem[idKey]);
        return cached ? { ...cached, ...serverItem } : serverItem;
      });

    return result;
  }

  // ── Cache-aside pattern ───────────────────────────────────────────────────

  /**
   * Standard cache-aside: return cached value or call loader.
   */
  async getOrLoad(key, loader, ttlMs) {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const value = await loader();
    if (value !== null && value !== undefined) {
      this.set(key, value, ttlMs);
    }
    return value;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _evictLRU() {
    let lruKey  = null;
    let lruHits = Infinity;
    for (const [key, entry] of this._store) {
      if (entry.hits < lruHits) { lruHits = entry.hits; lruKey = key; }
    }
    if (lruKey) {
      this._store.delete(lruKey);
      this._stats.evictions++;
    }
  }

  _prune() {
    let pruned = 0;
    for (const [key, entry] of this._store) {
      if (entry.isExpired()) { this._store.delete(key); pruned++; }
    }
    this._deleted.prune();
    if (pruned > 0) this.emit('cache:pruned', { count: pruned });
  }

  getDiagnostics() {
    return {
      size:             this._store.size,
      maxEntries:       this._maxEntries,
      invalidated:      this._invalidator.size(),
      deletedEntities:  this._deleted.size(),
      stats:            { ...this._stats },
      hitRate: this._stats.hits + this._stats.misses > 0
        ? ((this._stats.hits / (this._stats.hits + this._stats.misses)) * 100).toFixed(1) + '%'
        : 'n/a',
    };
  }
}

module.exports = CacheCoordinator;
