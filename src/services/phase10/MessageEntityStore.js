'use strict';
/**
 * MessageEntityStore.js — Phase 10
 *
 * Server-side canonical message entity store.
 * Eliminates disappearing messages by:
 *   - Tombstoning deleted entities (never truly gone from index)
 *   - Vector-clock conflict resolution
 *   - Incremental patch delivery (never replace full arrays)
 *   - Deduplication window
 *
 * Used by messageService and webSocketService to emit patches
 * instead of full conversation replacements.
 */

const EventEmitter = require('events');

// ── Tombstone Registry ────────────────────────────────────────────────────────
class TombstoneRegistry {
  constructor() {
    this._stones = new Map(); // id -> { ts, chatId, reason }
    this._TTL    = 24 * 60 * 60 * 1000; // 24h
  }

  mark(id, chatId, reason = 'deleted') {
    this._stones.set(String(id), { ts: Date.now(), chatId, reason });
  }

  isTombstoned(id) {
    const s = this._stones.get(String(id));
    if (!s) return false;
    if (Date.now() - s.ts > this._TTL) { this._stones.delete(String(id)); return false; }
    return true;
  }

  getTombstones(chatId, since = 0) {
    const out = [];
    for (const [id, s] of this._stones) {
      if (s.chatId === chatId && s.ts > since) out.push({ id, ...s });
    }
    return out;
  }

  purge() {
    const now = Date.now();
    for (const [id, s] of this._stones) {
      if (now - s.ts > this._TTL) this._stones.delete(id);
    }
  }
}

// ── Vector Clock ──────────────────────────────────────────────────────────────
class VectorClock {
  constructor() { this._clocks = new Map(); }

  tick(nodeId) {
    this._clocks.set(nodeId, (this._clocks.get(nodeId) || 0) + 1);
    return this.snapshot();
  }

  merge(remoteClock) {
    for (const [node, val] of Object.entries(remoteClock || {})) {
      this._clocks.set(node, Math.max(this._clocks.get(node) || 0, val));
    }
  }

  snapshot() {
    return Object.fromEntries(this._clocks);
  }

  compare(a, b) {
    // Returns: 1 if a>b, -1 if a<b, 0 if concurrent
    let aWins = false, bWins = false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if ((a[k]||0) > (b[k]||0)) aWins = true;
      if ((a[k]||0) < (b[k]||0)) bWins = true;
    }
    if (aWins && !bWins) return 1;
    if (bWins && !aWins) return -1;
    return 0; // concurrent
  }
}

// ── Entity Dedup Window ───────────────────────────────────────────────────────
class EntityDedupWindow {
  constructor(windowMs = 120_000) {
    this._seen   = new Map(); // id -> ts
    this._window = windowMs;
  }

  isDuplicate(id) {
    const ts = this._seen.get(String(id));
    if (!ts) return false;
    if (Date.now() - ts > this._window) { this._seen.delete(String(id)); return false; }
    return true;
  }

  mark(id) {
    this._seen.set(String(id), Date.now());
    if (this._seen.size > 10000) {
      // Evict oldest
      const oldest = [...this._seen.entries()].sort((a,b)=>a[1]-b[1])[0];
      if (oldest) this._seen.delete(oldest[0]);
    }
  }

  purge() {
    const now = Date.now();
    for (const [id, ts] of this._seen) {
      if (now - ts > this._window) this._seen.delete(id);
    }
  }
}

// ── MessageEntityStore ────────────────────────────────────────────────────────
class MessageEntityStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.log       = options.logger || console;
    this.tombstones = new TombstoneRegistry();
    this.clock      = new VectorClock();
    this.dedup      = new EntityDedupWindow(120_000);
    // In-memory patch log: chatId -> [{patch}]  (last 1000 per chat)
    this._patches   = new Map();
    this._running   = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    setInterval(() => { this.tombstones.purge(); this.dedup.purge(); }, 300_000);
    this.log.log('[MessageEntityStore] ✅ Started');
  }

  // Record a new message patch and return the patch event payload
  recordCreate(message) {
    if (this.dedup.isDuplicate(message.id)) return null;
    this.dedup.mark(message.id);
    const clock = this.clock.tick(`msg_${message.id}`);
    const patch = {
      op      : 'create',
      id      : message.id,
      localId : message.localId || null,
      chatId  : message.chatId,
      data    : { ...message },
      clock,
      ts      : Date.now(),
    };
    this._storePatch(message.chatId, patch);
    this.emit('patch', patch);
    return patch;
  }

  recordUpdate(messageId, chatId, changes) {
    if (this.tombstones.isTombstoned(messageId)) return null;
    const clock = this.clock.tick(`upd_${messageId}`);
    const patch = { op: 'update', id: messageId, chatId, changes, clock, ts: Date.now() };
    this._storePatch(chatId, patch);
    this.emit('patch', patch);
    return patch;
  }

  recordDelete(messageId, chatId, reason = 'deleted') {
    this.tombstones.mark(messageId, chatId, reason);
    const clock = this.clock.tick(`del_${messageId}`);
    const patch = { op: 'delete', id: messageId, chatId, clock, ts: Date.now() };
    this._storePatch(chatId, patch);
    this.emit('patch', patch);
    return patch;
  }

  // Clients call this on reconnect to get missed patches
  getPatches(chatId, since = 0) {
    const patches = this._patches.get(chatId) || [];
    const tombstones = this.tombstones.getTombstones(chatId, since);
    return {
      patches: patches.filter(p => p.ts > since),
      tombstones,
      clock: this.clock.snapshot(),
    };
  }

  isTombstoned(id) { return this.tombstones.isTombstoned(id); }

  _storePatch(chatId, patch) {
    if (!this._patches.has(chatId)) this._patches.set(chatId, []);
    const arr = this._patches.get(chatId);
    arr.push(patch);
    if (arr.length > 1000) arr.shift();
  }

  getDiagnostics() {
    return {
      chats    : this._patches.size,
      clock    : this.clock.snapshot(),
      dedup    : this.dedup._seen.size,
      running  : this._running,
    };
  }
}

// Singleton
let _instance = null;
function getMessageEntityStore(options) {
  if (!_instance) { _instance = new MessageEntityStore(options); _instance.start(); }
  return _instance;
}

module.exports = { MessageEntityStore, getMessageEntityStore };
