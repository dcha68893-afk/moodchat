/**
 * mesh-relay.js — Server-Side Mesh Relay Service
 *
 * Handles:
 *  - Routing mesh packets between online users via WebSocket
 *  - Storing packets for offline users (store-and-forward)
 *  - Flood/spam protection per peer
 *  - Packet expiry cleanup (48h)
 *  - ACK propagation
 *  - Mesh room management (users join their mesh:deviceId room)
 *
 * Mount in server.js AFTER Socket.IO is initialised:
 *   require('./mesh-relay')(io, sequelize);
 */

'use strict';

const MAX_PKT_SIZE    = 64 * 1024;      // 64KB per packet
const PKT_EXPIRY_MS   = 48 * 60 * 60 * 1000; // 48h
const RATE_LIMIT_MAX  = 120;            // packets/min per socket
const RATE_WIN_MS     = 60_000;
const MAX_STORED_PKTS = 200;            // per offline user

module.exports = function installMeshRelay(io, sequelize) {
    if (!io) { console.warn('[MeshRelay] No Socket.IO instance — skipping'); return; }

    // ── In-memory offline packet store ──────────────────────────────────
    // In production, persist to DB/Redis instead
    const _offlineStore = new Map(); // userId → [{ packet, storedAt }]
    const _deviceMap    = new Map(); // deviceId → socketId
    const _rateMap      = new Map(); // socketId → { count, windowStart }

    // ── Packet expiry cleanup (every 30 minutes) ─────────────────────────
    setInterval(() => {
        const now = Date.now();
        for (const [userId, packets] of _offlineStore) {
            const fresh = packets.filter(p => now - p.storedAt < PKT_EXPIRY_MS);
            if (fresh.length === 0) _offlineStore.delete(userId);
            else _offlineStore.set(userId, fresh);
        }
    }, 30 * 60_000);

    // ── Rate limiter ─────────────────────────────────────────────────────
    function _checkRate(socketId) {
        const now  = Date.now();
        const entry = _rateMap.get(socketId) || { count: 0, windowStart: now };
        if (now - entry.windowStart > RATE_WIN_MS) { entry.count = 0; entry.windowStart = now; }
        entry.count++;
        _rateMap.set(socketId, entry);
        return entry.count <= RATE_LIMIT_MAX;
    }

    // ── Socket.IO mesh namespace ─────────────────────────────────────────
    io.on('connection', socket => {
        // User announces their mesh deviceId on connect
        socket.on('mesh:register_device', ({ deviceId, userId }) => {
            if (!deviceId) return;
            _deviceMap.set(deviceId, socket.id);
            socket.join(`mesh:${deviceId}`);
            if (userId) socket.join(`mesh:user:${userId}`);
            socket.data.meshDeviceId = deviceId;
            socket.data.meshUserId   = userId;

            // Deliver stored offline packets
            const stored = _offlineStore.get(deviceId) || _offlineStore.get(String(userId)) || [];
            const now    = Date.now();
            const fresh  = stored.filter(p => now - p.storedAt < PKT_EXPIRY_MS);
            if (fresh.length > 0) {
                fresh.forEach(({ packet }) => socket.emit('mesh:packet', packet));
                _offlineStore.delete(deviceId);
                _offlineStore.delete(String(userId));
                console.log(`[MeshRelay] Delivered ${fresh.length} stored packet(s) to ${deviceId}`);
            }
        });

        // Relay packet from one client to another
        socket.on('mesh:packet', (data) => {
            if (!_checkRate(socket.id)) {
                socket.emit('mesh:error', { code: 'RATE_LIMITED', msg: 'Too many packets' });
                return;
            }
            const packet = data?.packet || data;
            if (!packet || !packet.to || !packet.packetId) return;
            // Size check
            try {
                if (JSON.stringify(packet).length > MAX_PKT_SIZE) {
                    socket.emit('mesh:error', { code: 'PKT_TOO_LARGE' });
                    return;
                }
            } catch(_) { return; }

            const toDeviceId = packet.to;
            const targetSid  = _deviceMap.get(toDeviceId);
            const enriched   = { ...packet, _fromPeer: socket.data.meshDeviceId, _relayedAt: Date.now() };

            if (targetSid) {
                // Target is online — deliver directly
                io.to(`mesh:${toDeviceId}`).emit('mesh:packet', enriched);
                // Send ACK back to sender
                socket.emit('mesh:ack', { ackFor: packet.packetId, deliveredTo: toDeviceId, ts: Date.now() });
            } else {
                // Target offline — store for later
                const key = toDeviceId;
                const stored = _offlineStore.get(key) || [];
                if (stored.length >= MAX_STORED_PKTS) stored.shift(); // drop oldest
                stored.push({ packet: enriched, storedAt: Date.now() });
                _offlineStore.set(key, stored);
                // Partial delivery ack
                socket.emit('mesh:ack', { ackFor: packet.packetId, status: 'stored', ts: Date.now() });
            }
        });

        // ACK propagation
        socket.on('mesh:ack', (ack) => {
            if (!ack || !ack.ackFor) return;
            // Forward ACK to original sender if known
            const fromDevice = ack.to || ack.originalSender;
            if (fromDevice) io.to(`mesh:${fromDevice}`).emit('mesh:ack', ack);
        });

        // Peer routing table exchange
        socket.on('mesh:routing_table', ({ to, table }) => {
            if (!to || !table) return;
            io.to(`mesh:${to}`).emit('mesh:routing_table', { from: socket.data.meshDeviceId, table });
        });

        // Cleanup on disconnect
        socket.on('disconnect', () => {
            if (socket.data.meshDeviceId) {
                _deviceMap.delete(socket.data.meshDeviceId);
                // Notify nearby peers
                socket.broadcast.emit('mesh:peer_offline', { deviceId: socket.data.meshDeviceId });
            }
            _rateMap.delete(socket.id);
        });
    });

    // ── Expose flush API for admin ────────────────────────────────────────
    return {
        getOfflineQueueSize : () => [..._offlineStore.values()].reduce((s,a) => s+a.length, 0),
        getOnlinePeerCount  : () => _deviceMap.size,
        flushStoredPackets  : (deviceId) => { _offlineStore.delete(deviceId); },
    };
};
