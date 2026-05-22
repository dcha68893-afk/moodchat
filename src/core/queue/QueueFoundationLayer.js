/**
 * QueueFoundationLayer.js (Backend)
 * Phase 1 — Operation Queue Foundation
 *
 * Server-side:
 *  - Tracks in-flight message delivery operations
 *  - Exposes retry hooks (no mesh relay yet)
 *  - Persists failed operations for offline/reconnect delivery
 *  - Delivery state machine: PENDING → SENDING → SENT → DELIVERED → READ
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');

// ─── Delivery States ─────────────────────────────────────────────────────────

const DELIVERY_STATE = Object.freeze({
  PENDING:   'PENDING',
  SENDING:   'SENDING',
  SENT:      'SENT',
  DELIVERED: 'DELIVERED',
  READ:      'READ',
  FAILED:    'FAILED',
  RETRYING:  'RETRYING',
  EXPIRED:   'EXPIRED',
});

const MAX_RETRIES        = 5;
const RETRY_BASE_MS      = 1000;
const RETRY_MAX_MS       = 30000;
const OP_EXPIRY_MS       = 10 * 60 * 1000; // 10 min
const PRUNE_INTERVAL_MS  = 60 * 1000;

// ─── PendingOperationRegistry ────────────────────────────────────────────────

class PendingOperationRegistry {
  constructor() {
    this._ops = new Map();
  }

  register(op) {
    const entry = {
      ...op,
      state:     DELIVERY_STATE.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts:  0,
      lastError: null,
    };
    this._ops.set(op.id, entry);
    return entry;
  }

  get(id)       { return this._ops.get(id) || null; }
  has(id)       { return this._ops.has(id); }

  setState(id, state, meta = {}) {
    const op = this._ops.get(id);
    if (!op) return false;
    op.state     = state;
    op.updatedAt = Date.now();
    Object.assign(op, meta);
    return true;
  }

  remove(id)    { this._ops.delete(id); }

  getByState(state) {
    return Array.from(this._ops.values()).filter((o) => o.state === state);
  }

  pruneExpired() {
    const now  = Date.now();
    let pruned = 0;
    for (const [id, op] of this._ops) {
      if (now - op.createdAt > OP_EXPIRY_MS) {
        op.state = DELIVERY_STATE.EXPIRED;
        this._ops.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  size() { return this._ops.size; }

  snapshot() {
    return Object.fromEntries(
      Object.values(DELIVERY_STATE).map((s) => [s, this.getByState(s).length])
    );
  }
}

// ─── RetryCoordinator ───────────────────────────────────────────────────────

class RetryCoordinator {
  constructor(registry, emitter) {
    this._registry = registry;
    this._emitter  = emitter;
    this._handlers = new Map(); // opType -> async fn(op)
    this._timers   = new Map(); // opId   -> timeoutId
  }

  register(type, handler) {
    this._handlers.set(type, handler);
  }

  schedule(opId) {
    const op = this._registry.get(opId);
    if (!op) return;

    if (op.attempts >= MAX_RETRIES) {
      this._registry.setState(opId, DELIVERY_STATE.FAILED, {
        lastError: `Max retries (${MAX_RETRIES}) reached`,
      });
      this._emitter.emit('queue:failed', { opId, op });
      return;
    }

    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, op.attempts), RETRY_MAX_MS);
    this._registry.setState(opId, DELIVERY_STATE.RETRYING, {
      attempts:    op.attempts + 1,
      nextRetryAt: Date.now() + delay,
    });

    if (this._timers.has(opId)) clearTimeout(this._timers.get(opId));

    const tid = setTimeout(() => {
      this._timers.delete(opId);
      this._execute(opId);
    }, delay);
    this._timers.set(opId, tid);
  }

  cancel(opId) {
    const tid = this._timers.get(opId);
    if (tid) { clearTimeout(tid); this._timers.delete(opId); }
  }

  async _execute(opId) {
    const op = this._registry.get(opId);
    if (!op) return;

    const handler = this._handlers.get(op.type);
    if (!handler) {
      this._registry.setState(opId, DELIVERY_STATE.FAILED, {
        lastError: 'No retry handler registered',
      });
      return;
    }

    this._registry.setState(opId, DELIVERY_STATE.SENDING);

    try {
      await handler(op);
      this._registry.setState(opId, DELIVERY_STATE.SENT);
      this._emitter.emit('queue:sent', { opId, op });
    } catch (err) {
      const refreshed = this._registry.get(opId);
      if (refreshed && refreshed.attempts < MAX_RETRIES) {
        this.schedule(opId);
      } else {
        this._registry.setState(opId, DELIVERY_STATE.FAILED, {
          lastError: err?.message || String(err),
        });
        this._emitter.emit('queue:failed', { opId, op });
      }
    }
  }
}

// ─── OperationQueueManager (main) ────────────────────────────────────────────

class OperationQueueManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._registry = new PendingOperationRegistry();
    this._retry    = new RetryCoordinator(this._registry, this);
    this._pruneTimer = null;
  }

  start() {
    this._pruneTimer = setInterval(() => {
      const pruned = this._registry.pruneExpired();
      if (pruned > 0) this.emit('queue:pruned', { count: pruned });
    }, PRUNE_INTERVAL_MS);

    console.log('[QueueFoundation:Server] ✅ Started');
    return this;
  }

  stop() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  enqueue(op) {
    if (!op.id) op.id = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = this._registry.register(op);
    this.emit('queue:enqueued', { opId: op.id, op: entry });
    return op.id;
  }

  setState(id, state, meta = {}) {
    const ok = this._registry.setState(id, state, meta);
    if (ok) {
      const op = this._registry.get(id);
      this.emit('queue:state', { opId: id, state, op });
    }
    return ok;
  }

  markSent(id) {
    return this.setState(id, DELIVERY_STATE.SENT);
  }

  markDelivered(id) {
    const ok = this.setState(id, DELIVERY_STATE.DELIVERED);
    if (ok) this._registry.remove(id);
    return ok;
  }

  markRead(id) {
    const ok = this.setState(id, DELIVERY_STATE.READ);
    if (ok) this._registry.remove(id);
    return ok;
  }

  markFailed(id, error) {
    this.setState(id, DELIVERY_STATE.FAILED, {
      lastError: error?.message || String(error),
    });
    this._retry.schedule(id);
  }

  /**
   * Register a retry handler for an operation type.
   * @param {string} type  e.g. 'message', 'read_receipt'
   * @param {Function} fn  async (op) => void
   */
  registerRetryHandler(type, fn) {
    this._retry.register(type, fn);
  }

  /**
   * On reconnect, retry all FAILED operations for a specific userId.
   */
  retryForUser(userId) {
    const failed = this._registry.getByState(DELIVERY_STATE.FAILED)
      .filter((op) => op.userId === userId || op.payload?.senderId === userId);

    for (const op of failed) {
      this._retry.schedule(op.id);
    }

    return failed.length;
  }

  getOp(id) { return this._registry.get(id); }

  getDiagnostics() {
    return {
      total:    this._registry.size(),
      byState:  this._registry.snapshot(),
    };
  }
}

module.exports = { OperationQueueManager, DELIVERY_STATE };
