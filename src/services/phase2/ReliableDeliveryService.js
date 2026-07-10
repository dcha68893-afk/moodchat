/**
 * ReliableDeliveryService.js (Backend)
 * Phase 2 — Reliable Delivery Engine
 *
 * Server-side delivery tracking and guaranteed delivery:
 *  - Full delivery state machine per message
 *  - ACK tracking with retries
 *  - Delivery receipt broadcasting
 *  - Per-user offline queue
 *  - Delta sync endpoint
 *
 * @version 2.0.0
 * @phase 2 — Reliable Delivery
 */

'use strict';

const EventEmitter = require('events');

const DELIVERY = Object.freeze({
  CREATED:             'CREATED',
  QUEUED:              'QUEUED',
  ROUTING:             'ROUTING',
  RELAYED:             'RELAYED',
  DELIVERED_TO_DEVICE: 'DELIVERED_TO_DEVICE',
  DELIVERED_TO_CLIENT: 'DELIVERED_TO_CLIENT',
  SEEN:                'SEEN',
  FAILED:              'FAILED',
  RETRYING:            'RETRYING',
  EXPIRED:             'EXPIRED',
});

const ACK_TIMEOUT_MS  = 20000;
const MAX_ACK_RETRIES = 5;
const DEDUP_WINDOW_MS = 120000;

// ─── InboundDeduplicator ─────────────────────────────────────────────────────

class InboundDeduplicator {
  constructor() { this._seen = new Map(); }

  isDuplicate(id) {
    const now  = Date.now();
    for (const [k, ts] of this._seen) {
      if (now - ts > DEDUP_WINDOW_MS) this._seen.delete(k);
    }
    if (this._seen.has(id)) return true;
    this._seen.set(id, now);
    return false;
  }

  size() { return this._seen.size; }
}

// ─── DeliveryStateStore ──────────────────────────────────────────────────────

class DeliveryStateStore {
  constructor() {
    // messageId -> state record
    this._records = new Map();
    // Prune old records every 5 min
    setInterval(() => this._prune(), 5 * 60 * 1000);
  }

  create(messageId, meta = {}) {
    const record = {
      messageId,
      state:      DELIVERY.CREATED,
      transport:  meta.transport || null,
      senderId:   meta.senderId  || null,
      receiverId: meta.receiverId || null,
      chatId:     meta.chatId    || null,
      attempts:   0,
      timestamps: { created: Date.now() },
      lastError:  null,
    };
    this._records.set(messageId, record);
    return record;
  }

  transition(messageId, newState, meta = {}) {
    const record = this._records.get(messageId);
    if (!record) return null;
    record.state = newState;
    record.timestamps[newState.toLowerCase()] = Date.now();
    Object.assign(record, meta);
    return record;
  }

  get(id)     { return this._records.get(id) || null; }
  has(id)     { return this._records.has(id); }
  remove(id)  { this._records.delete(id); }

  getByUser(userId, field = 'senderId') {
    return Array.from(this._records.values())
      .filter(r => r[field] === userId || r[field] === String(userId));
  }

  _prune() {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1h
    for (const [id, rec] of this._records) {
      if (rec.timestamps.created < cutoff &&
        (rec.state === DELIVERY.DELIVERED_TO_CLIENT || rec.state === DELIVERY.SEEN || rec.state === DELIVERY.EXPIRED)) {
        this._records.delete(id);
      }
    }
  }

  snapshot() {
    return Object.values(DELIVERY).reduce((acc, s) => {
      acc[s] = Array.from(this._records.values()).filter(r => r.state === s).length;
      return acc;
    }, {});
  }
}

// ─── OfflineUserQueue ────────────────────────────────────────────────────────

class OfflineUserQueue {
  constructor() {
    // userId -> [{ event, payload, queuedAt, attempts }]
    this._queues  = new Map();
    this._maxSize = 200;
    this._expiry  = 24 * 60 * 60 * 1000; // 24h
  }

  enqueue(userId, event, payload) {
    if (!this._queues.has(userId)) this._queues.set(userId, []);
    const q = this._queues.get(userId);
    if (q.length >= this._maxSize) q.shift();
    q.push({ event, payload, queuedAt: Date.now(), attempts: 0 });
  }

  flush(userId) {
    const q = this._queues.get(userId) || [];
    this._queues.delete(userId);
    return q.filter(entry => Date.now() - entry.queuedAt < this._expiry);
  }

  size(userId) { return (this._queues.get(userId) || []).length; }
  totalSize()  { return Array.from(this._queues.values()).reduce((s, q) => s + q.length, 0); }
}

// ─── ReliableDeliveryService (main) ─────────────────────────────────────────

class ReliableDeliveryService extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this._io       = io;
    this._logger   = options.logger || console;
    this._store    = new DeliveryStateStore();
    this._dedup    = new InboundDeduplicator();
    this._offline  = new OfflineUserQueue();
    this._ackTimers = new Map();
    this._attached = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return this;
    this._attached = true;
    this._io.on('connection', socket => this._onConnection(socket));
    this._logger.log('[ReliableDelivery:Server] ✅ Attached');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Track a new outbound message.
   */
  trackMessage(messageId, meta = {}) {
    return this._store.create(messageId, meta);
  }

  /**
   * Validate an inbound message — check dedup.
   * Returns false if duplicate.
   */
  validateInbound(messageId) {
    return !this._dedup.isDuplicate(messageId);
  }

  /**
   * Send a message to a user and track delivery.
   * Queues if user offline.
   */
  async deliverToUser(userId, event, payload, transport = 'INTERNET') {
    const messageId = payload?.id || payload?.messageId || payload?.localId;
    if (messageId) {
      if (!this._store.has(messageId)) this._store.create(messageId, { receiverId: userId });
      this._store.transition(messageId, DELIVERY.ROUTING, { transport });
    }

    const delivered = this._emitToUser(userId, event, payload);

    if (delivered) {
      if (messageId) {
        this._store.transition(messageId, DELIVERY.DELIVERED_TO_DEVICE);
        this._scheduleAck(messageId, userId, event, payload);
      }
      return true;
    }

    // User offline — queue
    this._offline.enqueue(userId, event, payload);
    if (messageId) {
      this._store.transition(messageId, DELIVERY.QUEUED);
    }
    return false;
  }

  /**
   * Process ACK from client.
   */
  processAck(messageId, userId) {
    const timer = this._ackTimers.get(messageId);
    if (timer) { clearTimeout(timer); this._ackTimers.delete(messageId); }
    this._store.transition(messageId, DELIVERY.DELIVERED_TO_CLIENT);
    this.emit('delivery:acked', { messageId, userId });
  }

  /**
   * Process read receipt.
   */
  processRead(messageId, userId) {
    this._store.transition(messageId, DELIVERY.SEEN);
    this.emit('delivery:seen', { messageId, userId });
  }

  /**
   * Flush queued messages for a reconnected user.
   */
  async flushQueue(userId) {
    const queued = this._offline.flush(userId);
    if (!queued.length) return 0;

    this._logger.log(`[ReliableDelivery:Server] Flushing ${queued.length} queued events for user ${userId}`);

    for (const entry of queued) {
      await this._deliverOrRequeue(userId, entry);
      await new Promise(r => setTimeout(r, 50)); // pace delivery
    }

    return queued.length;
  }

  /**
   * Register Express route for delta sync.
   * GET /api/messages/delta?chatId=X&since=timestamp
   */
  registerDeltaSyncRoute(app, authenticateToken) {
    app.get('/api/messages/delta', authenticateToken, async (req, res) => {
      try {
        const { chatId, since } = req.query;
        const sinceTs = parseInt(since, 10) || Date.now() - 5 * 60 * 1000;

        // Delegate to existing message service
        const db = require('../../models');
        const Message = db.Message || db.Messages;
        if (!Message) return res.json({ messages: [], since: sinceTs });

        const { Op } = db.Sequelize || require('sequelize');
        const messages = await Message.findAll({
          where: {
            chatId:    chatId,
            createdAt: { [Op.gt]: new Date(sinceTs) },
            isDeleted: { [Op.ne]: true },
          },
          limit:  100,
          order:  [['createdAt', 'ASC']],
        });

        res.json({ messages, since: sinceTs, syncedAt: Date.now() });
      } catch (err) {
        this._logger.warn('[ReliableDelivery] Delta sync error:', err.message);
        res.status(500).json({ error: 'Sync failed', messages: [] });
      }
    });

    this._logger.log('[ReliableDelivery:Server] Delta sync route registered: GET /api/messages/delta');
  }

  getDiagnostics() {
    return {
      tracked:       this._store.snapshot(),
      pendingAcks:   this._ackTimers.size,
      dedupWindow:   this._dedup.size(),
      offlineQueued: this._offline.totalSize(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onConnection(socket) {
    const userId = socket.handshake?.auth?.userId || socket.data?.userId || null;
    if (!userId) return;

    // Flush queued messages on connect
    this.flushQueue(userId).catch(err => {
      this._logger.warn('[ReliableDelivery] Flush error:', err.message);
    });

    // Handle ACKs
    // FIX: removeAllListeners() first — matches the defensive pattern already
    // used in CallSignalingService.js — so a duplicate invocation of
    // _onConnection for the same socket can't double-process delivery acks
    // or read receipts.
    socket.removeAllListeners('message:ack').on('message:ack', data => {
      const id = data?.messageId || data?.id;
      if (id) this.processAck(id, userId);
    });

    socket.removeAllListeners('message:read').on('message:read', data => {
      const id = data?.messageId || data?.id;
      if (id) this.processRead(id, userId);
    });
  }

  _emitToUser(userId, event, payload) {
    const io    = this._io;
    const rooms = [`user:${userId}`, `user_${userId}`, `user:${String(userId)}`, `user_${String(userId)}`];
    let hit     = false;
    for (const room of rooms) {
      const sockets = io.sockets.adapter.rooms?.get(room);
      if (sockets?.size) { io.to(room).emit(event, payload); hit = true; }
    }
    return hit;
  }

  _scheduleAck(messageId, userId, event, payload) {
    let attempts = 0;
    const attempt = () => {
      attempts++;
      if (attempts > MAX_ACK_RETRIES) {
        this._store.transition(messageId, DELIVERY.FAILED, { lastError: 'ACK timeout' });
        this._ackTimers.delete(messageId);
        return;
      }
      this._store.transition(messageId, DELIVERY.RETRYING, { attempts });
      const ok = this._emitToUser(userId, event, payload);
      if (!ok) {
        this._offline.enqueue(userId, event, payload);
        this._store.transition(messageId, DELIVERY.QUEUED);
        this._ackTimers.delete(messageId);
        return;
      }
      this._ackTimers.set(messageId, setTimeout(attempt, ACK_TIMEOUT_MS));
    };

    this._ackTimers.set(messageId, setTimeout(attempt, ACK_TIMEOUT_MS));
  }

  async _deliverOrRequeue(userId, entry) {
    const ok = this._emitToUser(userId, entry.event, entry.payload);
    if (!ok) {
      entry.attempts++;
      if (entry.attempts < MAX_ACK_RETRIES) {
        this._offline.enqueue(userId, entry.event, entry.payload);
      }
    }
  }
}

module.exports = { ReliableDeliveryService, DELIVERY };
