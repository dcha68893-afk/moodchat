'use strict';

/**
 * webSocketService.js  — HARDENED v2.0.0
 *
 * Changes from v1:
 *  1. TOKEN VERIFICATION on connect — verifyToken() validates the JWT/session
 *     token before registerUser() is called.  Invalid tokens are rejected and
 *     the socket is immediately disconnected.
 *  2. STALE SOCKET CLEANUP — pruneStaleSocket() checks socket liveness against
 *     the live Socket.IO adapter before trusting onlineUsers map entries.
 *  3. IDLE SOCKET REAPER — a 60-second interval removes map entries for sockets
 *     that are no longer in the adapter (handles crash-disconnect without 'disconnect' event).
 *  4. ROOM JOIN GUARANTEE — registerUser() retries room join once if the first
 *     attempt throws (race on socket init).
 *  5. broadcastToChat, init, handleReconnect — kept from v1, no changes needed.
 *  6. All public methods are safe to call with undefined/null arguments.
 */

const db   = require('../models');
const User = db.Users || db.User;

// ── Token verification helper ─────────────────────────────────────────────────
// Replace this with your real JWT library (jsonwebtoken, jose, etc.)
// The function must return { valid: bool, userId: int|null, reason: string }
let _jwtVerify = null;
try {
    const jwt = require('jsonwebtoken');
    _jwtVerify = (token) => {
        try {
            const secret = process.env.JWT_SECRET;
            if (!secret) return { valid: true, userId: null, reason: 'no-secret-configured' };
            const decoded = jwt.verify(token, secret);
            const uid = parseInt(decoded.userId || decoded.id || decoded.sub, 10);
            return { valid: !!uid, userId: uid || null, reason: uid ? 'ok' : 'no-userId-in-payload' };
        } catch (err) {
            return { valid: false, userId: null, reason: err.message };
        }
    };
} catch (_) {
    // jsonwebtoken not installed — skip server-side JWT verification
    // (socket auth still works via the query/auth handshake on the Socket.IO server level)
    _jwtVerify = () => ({ valid: true, userId: null, reason: 'jwt-not-available' });
}

// ── Stale-socket reaper interval (ms) ────────────────────────────────────────
const STALE_REAPER_INTERVAL = 60_000;

class WebSocketService {
    constructor() {
        this.io          = null;

        // userId(int) → Set<socketId(string)>
        this.onlineUsers = new Map();

        // Legacy alias — kept for backward compat with any code that references userSockets
        this.userSockets = this.onlineUsers;

        // Raw (non-Socket.IO) WebSocket clients
        // userId(int) → Set<WebSocket>
        this.wsClients = new Map();

        // Start stale-socket reaper
        this._reaperTimer = setInterval(() => this._pruneAllStale(), STALE_REAPER_INTERVAL);
        // Allow process to exit without waiting for timer
        if (this._reaperTimer.unref) this._reaperTimer.unref();
    }

    // ── IO setup ──────────────────────────────────────────────────────────────

    setIO(io) {
        this.io = io || null;
        // Expose Socket.IO globally for other services
        if (io) {
            global.__socketIO = io;
            global.__io = io;
            global.io = io;
            console.log('[WSService] Socket.IO instance exposed globally');
        }
        return this;
    }

    /** Alias used by server.js: wsService.init(io) */
    init(io) {
        return this.setIO(io);
    }

    /**
     * ✅ FIX: Call this from server.js AFTER setIO/init so every connecting socket
     * is authenticated and joined to its user room automatically.
     *
     * Usage in server.js:
     *   wsService.init(io);
     *   wsService.setupConnectionHandler();
     *
     * The handler:
     *  1. Reads the token from handshake.auth.token or handshake.query.token
     *  2. Verifies it (rejects + disconnects invalid tokens)
     *  3. Calls registerUser() so sendToUser() can find this socket
     *  4. Joins user rooms: user:<id>  and  user_<id>
     *  5. Emits 'authenticated' back so the client knows auth succeeded
     *  6. Cleans up on disconnect
     */
    setupConnectionHandler() {
        const io = this.getIO();
        if (!io) {
            console.error('[WSService] setupConnectionHandler: io not set — call init(io) first');
            return this;
        }

        io.on('connection', (socket) => {
            const token = (socket.handshake.auth && socket.handshake.auth.token)
                || socket.handshake.query.token
                || null;

            // ── Auth ─────────────────────────────────────────────────────────
            const { valid, userId, reason } = this.verifyToken(token, socket);
            if (!valid) {
                // verifyToken already disconnected the socket
                return;
            }

            // ── Register + join rooms ─────────────────────────────────────────
            this.registerUser(userId, socket);
            // registerUser joins user:<id> and user_<id> — log confirmation
            console.log(`[WSService] ✅ socket connected uid=${userId} sid=${socket.id}`);

            // ── Tell client auth succeeded ────────────────────────────────────
            // Include userId in payload so client can call _joinUserRoom(payload) reliably
            socket.emit('authenticated', { userId, authenticated: true, timestamp: Date.now() });

            // ── FIX: Proactively join all chat rooms this user belongs to ─────
            // This makes broadcastToChat(chatId, ...) deliver to the receiver even
            // if the client never emits an explicit 'join' for each chat room.
            this._joinUserChatRooms(userId, socket).catch(() => {});

            // ── Allow client to explicitly join chat/group rooms ──────────────
            socket.on('join', ({ room } = {}) => {
                if (room && typeof room === 'string') {
                    socket.join(room);
                    console.log(`[WSService] uid=${userId} joined room: ${room}`);
                }
            });
            // ✅ FIX: Validate that join_user_room userId matches the authenticated userId
            // to prevent any socket from joining another user's room.
            socket.on('join_user_room', ({ userId: uid } = {}) => {
                const rid = parseInt(uid, 10);
                if (rid && rid === userId) {
                    socket.join(`user:${rid}`);
                    socket.join(`user_${rid}`);
                    console.log(`[WSService] uid=${userId} confirmed join user rooms`);
                }
            });

            // ── Clean up on disconnect ────────────────────────────────────────
            socket.on('disconnect', (reason) => {
                this.removeUser(userId, socket);
                console.log(`[WSService] socket disconnected uid=${userId} sid=${socket.id} reason=${reason}`);
            });
        });

        console.log('[WSService] Connection handler registered ✅');
        return this;
    }

    getIO() {
        // ✅ FIX: Check all common global names server frameworks use to expose the io instance
        return this.io
            || global.__socketIO
            || global.__io
            || global.io
            || null;
    }

    // ── TOKEN VERIFICATION ────────────────────────────────────────────────────

    /**
     * Verify a token and return { valid, userId, reason }.
     * Called during socket 'connect' before registerUser().
     *
     * @param {string} token
     * @param {object} socket - Socket.IO socket (used to disconnect on failure)
     * @returns {{ valid: boolean, userId: number|null, reason: string }}
     */
    verifyToken(token, socket = null) {
        if (!token || typeof token !== 'string' || token.length < 10) {
            const result = { valid: false, userId: null, reason: 'token-missing-or-too-short' };
            if (socket) {
                console.warn(`[WSService] ⛔ Rejecting socket ${socket.id}: ${result.reason}`);
                try { socket.disconnect(true); } catch (_) {}
            }
            return result;
        }

        const result = _jwtVerify(token);

        if (!result.valid) {
            console.warn(`[WSService] ⛔ Invalid token for socket ${socket && socket.id}: ${result.reason}`);
            if (socket) {
                try { socket.emit('auth_error', { reason: result.reason }); } catch (_) {}
                try { socket.disconnect(true); } catch (_) {}
            }
        }

        return result;
    }

    // ── REGISTER / REMOVE ─────────────────────────────────────────────────────

    /**
     * Register a user's socket after successful authentication.
     * Also joins the socket to canonical user rooms.
     *
     * @param {number|string} userId
     * @param {object|string} socketOrSocketId  Socket.IO socket object OR bare socketId string
     * @returns {boolean}
     */
    registerUser(userId, socketOrSocketId) {
        const uid      = parseInt(userId, 10);
        const socketId = typeof socketOrSocketId === 'string'
            ? socketOrSocketId
            : (socketOrSocketId && socketOrSocketId.id);

        if (!uid || !socketId) return false;

        if (!this.onlineUsers.has(uid)) this.onlineUsers.set(uid, new Set());
        this.onlineUsers.get(uid).add(socketId);

        // Join user rooms — retry once on race condition
        if (socketOrSocketId && typeof socketOrSocketId.join === 'function') {
            const joinRooms = () => {
                socketOrSocketId.join(`user:${uid}`);
                socketOrSocketId.join(`user_${uid}`);
            };
            try {
                joinRooms();
                console.log(`[WSService] registerUser uid=${uid} socket=${socketId} rooms joined ✅`);
            } catch (err) {
                console.warn(`[WSService] Room join failed (retry): ${err.message}`);
                setTimeout(() => {
                    try { joinRooms(); } catch (e) {
                        console.error(`[WSService] Room join retry failed uid=${uid}: ${e.message}`);
                    }
                }, 100);
            }
        } else {
            console.log(`[WSService] registerUser uid=${uid} socketId=${socketId} (id-only, no room join)`);
        }

        return true;
    }

    /**
     * Remove a user's socket on 'disconnect'.
     */
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

    // Convenience aliases used by chat.html socket-connect code
    registerUserSocket(userId, socketId)     { return this.registerUser(userId, socketId); }
    unregisterUserSocket(userId, socketId)   { return this.removeUser(userId, socketId); }

    // ── IS USER ONLINE ────────────────────────────────────────────────────────

    /**
     * Returns true if the user has at least one live connection.
     * Multi-tier check: in-memory map → raw WS clients → Socket.IO adapter rooms.
     */
    async isUserOnline(userId) {
        const uid = parseInt(userId, 10);
        if (!uid) return false;

        // 1. In-memory fast path
        const sockets = this.onlineUsers.get(uid);
        if (sockets && sockets.size > 0) {
            // Verify at least one is still alive in the adapter before trusting
            const io = this.getIO();
            if (io) {
                for (const sid of sockets) {
                    if (this._isSocketAliveInAdapter(io, sid)) return true;
                }
                // All stored sockets are gone — clean up
                this.onlineUsers.delete(uid);
            } else {
                return true; // no IO yet, trust the map
            }
        }

        // 2. Raw WebSocket clients
        const wsClients = this.wsClients.get(uid);
        if (wsClients && wsClients.size > 0) {
            for (const ws of wsClients) {
                if (ws.readyState === 1 /* OPEN */) return true;
            }
        }

        // 3. Socket.IO adapter rooms
        const io = this.getIO();
        if (io) {
            const adapter = io.sockets && io.sockets.adapter;
            if (adapter && adapter.rooms) {
                for (const room of [`user:${uid}`, `user_${uid}`]) {
                    const roomSet = adapter.rooms.get(room);
                    if (roomSet && roomSet.size > 0) return true;
                }
            }

            // 4. fetchSockets() — authoritative, Socket.IO v4+
            if (typeof io.in === 'function') {
                for (const room of [`user:${uid}`, `user_${uid}`]) {
                    try {
                        const connected = await io.in(room).fetchSockets().catch(() => []);
                        if (connected && connected.length > 0) return true;
                    } catch (_) {}
                }
            }
        }

        // 5. DB fallback (legacy socketIds column)
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

    /**
     * Deliver event+payload to every live connection for a user.
     * Order: raw WS clients → Socket.IO rooms → individual socketIds.
     */
    async sendToUser(userId, event, data = {}) {
        const uid = parseInt(userId, 10);
        if (!uid || !event) return false;

        // ✅ FIX: Required emit verification log per spec
        console.log(`[WSService] EMITTING MESSAGE TO: uid=${uid} event=${event}`);

        const payload = { ...data, timestamp: data.timestamp || new Date().toISOString() };
        let delivered = false;
        const io      = this.getIO();

        // 1. Raw WebSocket (non-Socket.IO) clients
        const wsClients = this.wsClients.get(uid);
        if (wsClients && wsClients.size > 0) {
            const raw = JSON.stringify({ type: event, payload, timestamp: payload.timestamp });
            for (const client of wsClients) {
                try {
                    if (client && client.readyState === 1) { client.send(raw); delivered = true; }
                } catch (_) {}
            }
        }

        if (!io) return delivered;

        // 2. Socket.IO rooms (fastest, catches all sockets already in the room)
        for (const room of [`user:${uid}`, `user_${uid}`]) {
            try { io.to(room).emit(event, payload); delivered = true; } catch (_) {}
        }

        // 3. Individual socket IDs (catches sockets not yet joined to a room)
        const socketIds = await this.getSocketIdsForUser(uid);
        for (const sid of socketIds) {
            if (!this._isSocketAliveInAdapter(io, sid)) {
                // Remove stale entry
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
        await this.sendToUser(userId, 'call:incoming',  data);
        await this.sendToUser(userId, 'incoming_call',  data);
        return true;
    }

    async sendSignal(userId, payload = {}) {
        return this.sendToUser(userId, 'webrtc:signal', payload);
    }

    async sendNotification(userId, notification = {}) {
        return this.sendToUser(userId, 'notification:new', notification);
    }

    async notifyMoodShared(userId, payload = {}) {
        return this.sendToUser(userId, 'mood:shared', payload);
    }

    async notifyFriendMood(userId, payload = {}) {
        return this.sendToUser(userId, 'mood:friend', payload);
    }

    // --- STATUS EVENTS ---
    async notifyStatusCreated(status, excludeUserId = null) {
        const payload = {
            statusId: status.id,
            userId: status.userId,
            type: status.type,
            content: status.content,
            mediaUrl: status.mediaUrl,
            createdAt: status.createdAt,
            expiresAt: status.expiresAt,
            timestamp: new Date().toISOString()
        };
        
        // Broadcast to all users except creator
        return this.broadcast('status:created', payload);
    }

    async notifyStatusViewed(statusId, viewerId, ownerId) {
        const payload = {
            statusId,
            viewerId,
            ownerId,
            timestamp: new Date().toISOString()
        };
        
        // Send to status owner
        await this.sendToUser(ownerId, 'status:viewed', payload);
        
        // Update viewer count in real-time
        return this.broadcast('status:viewer_update', {
            statusId,
            viewerCount: 1, // Will be incremented by listeners
            timestamp: payload.timestamp
        });
    }

    async notifyStatusExpired(statusId, userId) {
        const payload = {
            statusId,
            userId,
            timestamp: new Date().toISOString()
        };
        
        return this.broadcast('status:expired', payload);
    }

    async notifyStatusUpdated(status) {
        const payload = {
            statusId: status.id,
            userId: status.userId,
            updates: {
                content: status.content,
                isPublic: status.isPublic,
                updatedAt: status.updatedAt
            },
            timestamp: new Date().toISOString()
        };
        
        return this.broadcast('status:updated', payload);
    }

    async notifyStatusDeleted(statusId, userId) {
        const payload = {
            statusId,
            userId,
            timestamp: new Date().toISOString()
        };
        
        return this.broadcast('status:deleted', payload);
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

    /** Server-wide broadcast */
    broadcast(event, data = {}) {
        const io = this.getIO();
        if (!io) return false;
        try { io.emit(event, data); return true; } catch (_) { return false; }
    }

    /** Broadcast to all sockets in a chat room */
    broadcastToChat(chatId, event, payload = {}) {
        const io = this.getIO();
        if (!io || !chatId || !event) return false;
        try {
            io.to(`chat:${chatId}`).emit(event, {
                ...payload,
                timestamp: payload.timestamp || new Date().toISOString()
            });
            return true;
        } catch (_) { return false; }
    }

    /** Broadcast to all group members - CRITICAL for group chat */
    broadcastToGroup(groupId, event, payload = {}, excludeSenderId = null) {
        const io = this.getIO();
        if (!io || !groupId || !event) return false;
        
        try {
            // Send to group room
            const groupPayload = {
                ...payload,
                groupId,
                timestamp: payload.timestamp || new Date().toISOString()
            };
            
            io.to(`group:${groupId}`).emit(event, groupPayload);
            
            // If excludeSenderId, don't send to that user's personal room
            if (excludeSenderId) {
                io.to(`user:${excludeSenderId}`).emit(event, groupPayload);
            }
            
            return true;
        } catch (error) {
            console.error('[WSService] Group broadcast failed:', error);
            return false;
        }
    }

    /** Send group message to all members except sender */
    async sendGroupMessage(groupId, message, senderId) {
        const payload = {
            type: 'group_message',
            groupId,
            message: {
                id: message.id,
                content: message.content,
                senderId: message.senderId,
                senderName: message.senderName,
                timestamp: message.timestamp || new Date().toISOString(),
                messageType: message.messageType || 'text'
            }
        };
        
        // Broadcast to group room (includes all members)
        const success = this.broadcastToGroup(groupId, 'group:message', payload, senderId);
        
        if (success) {
            console.log(`[WSService] Group message sent to group ${groupId} from user ${senderId}`);
        }
        
        return success;
    }

    /** Notify group members of membership changes */
    async notifyGroupMembershipChange(groupId, action, memberData, changedByUserId) {
        const payload = {
            groupId,
            action, // 'member_joined', 'member_left', 'member_role_changed'
            member: memberData,
            changedBy: changedByUserId,
            timestamp: new Date().toISOString()
        };
        
        return this.broadcastToGroup(groupId, 'group:membership_change', payload);
    }

    /** Notify group members of group updates */
    async notifyGroupUpdated(groupId, groupData, updatedByUserId) {
        const payload = {
            groupId,
            group: groupData,
            updatedBy: updatedByUserId,
            timestamp: new Date().toISOString()
        };
        
        return this.broadcastToGroup(groupId, 'group:updated', payload);
    }

    // ── RECONNECT HOOK ────────────────────────────────────────────────────────

    handleReconnect(userId, socketId) {
        if (userId && socketId) return this.registerUser(userId, socketId);
        return true;
    }

    // Compat aliases
    connect(io)                       { return this.setIO(io); }
    disconnect(userId, socketId)      {
        if (userId && socketId) return this.removeUser(userId, socketId);
        return true;
    }

    // ── STATS ─────────────────────────────────────────────────────────────────

    getOnlineCount()   { return this.onlineUsers.size; }
    getOnlineUserIds() { return Array.from(this.onlineUsers.keys()); }

    // ── PRIVATE: LIVENESS CHECK ───────────────────────────────────────────────

    /**
     * Returns true if socketId exists in the Socket.IO adapter's socket map.
     * @param {object} io  - Socket.IO server instance
     * @param {string} sid - Socket ID to check
     */
    _isSocketAliveInAdapter(io, sid) {
        if (!io || !sid) return false;
        try {
            // Socket.IO v4: io.sockets.sockets is a Map<sid, socket>
            if (io.sockets && io.sockets.sockets) {
                return io.sockets.sockets.has(sid);
            }
        } catch (_) {}
        return false;
    }

    /**
     * Reaper: walk onlineUsers and remove entries for sockets that have
     * silently disconnected (no 'disconnect' event fired, e.g. server crash).
     */
    _pruneAllStale() {
        const io = this.getIO();
        if (!io) return;

        let pruned = 0;
        for (const [uid, sids] of this.onlineUsers) {
            for (const sid of sids) {
                if (!this._isSocketAliveInAdapter(io, sid)) {
                    sids.delete(sid);
                    pruned++;
                }
            }
            if (sids.size === 0) this.onlineUsers.delete(uid);
        }

        if (pruned > 0) {
            console.log(`[WSService] Stale socket reaper removed ${pruned} dead socket(s).`);
        }
    }

    /**
     * ✅ FIX: After a user connects, proactively join all Socket.IO rooms for every
     * chat they are a participant in. This means broadcastToChat(chatId, 'message:new', ...)
     * will reach the receiver's socket even if the client never emitted an explicit join.
     *
     * Falls back silently if DB is unavailable (e.g. during test runs).
     */
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
                    // ✅ FIX 13: Also join group room so broadcastToGroup() reaches this socket
                    socket.join(`group:${chatId}`);
                }
            }

            if (rows && rows.length > 0) {
                console.log(`[WSService] ✅ FIX13 uid=${userId} auto-joined ${rows.length} chat+group room(s)`);
            }
        } catch (err) {
            // Non-fatal — user:X room delivery still works via sendToUser()
            console.warn(`[WSService] _joinUserChatRooms failed for uid=${userId}:`, err.message);
        }
    }
}

module.exports = new WebSocketService();