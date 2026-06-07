'use strict';
function installMessageDeliveryPatch(io, app) {
    if (!io || !app) return;
    app.post('/api/internal/verify-delivery', (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.json({ ok: false, reason: 'userId required' });
            const uid = parseInt(userId, 10);
            const roomNames = [`user:${uid}`, `user_${uid}`, `user:${String(uid)}`, `user_${String(uid)}`];
            const rooms = [];
            const adapter = io.sockets && io.sockets.adapter;
            if (adapter && adapter.rooms) {
                for (const room of roomNames) {
                    const roomSet = adapter.rooms.get(room);
                    if (roomSet && roomSet.size > 0) rooms.push({ room, sockets: roomSet.size });
                }
            }
            return res.json({ ok: true, userId: uid, inRoom: rooms.length > 0, rooms, timestamp: Date.now() });
        } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
    });
    app.post('/api/internal/force-deliver', (req, res) => {
        try {
            const { userId, event, payload } = req.body;
            if (!userId || !event) return res.json({ ok: false, reason: 'userId and event required' });
            const uid = parseInt(userId, 10);
            const roomNames = [`user:${uid}`, `user_${uid}`, `user:${String(uid)}`, `user_${String(uid)}`];
            let delivered = false;
            for (const room of roomNames) { try { io.to(room).emit(event, payload || {}); delivered = true; } catch (_) {} }
            return res.json({ ok: true, delivered, userId: uid, event, timestamp: Date.now() });
        } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
    });
    console.log('[Phase15] Message delivery patch installed');
}
module.exports = { installMessageDeliveryPatch };
