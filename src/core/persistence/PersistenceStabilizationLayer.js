/**
 * PersistenceStabilizationLayer.js (Backend)
 * Phase 1 — Persistence Stabilization
 *
 * Server-side:
 *  - Server-truth enforcement helpers for API responses
 *  - Deleted-entity registry (prevents resurrection in API responses)
 *  - Hydration validation before returning data to clients
 *  - Soft-delete audit trail
 *
 * DOES NOT modify DB schema or existing model logic.
 * Wraps response data only.
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');

// ─── DeletedEntityRegistry ───────────────────────────────────────────────────

class DeletedEntityRegistry {
  constructor() {
    this._registry = new Map(); // `type:id` -> { deletedAt, deletedBy }
    this._maxAge   = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  mark(type, id, meta = {}) {
    this._registry.set(`${type}:${id}`, {
      type,
      id,
      deletedAt:  Date.now(),
      deletedBy:  meta.deletedBy   || null,
      reason:     meta.reason      || null,
    });
  }

  isDeleted(type, id) {
    const key    = `${type}:${id}`;
    const entry  = this._registry.get(key);
    if (!entry) return false;
    if (Date.now() - entry.deletedAt > this._maxAge) {
      this._registry.delete(key);
      return false;
    }
    return true;
  }

  filterDeleted(type, entities, idKey = 'id') {
    return entities.filter((e) => {
      const id = e[idKey] || e.id;
      return id && !this.isDeleted(type, id);
    });
  }

  prune() {
    const cutoff = Date.now() - this._maxAge;
    for (const [key, entry] of this._registry) {
      if (entry.deletedAt < cutoff) this._registry.delete(key);
    }
  }

  size() { return this._registry.size; }
}

// ─── HydrationValidator ──────────────────────────────────────────────────────

class HydrationValidator {
  constructor(deletedRegistry) {
    this._deleted  = deletedRegistry;
    this._failures = [];
  }

  validate(type, entity, idKey = 'id') {
    if (!entity || typeof entity !== 'object') return false;
    const id = entity[idKey] || entity.id;
    if (!id) return false;
    if (this._deleted.isDeleted(type, id)) {
      this._failures.push({ reason: 'deleted', type, id, ts: Date.now() });
      return false;
    }
    return true;
  }

  validateCollection(type, entities, idKey = 'id') {
    if (!Array.isArray(entities)) return [];
    return entities.filter((e) => this.validate(type, e, idKey));
  }

  getFailures(limit = 50) { return this._failures.slice(-limit); }
  count()                  { return this._failures.length; }
}

// ─── ResponseSanitizer ───────────────────────────────────────────────────────

class ResponseSanitizer {
  constructor(validator) {
    this._validator = validator;
  }

  /**
   * Sanitize an array response before sending to client.
   * Removes deleted entities and validates structure.
   */
  sanitizeList(type, entities, idKey = 'id') {
    if (!Array.isArray(entities)) return [];
    return this._validator.validateCollection(type, entities, idKey);
  }

  /**
   * Sanitize a single entity.
   * Returns null if deleted or invalid.
   */
  sanitizeOne(type, entity, idKey = 'id') {
    if (!this._validator.validate(type, entity, idKey)) return null;
    return entity;
  }

  /**
   * Express middleware factory: sanitizes list responses.
   * Use on routes returning arrays of entities.
   *
   * Example:
   *   router.get('/messages', sanitizer.middleware('message'), getMessages);
   */
  middleware(type, idKey = 'id') {
    const self = this;
    return (req, res, next) => {
      const origJson = res.json.bind(res);
      res.json = function (data) {
        if (Array.isArray(data)) {
          return origJson(self.sanitizeList(type, data, idKey));
        }
        if (data && Array.isArray(data.data)) {
          data.data = self.sanitizeList(type, data.data, idKey);
          return origJson(data);
        }
        if (data && Array.isArray(data.messages)) {
          data.messages = self.sanitizeList('message', data.messages, idKey);
          return origJson(data);
        }
        return origJson(data);
      };
      next();
    };
  }
}

// ─── PersistenceCoordinator (main) ───────────────────────────────────────────

class PersistenceCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger    = options.logger || console;
    this._deleted   = new DeletedEntityRegistry();
    this._validator = new HydrationValidator(this._deleted);
    this._sanitizer = new ResponseSanitizer(this._validator);

    // Prune old deleted records daily
    setInterval(() => this._deleted.prune(), 24 * 60 * 60 * 1000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a soft-delete event.
   * Call this whenever your existing deletion logic fires.
   */
  markDeleted(type, id, meta = {}) {
    this._deleted.mark(type, id, meta);
    this.emit('entity:deleted', { type, id, meta });
  }

  isDeleted(type, id)            { return this._deleted.isDeleted(type, id); }
  filterDeleted(type, arr, key)  { return this._deleted.filterDeleted(type, arr, key); }
  validate(type, entity, key)    { return this._validator.validate(type, entity, key); }
  validateList(type, arr, key)   { return this._validator.validateCollection(type, arr, key); }

  /** Express middleware to auto-sanitize route responses */
  sanitizeMiddleware(type, idKey) {
    return this._sanitizer.middleware(type, idKey);
  }

  /**
   * Hook into existing delete routes/services.
   * Example:
   *   persistence.hookDeleteEvent('message', messageService, 'delete');
   */
  hookDeleteEvent(type, serviceInstance, methodName) {
    const orig = serviceInstance[methodName]?.bind(serviceInstance);
    if (!orig) return;
    serviceInstance[methodName] = async (...args) => {
      const result = await orig(...args);
      const id     = result?.id || args[0];
      if (id) this.markDeleted(type, id);
      return result;
    };
    this._logger.log(`[PersistenceStab:Server] Hooked ${type}.${methodName} for delete tracking`);
  }

  getDiagnostics() {
    return {
      deletedEntities:  this._deleted.size(),
      hydrationFails:   this._validator.count(),
      recentFails:      this._validator.getFailures(10),
    };
  }
}

module.exports = PersistenceCoordinator;
