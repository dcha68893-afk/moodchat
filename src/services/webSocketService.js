'use strict';

/**
 * webSocketService.js — FIXED v3.2.0
 *
 * ROOT CAUSE FIXES:
 *  1. verifyToken() no longer calls socket.disconnect(true) — callers handle rejection
 *  2. setupConnectionHandler() uses the io.use() middleware pattern so auth failures
 *     call next(new Error(...)) instead of connecting then immediately disconnecting
 *  3. Duplicate session handling keeps the NEW socket and removes the OLD one (not vice versa)
 *  4. All socket.disconnect() calls inside io.on('connection') replaced with early returns
 *     that were already handled in io.use()
 *
 * FIX #2 (v3.1.0):
 *  The old _jwtVerify() called jwt.verify(token, JWT_SECRET || JWT_ACCESS_SECRET).
 *  This is the WRONG order — tokenService signs with JWT_ACCESS_SECRET || JWT_SECRET.
 *  When these differ (Render/Railway/Heroku), verification produced "invalid signature".
 *  FIX: Delegate to tokenService.verifyAccessToken() — single source of truth.
 *
 * BUG 3 FIX (v3.2.0):
 *  registerUser() previously only joined user:${uid} and user_${uid} using the integer-
 *  coerced uid. In some Node.js/Socket.IO edge cases, a room joined as user:2 (integer)
 *  doesn't match an emit to user:2 (string). Fix: also joins user:${String(uid)} and
 *  user_${String(uid)} so all four variants are covered. All rooms the socket is actually
 *  in are logged after joining so you can confirm in server logs during the next test.
 *  Same fix applied to the join_user_room event handler.
 */

const db   = require('../models');
const User = db.Users || db.User;

// ── FIX #2: Delegate token verification to tokenService (single source of truth) ──
let _jwtVerify = null;
try {
    // tokenService uses the correct JWT_ACCESS_SECRET for verification
    const tokenService = require('../services/tokenService');
    _jwtVerify = (token) => {
        try {
            const result = tokenService.verifyAccessToken(token);
            if (!result.valid) {
                return { valid: false, userId: null, reason: result.message || result.error };
            }
            const decoded = result.decoded;
            const uid = parseInt(decoded.userId || decoded.id || decoded.sub, 10);
            return { valid: !!uid, userId: uid || null, reason: uid ? 'ok' : 'no-userId-in-payload' };
        } catch (err) {
            return { valid: false, userId: null, reason: err.message };
        }
    };
    console.log('[WSService] Token verification delegated to tokenService ✅');
} catch (err) {
    // FIX: Hard fail — do NOT allow connections when tokenService is missing.
    // The old bypass (valid: true) was a security hole that let unauthenticated
    // sockets connect in production when there was a circular dependency.
    console.error('[WSService] CRITICAL: tokenService failed to load:', err.message);
    _jwtVerify = () => ({ valid: false, userId: null, reason: 'tokenService-unavailable' });
}

const STALE_REAPER_INTERVAL = 60_000;

class WebSocketService {
    constructor() {
        this.io          = null;
        this.onlineUsers = new Map(); // userId(int) → Set<socketId(string)>
        this.userSockets = this.onlineUsers; // legacy alias
        this.wsClients   = new Map(); // userId(int) → Set<WebSocket>

        this._reaperTimer = setInterval(() => this._pruneAllStale(), STALE_REAPER_INTERVAL);
        if (this._reaperTimer.unref) this._reaperTimer.unref();
    }

    // ── IO setup ──────────────────────────────────────────────────────────────

    setIO(io) {
        this.io = io || null;
        if (io) {
            global.__socketIO = io;
            global.__io = io;
            global.io = io;
            console.log('[WSService] Socket.IO instance exposed globally');
        }
        return this;
    }

    init(io) { return this.setIO(io); }

    /**
     * FIX: Auth is now done in io.use() BEFORE 'connection' fires.
     * This means failed auth calls next(new Error()) and the socket never
     * reaches the 'connection' handler — no "connect then immediately disconnect".
     *
     * Previously auth was done INSIDE io.on('connection'), which caused:
     *   1. Socket connects → client fires 'connect' event  ✓
     *   2. Server calls socket.disconnect(true)            ← "io server disconnect"
     */
    setupConnectionHandler() {
        const io = this.getIO();
        if (!io) {
            console.error('[WSService] setupConnectionHandler: io not set — call init(io) first');
            return this;
        }

        // ── STEP 1: Auth is handled by server.js before setupConnectionHandler() is called ──
        // FIX B-10: Removed duplicate io.use() auth middleware — server.js already applies
        // socketAuthenticate via io.use() before calling this method. Having two auth
        // middlewares doubles token verification on every connection.
        // socket._authenticatedUserId is set by the server.js middleware and available here.

        // ── STEP 2: Connection handler — auth is already verified ─────────────
        io.on('connection', (socket) => {
            const userId = socket._authenticatedUserId;

            if (!userId) {
                // Should never reach here (io.use handles it), but be safe
                console.error('[WSService] Connection reached handler without userId — bug in middleware');
                socket.disconnect(true);
                return;
            }

            // FIX: Handle duplicate sessions correctly — disconnect OLD, keep NEW
            this._handleDuplicateSession(userId, socket);

            // Register new socket
            this.registerUser(userId, socket);
            console.log(`[WSService] ✅ socket connected uid=${userId} sid=${socket.id}`);

            // Tell client auth succeeded
            socket.emit('authenticated', { userId, authenticated: true, timestamp: Date.now() });

            // PHASE10: Register with HybridTransportRuntime for offline queue flush
            try {
                const htr = global.__HybridTransportRuntime;
                if (htr) {
                    const ip = socket.handshake?.address || '';
                    const subnetKey = ip.split('.').slice(0, 3).join('.');
                    htr.lan.register(String(userId), socket.id, subnetKey);
                    // Flush any queued messages for this user
                    htr.flushOfflineQueue(String(userId));
                    // Store userId on socket for HybridTransportRuntime lookups
                    socket._authenticatedUserId = String(userId);
                }
            } catch(_) {}

            // Proactively join all chat rooms
            this._joinUserChatRooms(userId, socket).catch(() => {});

            // Allow client to join additional rooms
            // FIX-002: socket.off() before every socket.on() prevents listener accumulation on reconnect
            socket.off('join').on('join', ({ room } = {}) => {
                if (room && typeof room === 'string') {
                    socket.join(room);
                    console.log(`[WSService] uid=${userId} joined room: ${room}`);
                }
            });

            socket.off('join_user_room').on('join_user_room', ({ userId: uid } = {}) => {
                const rid = parseInt(uid, 10);
                if (rid && rid === userId) {
                    const strRid = String(rid);
                    socket.join(`user:${rid}`);
                    socket.join(`user_${rid}`);
                    socket.join(`user:${strRid}`);   // BUG 3 FIX: string-coerced variants
                    socket.join(`user_${strRid}`);
                    try {
                        const actualRooms = Array.from(socket.rooms || []);
                        console.log(`[WSService] uid=${userId} confirmed join user rooms — in rooms: [${actualRooms.join(', ')}]`);
                    } catch (_) {
                        console.log(`[WSService] uid=${userId} confirmed join user rooms`);
                    }
                }
            });

            socket.off('disconnect').on('disconnect', (reason) => {
                this.removeUser(userId, socket);
                console.log(`[WSService] socket disconnected uid=${userId} sid=${socket.id} reason=${reason}`);
            });

            // ── TYPING INDICATORS — FIX: were completely missing ──────────────
            socket.off('typing:start').on('typing:start', ({ chatId } = {}) => {
                if (!chatId) return;
                socket.to(`chat:${chatId}`).emit('typing:start', {
                    chatId,
                    userId: String(userId),
                    timestamp: Date.now(),
                });
            });

            socket.off('typing:stop').on('typing:stop', ({ chatId } = {}) => {
                if (!chatId) return;
                socket.to(`chat:${chatId}`).emit('typing:stop', {
                    chatId,
                    userId: String(userId),
                    timestamp: Date.now(),
                });
            });

            // SETTINGS: relay cross-device settings changes
            socket.off('settings:update').on('settings:update', (payload) => {
                try {
                    if (!payload || typeof payload !== 'object') return;
                    const settings = payload.settings || payload;
                    // Relay to all OTHER sockets of this user (not the sender)
                    const io = this.getIO();
                    if (!io) return;
                    const updateMsg = {
                        type:      'settings_updated',
                        userId:    String(userId),
                        settings,
                        timestamp: Date.now()
                    };
                    [`user:${userId}`, `user_${userId}`, `user:${String(userId)}`, `user_${String(userId)}`].forEach(room => {
                        io.to(room).except(socket.id).emit('settings_updated', updateMsg);
                    });
                } catch (e) {
                    console.warn('[WSService] settings:update relay error:', e.message);
                }
            });
        });

        console.log('[WSService] Connection handler registered ✅');
        return this;
    }

    getIO() {
        return this.io || global.__socketIO || global.__io || global.io || null;
    }

    // ── TOKEN VERIFICATION ────────────────────────────────────────────────────

    /**
     * FIX: verifyTokenOnly() — only returns result, NEVER calls socket.disconnect().
     * The caller (io.use middleware) is responsible for calling next(error).
     */
    verifyTokenOnly(token) {
        if (!token || typeof token !== 'string' || token.length < 10) {
            return { valid: false, userId: null, reason: 'token-missing-or-too-short' };
        }
        return _jwtVerify(token);
    }

    /**
     * Legacy verifyToken kept for backward compat but no longer disconnects socket.
     * @deprecated Use verifyTokenOnly() — this method no longer disconnects on failure.
     */
    verifyToken(token, socket = null) {
        const result = this.verifyTokenOnly(token);
        if (!result.valid && socket) {
            console.warn(`[WSService] ⛔ Invalid token for socket ${socket && socket.id}: ${result.reason}`);
            // FIX: emit auth_error but DO NOT call socket.disconnect() here.
            // Disconnection should only happen from io.use() via next(error).
            try { socket.emit('auth_error', { reason: result.reason }); } catch (_) {}
        }
        return result;
    }

    // ── REGISTER / REMOVE ─────────────────────────────────────────────────────

    /**
     * FIX: _handleDuplicateSession — disconnect OLD sockets, keep NEW one.
     * Previous code sometimes disconnected the new socket, causing the
     * "connected then immediately disconnected" symptom.
     */
    _handleDuplicateSession(userId, newSocket) {
        const uid = parseInt(userId, 10);
        const existingIds = this.onlineUsers.get(uid);
        if (!existingIds || existingIds.size === 0) return;

        const io = this.getIO();
        if (!io) return;

        // Allow up to 2 concurrent sockets per user (supports multiple browser tabs).
        // Only evict oldest sockets when the count exceeds this limit.
        const MAX_SOCKETS_PER_USER = 2;

        // Build list of verified-alive sockets (exclude stale references)
        const aliveSids = Array.from(existingIds).filter(sid => io.sockets.sockets.has(sid));

        if (aliveSids.length < MAX_SOCKETS_PER_USER) {
            // Within limit — prune stale refs only, don't disconnect anyone
            for (const sid of Array.from(existingIds)) {
                if (!io.sockets.sockets.has(sid)) existingIds.delete(sid);
            }
            return;
        }

        // Over limit — evict oldest socket(s) to make room for new one
        const toEvict = aliveSids.slice(0, aliveSids.length - (MAX_SOCKETS_PER_USER - 1));
        for (const sid of toEvict) {
            if (sid === newSocket.id) continue;
            const oldSocket = io.sockets.sockets.get(sid);
            if (oldSocket) {
                console.log(`[WSService] Evicting oldest socket ${sid} for uid=${uid} (limit ${MAX_SOCKETS_PER_USER})`);
                try {
                    oldSocket.emit('session_replaced', { reason: 'New connection from same account (limit reached)' });
                    oldSocket.disconnect(true);
                } catch (_) {}
            }
            existingIds.delete(sid);
        }
    }

    registerUser(userId, socketOrSocketId) {
        const uid      = parseInt(userId, 10);
        const socketId = typeof socketOrSocketId === 'string'
            ? socketOrSocketId
            : (socketOrSocketId && socketOrSocketId.id);

        if (!uid || !socketId) return false;

        if (!this.onlineUsers.has(uid)) this.onlineUsers.set(uid, new Set());
        this.onlineUsers.get(uid).add(socketId);

        // FIX: broadcast user:online to all connected users so contacts update presence indicator
        try {
            const io = this.getIO();
            if (io) {
                io.emit('user:online', { userId: uid, timestamp: Date.now() });
            }
        } catch(_) {}

        if (socketOrSocketId && typeof socketOrSocketId.join === 'function') {
            const joinRooms = () => {
                // BUG 3 FIX: Join all four room name variants to survive integer/string
                // coercion edge cases in Socket.IO room keys. The server may emit to
                // user:2 (string) while the room was joined as user:2 (integer-coerced);
                // in some Node.js/Socket.IO versions these don't match. Joining all four
                // forms guarantees delivery regardless of how the emit key is formed.
                const strUid = String(uid);
                socketOrSocketId.join(`user:${uid}`);      // integer coerced (original)
                socketOrSocketId.join(`user_${uid}`);      // underscore, integer coerced
                socketOrSocketId.join(`user:${strUid}`);   // explicit string variant
                socketOrSocketId.join(`user_${strUid}`);   // underscore, explicit string

                // Log all rooms the socket is actually in so you can confirm in server
                // logs that the right room names were registered during the next test.
                try {
                    const actualRooms = Array.from(socketOrSocketId.rooms || []);
                    console.log(`[WSService] registerUser uid=${uid} socket=${socketId} rooms joined ✅ — in rooms: [${actualRooms.join(', ')}]`);
                } catch (_) {
                    console.log(`[WSService] registerUser uid=${uid} socket=${socketId} rooms joined ✅`);
                }
            };
            try {
                joinRooms();
            } catch (err) {
                console.warn(`[WSService] Room join failed (retry): ${err.message}`);
                setTimeout(() => {
                    try { joinRooms(); } catch (e) {
                        console.error(`[WSService] Room join retry failed uid=${uid}: ${e.message}`);
                    }
                }, 100);
            }
        }

        return true;
    }

    removeUser(userId, socketOrSocketId) {
        const uid      = parseInt(userId, 10);
        const socketId = typeof socketOrSocketId === 'string'
            ? socketOrSocketId
            : (socketOrSocketId && socketOrSocketId.id);

        if (!uid) return false;

        const set = this.onlineUsers.get(uid);
        if (set) {
            if (socketId) set.delete(socketId);
            if (!socketId || set.size === 0) {
                this.onlineUsers.delete(uid);
                // FIX: broadcast user:offline only when last socket disconnects
                try {
                    const io = this.getIO();
                    if (io) {
                        io.emit('user:offline', { userId: uid, lastSeen: new Date().toISOString(), timestamp: Date.now() });
                    }
                } catch(_) {}
            }
        }

        console.log(`[WSService] removeUser uid=${uid} socket=${socketId}`);
        return true;
    }

    registerUserSocket(userId, socketId)   { return this.registerUser(userId, socketId); }
    unregisterUserSocket(userId, socketId) { return this.removeUser(userId, socketId); }

    // ── IS USER ONLINE ────────────────────────────────────────────────────────

    async isUserOnline(userId) {
        const uid = parseInt(userId, 10);
        if (!uid) return false;

        const sockets = this.onlineUsers.get(uid);
        if (sockets && sockets.size > 0) {
            const io = this.getIO();
            if (io) {
                for (const sid of sockets) {
                    if (this._isSocketAliveInAdapter(io, sid)) return true;
                }
                this.onlineUsers.delete(uid);
            } else {
                return true;
            }
        }

        const wsClients = this.wsClients.get(uid);
        if (wsClients && wsClients.size > 0) {
            for (const ws of wsClients) {
                if (ws.readyState === 1) return true;
            }
        }

        const io = this.getIO();
        if (io) {
            const adapter = io.sockets && io.sockets.adapter;
            if (adapter && adapter.rooms) {
                for (const room of [`user:${uid}`, `user_${uid}`]) {
                    const roomSet = adapter.rooms.get(room);
                    if (roomSet && roomSet.size > 0) return true;
                }
            }

            if (typeof io.in === 'function') {
                for (const room of [`user:${uid}`, `user_${uid}`]) {
                    try {
                        const connected = await io.in(room).fetchSockets().catch(() => []);
                        if (connected && connected.length > 0) return true;
                    } catch (_) {}
                }
            }
        }

        if (User && typeof User.findByPk === 'function') {
            try {
                const user = await User.findByPk(uid, { attributes: ['id', 'socketIds'] });
                if (Array.isArray(user && user.socketIds) && user.socketIds.length > 0) return true;
            } catch (_) {}
        }

        return false;
    }

    // ── SOCKET ID LOOKUP ──────────────────────────────────────────────────────

    async getSocketIdsForUser(userId) {
        const uid = parseInt(userId, 10);
        if (!uid) return [];

        const inMemory = this.onlineUsers.get(uid);
        if (inMemory && inMemory.size > 0) return Array.from(inMemory);

        if (User && typeof User.findByPk === 'function') {
            try {
                const user = await User.findByPk(uid, { attributes: ['id', 'socketIds'] });
                return Array.isArray(user && user.socketIds) ? user.socketIds.filter(Boolean) : [];
            } catch (_) {}
        }
        return [];
    }

    // ── SEND TO USER ──────────────────────────────────────────────────────────

    async sendToUser(userId, event, data = {}) {
        const uid = parseInt(userId, 10);
        if (!uid || !event) return false;

        const _emitLogKey = `${uid}:${event}`;
        const _now = Date.now();
        if (!this._emitLogCache) this._emitLogCache = new Map();
        if (!this._emitLogCache.has(_emitLogKey) || _now - this._emitLogCache.get(_emitLogKey) > 5000) {
            this._emitLogCache.set(_emitLogKey, _now);
            console.log(`[WSService] EMITTING TO: uid=${uid} event=${event}`);
        }

        // PHASE10: Route through HybridTransportRuntime when available
        // This gives us LAN routing + offline queue + mesh fallback
        const htr = global.__HybridTransportRuntime;
        if (htr) {
            const result = await htr.deliver(String(uid), event, data).catch(() => null);
            if (result?.ok) return true;
            // If queued (user offline), still return true — message will deliver on reconnect
            if (result?.queued) return true;
        }

        const payload = { ...data, timestamp: data.timestamp || new Date().toISOString() };
        let delivered = false;
        const io      = this.getIO();

        const wsClients = this.wsClients.get(uid);
        if (wsClients && wsClients.size > 0) {
            const raw = JSON.stringify({ type: event, payload, timestamp: payload.timestamp });
            for (const client of wsClients) {
                try {
                    if (client && client.readyState === 1) { client.send(raw); delivered = true; }
                } catch (_) {}
            }
        }

        if (!io) {
            // FIX: Warn loudly instead of silently returning false.
            // If this appears in logs, wsService.setIO(io) was never called at startup.
            console.warn(
                `[WSService] ⚠️ sendToUser: io is NULL — cannot deliver event="${event}" to uid=${uid}.` +
                ' Call wsService.setIO(io) at server startup before accepting requests.'
            );
            return delivered;
        }

        // Emit to ALL room name variants — client may have joined with int or string userId
        const strUid = String(uid);
        const rooms = [
            `user:${uid}`,    // integer coerced
            `user_${uid}`,    // integer underscore
            `user:${strUid}`, // explicit string
            `user_${strUid}`  // explicit string underscore
        ];
        for (const room of rooms) {
            try { io.to(room).emit(event, payload); delivered = true; } catch (_) {}
        }

        const socketIds = await this.getSocketIdsForUser(uid);
        for (const sid of socketIds) {
            if (!this._isSocketAliveInAdapter(io, sid)) {
                const set = this.onlineUsers.get(uid);
                if (set) set.delete(sid);
                continue;
            }
            try { io.to(sid).emit(event, payload); delivered = true; } catch (_) {}
        }

        return delivered;
    }

    // ── CALL / SIGNAL HELPERS ─────────────────────────────────────────────────

    async notifyCallInitiated(userId, data = {}) {
        // FIX-003: single canonical event 'call:incoming' only
        // The previous dual-emit ('call:incoming' + 'incoming_call') caused phones to ring twice
        // and black screens on call end. Frontend listens for 'call:incoming' (colon-style).
        await this.sendToUser(userId, 'call:incoming', data);
        return true;
    }

    async sendSignal(userId, payload = {}) {
        return this.sendToUser(userId, 'webrtc:signal', payload);
    }

    async sendNotification(userId, notification = {}) {
        return this.sendToUser(userId, 'notification:new', notification);
    }

    /**
     * Emit settings_updated to all sockets for a user so every open
     * tab or device receives the change and can re-apply settings immediately.
     *
     * @param {number|string} userId
     * @param {Object}        settings  Partial or full AppSettings-schema object
     * @returns {boolean} true if delivered to at least one socket
     */
    async notifySettingsUpdated(userId, settings = {}) {
        const payload = {
            type:      'settings_updated',
            userId:    String(userId),
            settings,
            timestamp: new Date().toISOString()
        };
        return this.sendToUser(userId, 'settings_updated', payload);
    }

    async notifyMoodShared(userId, payload = {})  { return this.sendToUser(userId, 'mood:shared', payload); }
    async notifyFriendMood(userId, payload = {})  { return this.sendToUser(userId, 'mood:friend', payload); }

    async notifyStatusCreated(status) {
        return this.broadcast('status:created', {
            statusId: status.id, userId: status.userId, type: status.type,
            content: status.content, mediaUrl: status.mediaUrl,
            createdAt: status.createdAt, expiresAt: status.expiresAt,
            timestamp: new Date().toISOString()
        });
    }

    async notifyStatusViewed(statusId, viewerId, ownerId) {
        const payload = { statusId, viewerId, ownerId, timestamp: new Date().toISOString() };
        await this.sendToUser(ownerId, 'status:viewed', payload);
        return this.broadcast('status:viewer_update', { statusId, viewerCount: 1, timestamp: payload.timestamp });
    }

    async notifyStatusExpired(statusId, userId) {
        return this.broadcast('status:expired', { statusId, userId, timestamp: new Date().toISOString() });
    }

    async notifyStatusUpdated(status) {
        return this.broadcast('status:updated', {
            statusId: status.id, userId: status.userId,
            updates: { content: status.content, isPublic: status.isPublic, updatedAt: status.updatedAt },
            timestamp: new Date().toISOString()
        });
    }

    async notifyStatusDeleted(statusId, userId) {
        // PHASE10: Record in hydration engine to prevent stale status resurrection
        try {
            global.__HydrationEngine?.recordDeletion?.('status', statusId, null, 'deleted');
        } catch(_) {}
        return this.broadcast('status:deleted', {
            statusId, userId,
            entityType: 'status', entityId: String(statusId),
            timestamp: new Date().toISOString()
        });
    }

    // ── RAW WS CLIENT REGISTRATION ────────────────────────────────────────────

    registerWebSocketClient(userId, ws) {
        const uid = parseInt(userId, 10);
        if (!uid || !ws) return false;
        if (!this.wsClients.has(uid)) this.wsClients.set(uid, new Set());
        this.wsClients.get(uid).add(ws);
        return true;
    }

    unregisterWebSocketClient(userId, ws) {
        const uid = parseInt(userId, 10);
        if (!uid) return false;
        const set = this.wsClients.get(uid);
        if (!set) return false;
        set.delete(ws);
        if (set.size === 0) this.wsClients.delete(uid);
        return true;
    }

    // ── BROADCAST ─────────────────────────────────────────────────────────────

    broadcast(event, data = {}) {
        const io = this.getIO();
        if (!io) return false;
        try { io.emit(event, data); return true; } catch (_) { return false; }
    }

    broadcastToChat(chatId, event, payload = {}, participantIds = null) {
        const io = this.getIO();
        if (!io || !chatId || !event) return false;
        try {
            const enriched = { ...payload, chatId, timestamp: payload.timestamp || new Date().toISOString() };

            // PHASE10: Record tombstones and emit entity:deleted for cache invalidation
            const _isDeletion = event === 'message:deleted' || event === 'MESSAGE_DELETED' ||
                                event === 'message:delete' || event === 'msg_deleted';
            const _isChatDeletion = event === 'chat:deleted' || event === 'CHAT_DELETED';
            if (_isDeletion) {
                const msgId = payload.messageId || payload.id;
                if (msgId) {
                    // Record in MessageEntityStore
                    try { global.__MessageEntityStore?.recordDelete?.(msgId, chatId, 'deleted'); } catch(_) {}
                    // Record in HydrationEngine
                    try { global.__HydrationEngine?.recordDeletion?.('message', msgId, chatId, 'deleted'); } catch(_) {}
                    // Broadcast entity:deleted so client DeletionRegistry can evict caches
                    const deletionPayload = { entityType: 'message', entityId: String(msgId), chatId, ts: Date.now() };
                    io.to(`chat:${chatId}`).emit('entity:deleted', deletionPayload);
                    io.to(`chat_${chatId}`).emit('entity:deleted', deletionPayload);
                }
            }
            if (_isChatDeletion) {
                try { global.__HydrationEngine?.recordDeletion?.('chat', chatId, null, 'deleted'); } catch(_) {}
                const deletionPayload = { entityType: 'chat', entityId: String(chatId), ts: Date.now() };
                io.to(`chat:${chatId}`).emit('entity:deleted', deletionPayload);
                if (Array.isArray(participantIds)) {
                    participantIds.forEach(uid => {
                        if (uid) io.to(`user:${uid}`).emit('entity:deleted', deletionPayload);
                    });
                }
            }

            // Emit to chat room (members who joined)
            io.to(`chat:${chatId}`).emit(event, enriched);
            io.to(`chat_${chatId}`).emit(event, enriched);
            // CRITICAL FIX: Also emit to each participant's user room
            // This ensures delivery even when the receiver hasn't joined the chat room
            if (Array.isArray(participantIds) && participantIds.length > 0) {
                for (const uid of participantIds) {
                    if (uid) {
                        io.to(`user:${uid}`).emit(event, enriched);
                        io.to(`user_${uid}`).emit(event, enriched);
                    }
                }
            }
            return true;
        } catch (_) { return false; }
    }

    // broadcastToChatWithParticipants: fetches participants from DB then broadcasts
    async broadcastToChatFull(chatId, event, payload = {}) {
        const io = this.getIO();
        if (!io || !chatId || !event) return false;
        try {
            const db = require('../models');
            const sequelize = db.sequelize || db;
            const participants = await sequelize.query(
                'SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId',
                { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
            );
            const ids = (participants || []).map(p => p.userId);
            return this.broadcastToChat(chatId, event, payload, ids);
        } catch (err) {
            // Fallback to room-only broadcast
            return this.broadcastToChat(chatId, event, payload);
        }
    }

    broadcastToGroup(groupId, event, payload = {}, excludeSenderId = null) {
        const io = this.getIO();
        if (!io || !groupId || !event) return false;
        try {
            const groupPayload = { ...payload, groupId, timestamp: payload.timestamp || new Date().toISOString() };

            // PHASE10: Record group message deletions in entity stores
            const _isGroupDel = event === 'group:message:deleted' || event === 'GROUP_MESSAGE_DELETED';
            if (_isGroupDel) {
                const msgId = payload.messageId || payload.id;
                if (msgId) {
                    try { global.__MessageEntityStore?.recordDelete?.(msgId, `group:${groupId}`, 'deleted'); } catch(_) {}
                    try { global.__HydrationEngine?.recordDeletion?.('message', msgId, `group:${groupId}`, 'deleted'); } catch(_) {}
                }
            }

            // Emit to group rooms (joined members)
            io.to(`group:${groupId}`).emit(event, groupPayload);
            io.to(`group_${groupId}`).emit(event, groupPayload);
            // Also send to sender user rooms (multi-device support)
            if (excludeSenderId) {
                io.to(`user:${excludeSenderId}`).emit(event, groupPayload);
                io.to(`user_${excludeSenderId}`).emit(event, groupPayload);
            }
            return true;
        } catch (error) {
            console.error('[WSService] Group broadcast failed:', error);
            return false;
        }
    }

    // Fallback: send group event to all members via user rooms
    async broadcastGroupMessageToMembers(groupId, event, payload) {
        const io = this.getIO();
        if (!io || !groupId) return false;
        try {
            const db = require('../models');
            const sequelize = db.sequelize || db;
            if (!sequelize) return false;
            const members = await sequelize.query(
                'SELECT "userId" FROM "GroupMembers" WHERE "groupId" = :groupId',
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            const groupPayload = { ...payload, groupId, timestamp: payload.timestamp || new Date().toISOString() };
            for (const { userId } of (members || [])) {
                io.to(`user:${userId}`).emit(event, groupPayload);
                io.to(`user_${userId}`).emit(event, groupPayload);
            }
            io.to(`group:${groupId}`).emit(event, groupPayload);
            return true;
        } catch (err) {
            console.warn('[WSService] broadcastGroupMessageToMembers failed:', err.message);
            return false;
        }
    }

    async sendGroupMessage(groupId, message, senderId) {
        const payload = {
            type: 'group_message', groupId,
            message: {
                id: message.id, content: message.content, senderId: message.senderId,
                senderName: message.senderName,
                timestamp: message.timestamp || new Date().toISOString(),
                messageType: message.messageType || 'text'
            }
        };
        return this.broadcastToGroup(groupId, 'group:message', payload, senderId);
    }

    async notifyGroupMembershipChange(groupId, action, memberData, changedByUserId) {
        return this.broadcastToGroup(groupId, 'group:membership_change', {
            groupId, action, member: memberData, changedBy: changedByUserId,
            timestamp: new Date().toISOString()
        });
    }

    async notifyGroupUpdated(groupId, groupData, updatedByUserId) {
        return this.broadcastToGroup(groupId, 'group:updated', {
            groupId, group: groupData, updatedBy: updatedByUserId,
            timestamp: new Date().toISOString()
        });
    }

    // ── RECONNECT HOOK ────────────────────────────────────────────────────────

    handleReconnect(userId, socketId) {
        if (userId && socketId) return this.registerUser(userId, socketId);
        return true;
    }

    connect(io)                  { return this.setIO(io); }
    disconnect(userId, socketId) {
        if (userId && socketId) return this.removeUser(userId, socketId);
        return true;
    }

    // ── STATS ─────────────────────────────────────────────────────────────────

    getOnlineCount()   { return this.onlineUsers.size; }
    getOnlineUserIds() { return Array.from(this.onlineUsers.keys()); }

    // ── PRIVATE LIVENESS & REAPER ─────────────────────────────────────────────

    _isSocketAliveInAdapter(io, sid) {
        if (!io || !sid) return false;
        try {
            if (io.sockets && io.sockets.sockets) {
                return io.sockets.sockets.has(sid);
            }
        } catch (_) {}
        return false;
    }

    _pruneAllStale() {
        const io = this.getIO();
        if (!io) return;
        let pruned = 0;
        for (const [uid, sids] of this.onlineUsers) {
            for (const sid of sids) {
                if (!this._isSocketAliveInAdapter(io, sid)) {
                    sids.delete(sid); pruned++;
                }
            }
            if (sids.size === 0) this.onlineUsers.delete(uid);
        }
        if (pruned > 0) {
            console.log(`[WSService] Stale reaper removed ${pruned} dead socket(s).`);
        }
    }

    async _joinUserChatRooms(userId, socket) {
        if (!userId || !socket || typeof socket.join !== 'function') return;

        // ── CRITICAL: Join personal user rooms FIRST (sync, no DB needed) ────
        // sendToUser() emits to user:ID and user_ID rooms.
        // Without joining these rooms, the receiver NEVER gets messages or calls.
        const uid    = parseInt(userId, 10);
        const strUid = String(uid);
        socket.join(`user:${uid}`);
        socket.join(`user_${uid}`);
        socket.join(`user:${strUid}`);
        socket.join(`user_${strUid}`);
        console.log(`[WSService] uid=${userId} joined personal user rooms: user:${uid}, user_${uid}`);

        try {
            const db = require('../models');
            const sequelize = db.sequelize || db;
            if (!sequelize || typeof sequelize.query !== 'function') return;

            // Join all private chat rooms
            const chatRows = await sequelize.query(
                'SELECT "chatId" FROM chat_participants WHERE "userId" = :userId',
                { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
            );
            for (const { chatId } of (chatRows || [])) {
                if (chatId) {
                    socket.join(`chat:${chatId}`);
                    socket.join(`chat_${chatId}`);
                }
            }

            // CRITICAL FIX: Also join group rooms from GroupMembers table
            // Groups use a separate table — without this, group messages never reach members
            let groupRows = [];
            try {
                groupRows = await sequelize.query(
                    'SELECT "groupId" FROM "GroupMembers" WHERE "userId" = :userId AND status != \'left\' AND status != \'banned\'',
                    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
                );
            } catch (gErr) {
                // Try without status filter if column doesn't exist
                try {
                    groupRows = await sequelize.query(
                        'SELECT "groupId" FROM "GroupMembers" WHERE "userId" = :userId',
                        { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
                    );
                } catch (_) {}
            }
            for (const { groupId } of (groupRows || [])) {
                if (groupId) {
                    socket.join(`group:${groupId}`);
                    socket.join(`group_${groupId}`);
                }
            }

            const totalRooms = (chatRows || []).length + (groupRows || []).length;
            if (totalRooms > 0) {
                console.log(`[WSService] uid=${userId} auto-joined ${(chatRows||[]).length} chat room(s) + ${(groupRows||[]).length} group room(s)`);
            }
        } catch (err) {
            console.warn(`[WSService] _joinUserChatRooms failed for uid=${userId}:`, err.message);
        }
    }

    // Allow external code to re-join rooms (called after group join/create)
    async rejoinGroupRoom(userId, groupId) {
        const io = this.getIO();
        if (!io || !userId || !groupId) return;
        const sids = this.onlineUsers.get(Number(userId)) || this.onlineUsers.get(String(userId));
        if (!sids) return;
        for (const sid of sids) {
            try {
                const socket = io.sockets.sockets.get(sid);
                if (socket) {
                    socket.join(`group:${groupId}`);
                    socket.join(`group_${groupId}`);
                }
            } catch (_) {}
        }
        console.log(`[WSService] uid=${userId} rejoined group:${groupId}`);
    }
}

module.exports = new WebSocketService();
// ── PHASE14 FIX: sync:missed_messages and sync:missed_events handlers ─────────
// These were completely missing — clients reconnecting after a disconnect
// had no way to fetch messages they missed while offline.
// Added to setupConnectionHandler() via monkey-patch to avoid restructuring.

const _originalSetupConnectionHandler = WebSocketService.prototype.setupConnectionHandler;
WebSocketService.prototype.setupConnectionHandler = function() {
    // Run original first
    _originalSetupConnectionHandler.call(this);

    const io = this.getIO();
    if (!io) return this;

    // Patch: add missed-sync handlers to every new connection
    io.on('connection', (socket) => {
        const userId = socket._authenticatedUserId;
        if (!userId) return;

        // sync:missed_messages — client requests messages it missed since lastSyncAt
        socket.off('sync:missed_messages').on('sync:missed_messages', async ({ chatIds, since } = {}) => {
            try {
                const sequelize = require('../models').sequelize;
                if (!sequelize || !since) return;

                const sinceDate = new Date(since);
                if (isNaN(sinceDate.getTime())) return;

                // For each chatId the client knows about, get messages since `since`
                const chatList = Array.isArray(chatIds) ? chatIds.slice(0, 20) : [];

                if (chatList.length === 0) {
                    // Get all chats the user participates in
                    const [chats] = await sequelize.query(
                        `SELECT DISTINCT "chatId" FROM chat_participants WHERE "userId" = :userId LIMIT 20`,
                        { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
                    ).catch(() => [[]]);
                    chatList.push(...(chats || []).map(c => c.chatId));
                }

                for (const chatId of chatList) {
                    try {
                        const messages = await sequelize.query(
                            `SELECT m.*, u.username AS "senderUsername", u.avatar AS "senderAvatar"
                             FROM "Messages" m
                             LEFT JOIN "Users" u ON u.id = m."senderId"
                             WHERE m."chatId" = :chatId
                               AND m."createdAt" > :since
                               AND m."isDeleted" = false
                             ORDER BY m."createdAt" ASC
                             LIMIT 50`,
                            { replacements: { chatId, since: sinceDate }, type: sequelize.QueryTypes.SELECT }
                        ).catch(() => []);

                        if (messages && messages.length > 0) {
                            socket.emit('sync:missed_messages_result', { chatId, messages, since });
                        }
                    } catch (_) {}
                }

                socket.emit('sync:missed_messages_done', { chatIds: chatList, since });
            } catch (err) {
                console.warn('[WSService] sync:missed_messages error:', err.message);
            }
        });

        // sync:missed_events — client requests friend/group/status events since lastSyncAt
        socket.off('sync:missed_events').on('sync:missed_events', async ({ since, types } = {}) => {
            try {
                const sinceDate = new Date(since);
                if (isNaN(sinceDate.getTime())) return;

                const payload = { since, events: [] };

                // Emit pending friend requests
                try {
                    const sequelize = require('../models').sequelize;
                    const friends = await sequelize.query(
                        `SELECT f.id, f."requesterId", f."recipientId", f.status, f."createdAt",
                                u.username AS "requesterUsername", u.avatar AS "requesterAvatar"
                         FROM "Friends" f
                         LEFT JOIN "Users" u ON u.id = f."requesterId"
                         WHERE f."recipientId" = :userId
                           AND f.status = 'pending'
                           AND f."createdAt" > :since
                         LIMIT 20`,
                        { replacements: { userId, since: sinceDate }, type: sequelize.QueryTypes.SELECT }
                    ).catch(() => []);

                    if (friends && friends.length > 0) {
                        friends.forEach(f => {
                            socket.emit('friend:request', {
                                requestId: f.id,
                                senderId: f.requesterId,
                                senderUsername: f.requesterUsername,
                                senderAvatar: f.requesterAvatar,
                                createdAt: f.createdAt
                            });
                        });
                        payload.events.push({ type: 'friend_requests', count: friends.length });
                    }
                } catch (_) {}

                socket.emit('sync:missed_events_done', payload);
            } catch (err) {
                console.warn('[WSService] sync:missed_events error:', err.message);
            }
        });

        // online:check — client asks if specific users are online
        socket.off('online:check').on('online:check', ({ userIds } = {}) => {
            try {
                if (!Array.isArray(userIds)) return;
                const result = {};
                userIds.slice(0, 50).forEach(uid => {
                    const intUid = parseInt(uid, 10);
                    result[uid] = this.isUserOnline ? this.isUserOnline(intUid) :
                        (this.onlineUsers && this.onlineUsers.has(intUid));
                });
                socket.emit('online:status', result);
            } catch (_) {}
        });
    });

    return this;
};

// ── PHASE14 FIX: mark_as_read + group:join socket handlers ───────────────────

const _originalSetupConnectionHandler2 = WebSocketService.prototype.setupConnectionHandler;
WebSocketService.prototype.setupConnectionHandler = function() {
    _originalSetupConnectionHandler2.call(this);
    const io = this.getIO();
    if (!io) return this;

    io.on('connection', (socket) => {
        const userId = socket._authenticatedUserId;
        if (!userId) return;

        // mark_as_read — real-time read receipt broadcast
        socket.off('mark_as_read').on('mark_as_read', async ({ chatId, messageIds } = {}) => {
            try {
                if (!chatId) return;
                const sequelize = require('../models').sequelize;

                // Persist read receipts
                if (Array.isArray(messageIds) && messageIds.length > 0) {
                    await sequelize.query(
                        `INSERT INTO "ReadReceipts" ("messageId","userId","readAt","createdAt","updatedAt")
                         SELECT unnest(ARRAY[:messageIds]::int[]), :userId, NOW(), NOW(), NOW()
                         ON CONFLICT ("messageId","userId") DO NOTHING`,
                        { replacements: { messageIds: messageIds.map(Number), userId }, type: sequelize.QueryTypes.INSERT }
                    ).catch(() => {});
                }

                // Broadcast to chat room so sender sees read tick
                socket.to(`chat:${chatId}`).emit('message:read', {
                    chatId,
                    readerId: userId,
                    messageIds: messageIds || [],
                    readAt: new Date().toISOString()
                });
            } catch (err) {
                console.warn('[WSService] mark_as_read error:', err.message);
            }
        });

        // group:join — client requests to join a group's socket room after creation
        socket.off('group:join').on('group:join', async ({ groupId } = {}) => {
            try {
                if (!groupId) return;
                // Verify membership before joining room
                const sequelize = require('../models').sequelize;
                const [member] = await sequelize.query(
                    `SELECT 1 FROM "GroupMembers" WHERE "groupId"=:groupId AND "userId"=:userId AND "leftAt" IS NULL LIMIT 1`,
                    { replacements: { groupId, userId }, type: sequelize.QueryTypes.SELECT }
                ).catch(() => [null]);

                if (member) {
                    socket.join(`group:${groupId}`);
                    socket.join(`group_${groupId}`);
                    socket.emit('group:joined', { groupId, success: true });
                    console.log(`[WSService] uid=${userId} joined group:${groupId}`);
                }
            } catch (err) {
                console.warn('[WSService] group:join error:', err.message);
            }
        });

        // message:delivered — client acknowledges delivery
        socket.off('message:delivered').on('message:delivered', ({ chatId, messageId } = {}) => {
            if (!chatId || !messageId) return;
            socket.to(`chat:${chatId}`).emit('message:delivered', {
                chatId, messageId,
                deliveredTo: userId,
                deliveredAt: new Date().toISOString()
            });
        });
    });

    return this;
};
// ── PHASE14 FIX P0: WebRTC socket-level signaling relay ───────────────────────
// ROOT CAUSE: All WebRTC signals (offer, answer, ICE) were relayed via HTTP POST
// /:callId/signal. This adds 200-800ms per ICE candidate — enough to fail
// connection establishment behind symmetric NAT (Render/cloud environments).
// FIX: Add direct socket handlers so ICE candidates travel via WebSocket (~20ms).
// Backend simply relays to the target user's socket room — no DB write needed.

const _originalSetupConnectionHandlerWRTC = WebSocketService.prototype.setupConnectionHandler;
WebSocketService.prototype.setupConnectionHandler = function() {
    _originalSetupConnectionHandlerWRTC.call(this);
    const io = this.getIO();
    if (!io) return this;

    io.on('connection', (socket) => {
        const userId = socket._authenticatedUserId;
        if (!userId) return;

        // webrtc:signal — relay offer/answer/ICE directly via socket (low latency)
        socket.off('webrtc:signal').on('webrtc:signal', (payload = {}) => {
            try {
                const { targetUserId, callId, type, sdp, candidate } = payload;
                if (!targetUserId) return;
                const relayPayload = {
                    callId,
                    fromUserId: userId,
                    type,
                    sdp:       sdp       || undefined,
                    candidate: candidate || undefined,
                    timestamp: Date.now()
                };
                const targets = [
                    `user:${targetUserId}`,
                    `user_${targetUserId}`,
                    `user:${String(targetUserId)}`,
                    `user_${String(targetUserId)}`
                ];
                targets.forEach(room => {
                    try { io.to(room).emit('webrtc:signal', relayPayload); } catch (_) {}
                });
            } catch (err) {
                console.warn('[WSService] webrtc:signal relay error:', err.message);
            }
        });

        // webrtc_signal — underscore alias (calls-core.js also emits this form)
        socket.off('webrtc_signal').on('webrtc_signal', (payload = {}) => {
            try {
                const { targetUserId, callId, type, sdp, candidate } = payload;
                if (!targetUserId) return;
                const relayPayload = {
                    callId,
                    fromUserId: userId,
                    type,
                    sdp:       sdp       || undefined,
                    candidate: candidate || undefined,
                    timestamp: Date.now()
                };
                const targets = [
                    `user:${targetUserId}`,
                    `user_${targetUserId}`,
                    `user:${String(targetUserId)}`,
                    `user_${String(targetUserId)}`
                ];
                targets.forEach(room => {
                    try { io.to(room).emit('webrtc:signal', relayPayload);
                          io.to(room).emit('webrtc_signal', relayPayload); } catch (_) {}
                });
            } catch (err) {
                console.warn('[WSService] webrtc_signal relay error:', err.message);
            }
        });

        // call:heartbeat — keep call alive signal, relay to other participant
        socket.off('call:heartbeat').on('call:heartbeat', ({ callId, targetUserId } = {}) => {
            if (!callId || !targetUserId) return;
            try {
                io.to(`user:${targetUserId}`).emit('call:heartbeat', { callId, fromUserId: userId, ts: Date.now() });
                io.to(`user_${targetUserId}`).emit('call:heartbeat', { callId, fromUserId: userId, ts: Date.now() });
            } catch (_) {}
        });
    });

    return this;
};

// ── PHASE14 FIX P0: socket message:send handler ───────────────────────────────
// ROOT CAUSE: Frontend HybridTransportRuntime can emit 'message:send' via socket
// in LAN/degraded-internet mode. Backend had no handler — messages silently dropped.
// FIX: Add socket handler that persists via messageService and broadcasts to chat.

const _originalSetupCH_MsgSend = WebSocketService.prototype.setupConnectionHandler;
WebSocketService.prototype.setupConnectionHandler = function() {
    _originalSetupCH_MsgSend.call(this);
    const io = this.getIO();
    if (!io) return this;

    io.on('connection', (socket) => {
        const userId = socket._authenticatedUserId;
        if (!userId) return;

        socket.off('message:send').on('message:send', async (payload = {}) => {
            try {
                const { chatId, content, type = 'text', replyToId, localId } = payload;
                if (!chatId || !content) {
                    socket.emit('message:send:error', { localId, error: 'chatId and content are required' });
                    return;
                }
                const messageService = require('./messageService');
                const msg = await messageService.createMessage({
                    chatId: parseInt(chatId, 10),
                    senderId: userId,
                    content: String(content).trim().substring(0, 5000),
                    type,
                    replyToId: replyToId ? parseInt(replyToId, 10) : null
                });
                // Ack to sender with server-assigned ID
                socket.emit('message:send:ack', {
                    localId,
                    messageId: msg.id,
                    chatId,
                    sentAt: msg.sentAt || msg.createdAt
                });
            } catch (err) {
                const { localId } = payload || {};
                console.warn('[WSService] message:send socket error:', err.message);
                socket.emit('message:send:error', { localId, error: err.message });
            }
        });
    });

    return this;
};