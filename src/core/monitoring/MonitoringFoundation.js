/**
 * MonitoringFoundation.js (Backend)
 * Phase 1 — Admin + Monitoring Foundation
 *
 * Provides:
 *  - RealtimeDiagnostics aggregator
 *  - NetworkMetricsCollector
 *  - ReconnectTracker
 *  - SyncFailureDetector
 *  - SocketMetricsMonitor
 *  - HydrationMetricsCollector
 *  - Internal /admin/diagnostics HTTP endpoint (not user-facing)
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');
const os           = require('os');

// ─── MetricsStore ─────────────────────────────────────────────────────────────

class MetricsStore {
  constructor(maxEntries = 1000) {
    this._entries    = [];
    this._max        = maxEntries;
    this._counters   = {};
    this._gauges     = {};
    this._timeSeries = {}; // key -> [{ ts, value }]
  }

  record(category, label, value = 1, meta = {}) {
    const entry = { category, label, value, meta, ts: Date.now() };
    this._entries.push(entry);
    if (this._entries.length > this._max) this._entries.shift();
    return entry;
  }

  increment(key, amount = 1) {
    this._counters[key] = (this._counters[key] || 0) + amount;
  }

  gauge(key, value) {
    this._gauges[key] = { value, ts: Date.now() };
    if (!this._timeSeries[key]) this._timeSeries[key] = [];
    this._timeSeries[key].push({ ts: Date.now(), value });
    if (this._timeSeries[key].length > 100) this._timeSeries[key].shift();
  }

  query(category, limit = 100) {
    return this._entries
      .filter((e) => !category || e.category === category)
      .slice(-limit);
  }

  getTimeSeries(key, limit = 60) {
    return (this._timeSeries[key] || []).slice(-limit);
  }

  snapshot() {
    return {
      counters:    { ...this._counters },
      gauges:      { ...this._gauges },
      recentEvents: this._entries.slice(-50),
    };
  }
}

// ─── ReconnectTracker ────────────────────────────────────────────────────────

class ReconnectTracker {
  constructor(store) {
    this._store = store;
    this._history = [];
  }

  record(socketId, userId, type = 'reconnect') {
    const entry = { socketId, userId, type, ts: Date.now() };
    this._history.push(entry);
    if (this._history.length > 200) this._history.shift();
    this._store.increment(`reconnect.${type}`);
    this._store.record('reconnect', type, 1, entry);
  }

  getHistory(limit = 50) { return this._history.slice(-limit); }
  getCount(type)         { return this._history.filter((h) => h.type === type).length; }
}

// ─── SocketMetricsMonitor ────────────────────────────────────────────────────

class SocketMetricsMonitor {
  constructor(store) {
    this._store      = store;
    this._connected  = 0;
    this._peak       = 0;
    this._totalConns = 0;
  }

  recordConnect(socketId) {
    this._connected++;
    this._totalConns++;
    if (this._connected > this._peak) this._peak = this._connected;
    this._store.gauge('socket.connected', this._connected);
    this._store.gauge('socket.peak', this._peak);
    this._store.increment('socket.total_connections');
  }

  recordDisconnect(socketId, reason) {
    this._connected = Math.max(0, this._connected - 1);
    this._store.gauge('socket.connected', this._connected);
    this._store.increment(`socket.disconnect.${reason || 'unknown'}`);
    this._store.record('socket', 'disconnect', 1, { socketId, reason });
  }

  recordEvent(socketId, event) {
    this._store.increment('socket.events_total');
    this._store.increment(`socket.events.${event}`);
  }

  getMetrics() {
    return {
      connected:    this._connected,
      peak:         this._peak,
      totalConns:   this._totalConns,
    };
  }
}

// ─── SyncFailureDetector ────────────────────────────────────────────────────

class SyncFailureDetector {
  constructor(store) {
    this._store    = store;
    this._failures = [];
  }

  record(type, error, meta = {}) {
    const entry = { type, error: error?.message || String(error), meta, ts: Date.now() };
    this._failures.push(entry);
    if (this._failures.length > 100) this._failures.shift();
    this._store.increment(`sync.failures.${type}`);
    this._store.record('sync', 'failure', 1, entry);
  }

  getRecent(limit = 20) { return this._failures.slice(-limit); }
  getCount()            { return this._failures.length; }
}

// ─── SystemMetricsCollector ──────────────────────────────────────────────────

class SystemMetricsCollector {
  constructor(store) {
    this._store = store;
    this._timer = null;
  }

  start(intervalMs = 15000) {
    this._collect(); // immediate
    this._timer = setInterval(() => this._collect(), intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  _collect() {
    const mem     = process.memoryUsage();
    const cpus    = os.cpus();
    const loadAvg = os.loadavg();

    this._store.gauge('system.memory.heapUsed',   Math.round(mem.heapUsed / 1024 / 1024));
    this._store.gauge('system.memory.heapTotal',  Math.round(mem.heapTotal / 1024 / 1024));
    this._store.gauge('system.memory.rss',        Math.round(mem.rss / 1024 / 1024));
    this._store.gauge('system.memory.external',   Math.round(mem.external / 1024 / 1024));
    this._store.gauge('system.cpu.loadAvg1',      loadAvg[0]);
    this._store.gauge('system.cpu.count',         cpus.length);
    this._store.gauge('system.uptime',            process.uptime());
  }
}

// ─── MonitoringFoundation (main) ─────────────────────────────────────────────

class MonitoringFoundation extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger = options.logger || console;
    this._store  = new MetricsStore(2000);

    this._reconnect  = new ReconnectTracker(this._store);
    this._sockets    = new SocketMetricsMonitor(this._store);
    this._syncFail   = new SyncFailureDetector(this._store);
    this._sysMetrics = new SystemMetricsCollector(this._store);

    // References to other Phase 1 modules — set via attachModules()
    this._modules = {};
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    this._sysMetrics.start();
    this._logger.log('[Monitoring:Server] ✅ Started');
    return this;
  }

  stop() {
    this._sysMetrics.stop();
  }

  /**
   * Attach references to other Phase 1 modules for aggregated diagnostics.
   */
  attachModules(modules = {}) {
    this._modules = modules;
    this._attachModuleListeners();
    return this;
  }

  /**
   * Attach to Socket.IO for socket event tracking.
   */
  attachToIO(io) {
    io.on('connection', (socket) => {
      const userId = socket.handshake?.auth?.userId || null;
      this._sockets.recordConnect(socket.id);

      const originalOnevent = socket.onevent?.bind(socket);
      if (socket.onevent) {
        socket.onevent = (packet) => {
          const event = packet.data?.[0];
          if (event) this._sockets.recordEvent(socket.id, event);
          originalOnevent(packet);
        };
      }

      socket.on('disconnect', (reason) => {
        this._sockets.recordDisconnect(socket.id, reason);
        this._reconnect.record(socket.id, userId, 'disconnect');
      });

      socket.on('reconnect', () => {
        this._reconnect.record(socket.id, userId, 'reconnect');
      });
    });

    this._logger.log('[Monitoring:Server] Attached to Socket.IO');
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  recordSyncFailure(type, error, meta) {
    this._syncFail.record(type, error, meta);
  }

  recordReconnect(socketId, userId) {
    this._reconnect.record(socketId, userId, 'reconnect');
  }

  incrementCounter(key, amount = 1) {
    this._store.increment(key, amount);
  }

  recordMetric(category, label, value, meta) {
    this._store.record(category, label, value, meta);
  }

  gauge(key, value) {
    this._store.gauge(key, value);
  }

  /**
   * Full diagnostic snapshot — used by internal admin endpoint.
   */
  snapshot() {
    return {
      timestamp:  new Date().toISOString(),
      uptime:     process.uptime(),
      sockets:    this._sockets.getMetrics(),
      syncFails:  this._syncFail.getRecent(10),
      reconnects: this._reconnect.getHistory(20),
      metrics:    this._store.snapshot(),
      modules: {
        network:     this._modules.network?.getState()              || null,
        realtime:    this._modules.realtime?.getDiagnostics()       || null,
        presence:    this._modules.presence?.getDiagnostics()       || null,
        queue:       this._modules.queue?.getDiagnostics()          || null,
        cache:       this._modules.cache?.getDiagnostics()          || null,
        identity:    this._modules.identity?.getDiagnostics()       || null,
      },
    };
  }

  /**
   * Register the internal diagnostics HTTP endpoint.
   * NOT user-facing — protected by internal token.
   */
  registerAdminRoute(app, options = {}) {
    const path  = options.path  || '/internal/diagnostics';
    const token = options.token || process.env.INTERNAL_DIAG_TOKEN;

    app.get(path, (req, res) => {
      if (token) {
        const provided = req.headers['x-internal-token'] || req.query.token;
        if (provided !== token) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
      res.json(this.snapshot());
    });

    this._logger.log(`[Monitoring:Server] Admin diagnostics endpoint: ${path}`);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _attachModuleListeners() {
    const { network, realtime, presence, queue } = this._modules;

    if (network) {
      network.on('network:changed', (state) => {
        this._store.gauge('network.quality',   state.internetQuality);
        this._store.gauge('network.latency',   state.avgLatency);
        this._store.gauge('network.packetLoss', state.packetLoss);
      });
    }

    if (realtime) {
      realtime.on('socket:reconnected', ({ socketId }) => {
        this._store.increment('realtime.reconnects');
      });
      realtime.on('socket:disconnected', ({ reason }) => {
        this._store.increment(`realtime.disconnect.${reason || 'unknown'}`);
      });
    }

    if (presence) {
      presence.on('presence:ghost_cleared', ({ userId }) => {
        this._store.increment('presence.ghosts_cleared');
        this._store.record('presence', 'ghost_cleared', 1, { userId });
      });
      presence.on('presence:changed', ({ userId, status }) => {
        this._store.record('presence', 'status_change', 1, { userId, status });
      });
    }

    if (queue) {
      queue.on('queue:failed', ({ opId, op }) => {
        this._store.increment('queue.failures');
        this._store.record('queue', 'failed', 1, { opId, type: op?.type });
      });
      queue.on('queue:sent', ({ opId }) => {
        this._store.increment('queue.sent');
      });
    }
  }
}

module.exports = MonitoringFoundation;
