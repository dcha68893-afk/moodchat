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

        // ── STEP 1: Auth middleware runs BEFORE connection ────────────────────
        // Rejecting here (next(error)) causes Socket.IO to emit 'connect_error'
        // on the client, NOT "io server disconnect".
        io.use((socket, next) => {
            const token = (socket.handshake.auth && socket.handshake.auth.token)
                || socket.handshake.query.token
                || null;

            const { valid, userId, reason } = this.verifyTokenOnly(token);

            if (!valid) {
                console.warn(`[WSService] ⛔ Auth rejected socket ${socket.id}: ${reason}`);
                // FIX: return next(error) — NOT socket.disconnect()
                return next(new Error(`Authentication failed: ${reason}`));
            }

            // Attach to socket for use in connection handler
            socket._authenticatedUserId = userId;
            next();
        });

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
            if (!socketId || set.size === 0) this.onlineUsers.delete(uid);
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
        return this.broadcast('status:deleted', { statusId, userId, timestamp: new Date().toISOString() });
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

    broadcastToChat(chatId, event, payload = {}) {
        const io = this.getIO();
        if (!io || !chatId || !event) return false;
        try {
            io.to(`chat:${chatId}`).emit(event, {
                ...payload, timestamp: payload.timestamp || new Date().toISOString()
            });
            return true;
        } catch (_) { return false; }
    }

    broadcastToGroup(groupId, event, payload = {}, excludeSenderId = null) {
        const io = this.getIO();
        if (!io || !groupId || !event) return false;
        try {
            const groupPayload = { ...payload, groupId, timestamp: payload.timestamp || new Date().toISOString() };
            io.to(`group:${groupId}`).emit(event, groupPayload);
            if (excludeSenderId) {
                io.to(`user:${excludeSenderId}`).emit(event, groupPayload);
            }
            return true;
        } catch (error) {
            console.error('[WSService] Group broadcast failed:', error);
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
        try {
            const db = require('../models');
            const sequelize = db.sequelize || db;
            if (!sequelize || typeof sequelize.query !== 'function') return;

            const rows = await sequelize.query(
                'SELECT "chatId" FROM chat_participants WHERE "userId" = :userId',
                { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
            );

            for (const { chatId } of (rows || [])) {
                if (chatId) {
                    socket.join(`chat:${chatId}`);
                    socket.join(`group:${chatId}`);
                }
            }

            if (rows && rows.length > 0) {
                console.log(`[WSService] uid=${userId} auto-joined ${rows.length} chat+group room(s)`);
            }
        } catch (err) {
            console.warn(`[WSService] _joinUserChatRooms failed for uid=${userId}:`, err.message);
        }
    }
}

module.exports = new WebSocketService();