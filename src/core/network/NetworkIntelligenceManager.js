/**
 * NetworkIntelligenceManager.js (Backend)
 * Phase 1 — Network Intelligence Layer
 *
 * Server-side network state classifier and observer.
 * Tracks socket connection health, latency, and reconnect patterns.
 * Emits events for monitoring — does NOT reroute traffic.
 *
 * @version 1.0.0
 * @phase 1 — Foundation Stabilization
 */

'use strict';

const EventEmitter = require('events');
const dns = require('dns').promises;

// ─── Constants ────────────────────────────────────────────────────────────────

const QUALITY = Object.freeze({
  GOOD: 'GOOD',
  FAIR: 'FAIR',
  POOR: 'POOR',
  OFFLINE: 'OFFLINE',
});

const CHECK_INTERVAL_MS = 20000;
const DNS_CHECK_HOST = 'google.com';
const LATENCY_HISTORY_SIZE = 20;
const PACKET_LOSS_WINDOW = 20;

// ─── LatencyMonitor ──────────────────────────────────────────────────────────

class LatencyMonitor {
  constructor(size = LATENCY_HISTORY_SIZE) {
    this._samples = [];
    this._size = size;
  }

  record(ms) {
    this._samples.push(ms);
    if (this._samples.length > this._size) this._samples.shift();
  }

  average() {
    if (!this._samples.length) return 0;
    return Math.round(this._samples.reduce((a, b) => a + b, 0) / this._samples.length);
  }

  p95() {
    if (this._samples.length < 2) return this.average();
    const sorted = [...this._samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)];
  }
}

// ─── PacketLossMonitor ───────────────────────────────────────────────────────

class PacketLossMonitor {
  constructor(window = PACKET_LOSS_WINDOW) {
    this._results = [];
    this._window = window;
  }

  record(success) {
    this._results.push(success ? 1 : 0);
    if (this._results.length > this._window) this._results.shift();
  }

  rate() {
    if (!this._results.length) return 0;
    const losses = this._results.filter((r) => r === 0).length;
    return parseFloat((losses / this._results.length).toFixed(3));
  }
}

// ─── NetworkStateClassifier ──────────────────────────────────────────────────

class NetworkStateClassifier {
  classify(metrics) {
    if (!metrics.dnsReachable) return QUALITY.OFFLINE;
    const { avgLatency, packetLoss } = metrics;
    if (avgLatency < 100 && packetLoss < 0.02) return QUALITY.GOOD;
    if (avgLatency < 500 && packetLoss < 0.15) return QUALITY.FAIR;
    return QUALITY.POOR;
  }
}

// ─── ConnectionLifecycleManager ──────────────────────────────────────────────

class ConnectionLifecycleManager {
  constructor() {
    this._lastStableAt = Date.now();
    this._reconnectCount = 0;
    this._connectedSocketIds = new Set();
  }

  registerSocket(socketId) {
    this._connectedSocketIds.add(socketId);
    this._lastStableAt = Date.now();
  }

  unregisterSocket(socketId) {
    this._connectedSocketIds.delete(socketId);
  }

  recordReconnect() {
    this._reconnectCount++;
    this._lastStableAt = Date.now();
  }

  getMetrics() {
    return {
      activeConnections: this._connectedSocketIds.size,
      lastStableAt: this._lastStableAt,
      reconnectCount: this._reconnectCount,
    };
  }
}

// ─── NetworkIntelligenceManager ──────────────────────────────────────────────

class NetworkIntelligenceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._options = {
      checkIntervalMs: options.checkIntervalMs || CHECK_INTERVAL_MS,
      dnsHost: options.dnsHost || DNS_CHECK_HOST,
      ...options,
    };

    this._state = this._buildInitialState();
    this._latency = new LatencyMonitor();
    this._packetLoss = new PacketLossMonitor();
    this._classifier = new NetworkStateClassifier();
    this._lifecycle = new ConnectionLifecycleManager();
    this._timer = null;
    this._probeHistory = [];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    this._scheduleCheck(0);
    console.log('[NetworkIntel:Server] ✅ Started');
    return this;
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  getState() {
    return { ...this._state };
  }

  registerSocket(socketId) {
    this._lifecycle.registerSocket(socketId);
    this.emit('socket:registered', { socketId });
  }

  unregisterSocket(socketId) {
    this._lifecycle.unregisterSocket(socketId);
    this.emit('socket:unregistered', { socketId });
  }

  recordReconnect(socketId) {
    this._lifecycle.recordReconnect();
    this.emit('socket:reconnected', { socketId });
  }

  // ── Private — Probing ──────────────────────────────────────────────────────

  _scheduleCheck(delay) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._runCheck(), delay ?? this._options.checkIntervalMs);
  }

  async _runCheck() {
    const start = Date.now();
    let dnsOk = false;

    try {
      await dns.lookup(this._options.dnsHost);
      const latencyMs = Date.now() - start;
      this._latency.record(latencyMs);
      this._packetLoss.record(true);
      dnsOk = true;
      this._probeHistory.push({ ts: Date.now(), success: true, latencyMs });
    } catch (_) {
      this._packetLoss.record(false);
      this._probeHistory.push({ ts: Date.now(), success: false });
    }

    if (this._probeHistory.length > 20) this._probeHistory.shift();

    const metrics = {
      dnsReachable: dnsOk,
      avgLatency: this._latency.average(),
      p95Latency: this._latency.p95(),
      packetLoss: this._packetLoss.rate(),
    };

    const quality = this._classifier.classify(metrics);
    const lifecycle = this._lifecycle.getMetrics();

    const newState = {
      internetAvailable: quality !== QUALITY.OFFLINE,
      internetQuality: quality,
      avgLatency: metrics.avgLatency,
      p95Latency: metrics.p95Latency,
      packetLoss: metrics.packetLoss,
      activeConnections: lifecycle.activeConnections,
      lastStableAt: lifecycle.lastStableAt,
      reconnectCount: lifecycle.reconnectCount,
      updatedAt: Date.now(),
    };

    const changed = JSON.stringify(newState) !== JSON.stringify(this._state);
    this._state = newState;

    if (changed) {
      this.emit('network:changed', newState);
    }

    this._scheduleCheck();
  }

  _buildInitialState() {
    return {
      internetAvailable: true,
      internetQuality: QUALITY.GOOD,
      avgLatency: 0,
      p95Latency: 0,
      packetLoss: 0,
      activeConnections: 0,
      lastStableAt: Date.now(),
      reconnectCount: 0,
      updatedAt: Date.now(),
    };
  }
}

module.exports = NetworkIntelligenceManager;
