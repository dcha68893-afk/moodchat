'use strict';

// ── FIX: MaxListenersExceededWarning — raise cap before any listeners attach ──
const EventEmitter = require('events');
EventEmitter.defaultMaxListeners = 20;

// Sequelize Op for call status queries
const { Op: WsOp } = require('sequelize');

/**
 * webSocketService.js — FIXED v3.3.0 (call-ack, delivery-ack, offline-queue)
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

// FIX-AUDIT: Gated verbose logger for high-frequency forensic tracing, mirroring
// the same pattern used in routes/messages.js. Defaults OFF in production.
const _DEBUG_MESSAGES = process.env.DEBUG_MESSAGES === '1' || process.env.DEBUG_MESSAGES === 'true';
const _flog = (...args) => { if (_DEBUG_MESSAGES) console.log(...args); };

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
    _flog('[WSService] Token verification delegated to tokenService ✅');
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
        // FIX-NETWORK-BLIP: userId(int) → Timeout, pending stale-call cleanup
        // scheduled from a disconnect, cancelled if the user reconnects in time.
        this._pendingCallCleanupTimers = new Map();
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
            _flog('[WSService] Socket.IO instance exposed globally');
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
                 _flog(`[WSService] ✅ socket connected uid=${userId} sid=${socket.id}`);

            // Tell client auth succeeded
            socket.emit('authenticated', { userId, authenticated: true, timestamp: Date.now() });

            // FIX-QUEUE-FLUSH-ORDER: this MUST run before the HTR offline-queue flush
            // below. _joinUserChatRooms() joins `user:${uid}`/`user_${uid}` synchronously
            // (see the top of that method) before it does anything async — but it was
            // previously called AFTER htr.flushOfflineQueue(), which delivers via
            // _sendViaInternet() and only counts a message as delivered if the target
            // room already has at least one member. On every reconnect (page reload,
            // network blip, app backgrounded/foregrounded, cold start), the flush ran
            // while this very socket hadn't joined its own room yet, so the room had
            // zero members, the "delivered" check failed, and flush() clears the queue
            // regardless of outcome — the message was gone for good, not re-queued.
            // This is why messages sent while the receiver was briefly offline could
            // vanish permanently: the sender saw "sent", but the receiver's reconnect
            // flushed straight past an empty room and never got a retry.
            this._joinUserChatRooms(userId, socket).catch(() => {});

            // PHASE10: Register with HybridTransportRuntime for offline queue flush
            try {
                const htr = global.__HybridTransportRuntime;
                if (htr) {
                    const ip = socket.handshake?.address || '';
                    const subnetKey = ip.split('.').slice(0, 3).join('.');
                    htr.lan.register(String(userId), socket.id, subnetKey);
                    // Flush any queued messages for this user — safe now that the
                    // socket has already joined its personal rooms above.
                    htr.flushOfflineQueue(String(userId));
                    // Store userId on socket for HybridTransportRuntime lookups
                    socket._authenticatedUserId = String(userId);
                }
            } catch(_) {}

            // Allow client to join additional rooms
            // FIX-002: socket.off() before every socket.on() prevents listener accumulation on reconnect
            socket.removeAllListeners('join').on('join', ({ room } = {}) => {
                if (room && typeof room === 'string') {
                    socket.join(room);
                         _flog(`[WSService] uid=${userId} joined room: ${room}`);
                }
            });

            // join_user_room: moved below with call-room fix (see FIX-CALL-ROOM)

            socket.removeAllListeners('disconnect').on('disconnect', async (reason) => {
                this.removeUser(userId, socket);
                     _flog(`[WSService] socket disconnected uid=${userId} sid=${socket.id} reason=${reason}`);

                // ── STALE CALL FIX: When a user disconnects, end any DB call where
                // they are a participant and the call is still in a non-terminal
                // state. Without this, page reload replays the same call:incoming
                // on reconnect.
                //
                // FIX-STALE-CALL-2: the previous version of this block had three
                // bugs that made it largely a no-op in practice:
                //   1. status filter used 'active'/'ended', but the Call model's
                //      real ENUM is 'initiated','ringing','in-progress','completed',
                //      'missed','rejected','cancelled','failed' — so the query
                //      almost never matched a real row, and call.status = 'ended'
                //      was not a valid enum value (would fail validation on save).
                //   2. only checked callerId: userId — a disconnecting RECEIVER
                //      (the person who was being called) left the call dangling
                //      forever, since the query never looked at receiverId.
                //   3. read call.participantIds, a field that doesn't exist on
                //      this model for 1:1 calls (those use callerId/receiverId
                //      directly) — so the notify-other-party loop never ran.
                // FIX-STALE-CALL-3: only run this once this user's LAST socket
                // has disconnected (truly offline), not on every individual
                // socket drop — otherwise a user with two open tabs would have
                // their call ended just from closing one of them.
                //
                // FIX-NETWORK-BLIP: this cleanup used to run IMMEDIATELY and
                // synchronously on disconnect. On a weak/unstable connection the
                // Socket.IO client disconnects and reconnects within a second or
                // two on its own (transport hiccup, brief signal loss) — but this
                // handler was ending any in-progress call the instant the socket
                // dropped, before the client had any chance to reconnect. That is
                // the "low network disconnects the call instead of letting it
                // recover" bug. Fix: wait CALL_DISCONNECT_GRACE_MS before acting,
                // and re-check both "still offline" AND "call still non-terminal"
                // at that point. If the user reconnects (registerUser cancels this
                // timer) or the call was already ended/answered by then, we do
                // nothing.
                const uidInt = parseInt(userId, 10);
                if (this._pendingCallCleanupTimers.has(uidInt)) {
                    clearTimeout(this._pendingCallCleanupTimers.get(uidInt));
                }
                const CALL_DISCONNECT_GRACE_MS = 8000;
                const cleanupTimer = setTimeout(async () => {
                    this._pendingCallCleanupTimers.delete(uidInt);
                    try {
                        const stillOnline = this.onlineUsers && this.onlineUsers.has(uidInt);
                        if (!stillOnline) {
                            const Call = db.models?.Calls || db.models?.Call || db.Calls || db.Call;
                            if (Call) {
                                const staleCalls = await Call.findAll({
                                    where: {
                                        status: { [WsOp.in]: ['initiated', 'ringing', 'in-progress'] },
                                        [WsOp.or]: [{ callerId: userId }, { receiverId: userId }],
                                    }
                                }).catch(() => []);
                                for (const call of staleCalls) {
                                    call.status = 'completed';
                                    call.endedAt = new Date();
                                    if (call.startedAt) {
                                        call.duration = Math.floor((call.endedAt - call.startedAt) / 1000);
                                    }
                                    call.errorReason = call.errorReason || 'peer_disconnected';
                                    await call.save().catch(() => {});

                                    const otherUserId = String(call.callerId) === String(userId) ? call.receiverId : call.callerId;
                                    if (otherUserId) {
                                        const payload = { callId: call.id, reason: 'peer_disconnected', endedAt: call.endedAt.toISOString(), timestamp: Date.now() };
                                        await this.sendToUser(otherUserId, 'call:ended', payload).catch(() => {});
                                        await this.sendToUser(otherUserId, 'call_ended', payload).catch(() => {});
                                    }
                                         _flog(`[WSService] Stale call ${call.id} ended after grace period, uid=${userId} still offline`);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[WSService] stale-call cleanup error on disconnect:', e.message);
                    }
                }, CALL_DISCONNECT_GRACE_MS);
                this._pendingCallCleanupTimers.set(uidInt, cleanupTimer);
            });

            // ── TYPING INDICATORS — FIX: were completely missing ──────────────
            socket.removeAllListeners('typing:start').on('typing:start', ({ chatId } = {}) => {
                if (!chatId) return;
                socket.to(`chat:${chatId}`).emit('typing:start', {
                    chatId,
                    userId: String(userId),
                    timestamp: Date.now(),
                });
            });

            socket.removeAllListeners('typing:stop').on('typing:stop', ({ chatId } = {}) => {
                if (!chatId) return;
                socket.to(`chat:${chatId}`).emit('typing:stop', {
                    chatId,
                    userId: String(userId),
                    timestamp: Date.now(),
                });
            });

            // SETTINGS: relay cross-device settings changes
            socket.removeAllListeners('settings:update').on('settings:update', (payload) => {
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

            // ── FIX-CALL-ACK: Receiver signals that ring UI is showing ────────
            socket.removeAllListeners('call:received').on('call:received', async ({ callId, callerId } = {}) => {
                if (!callId) return;
                // Clear the 20-second no-answer timer for this call
                if (this._pendingCallAcks) this._pendingCallAcks.delete(callId);
                // Confirm to caller that receiver is ringing
                if (callerId) {
                    await this.sendToUser(callerId, 'call:receiver_ack', {
                        callId, receiverId: userId, timestamp: Date.now(),
                    }).catch(() => {});
                }
                     _flog(`[WSService] ✅ call:received ack — callId=${callId} uid=${userId}`);
            });

            // ── FIX-CALL-ROOM: join_user_room — verify both users reachable ──
            socket.removeAllListeners('join_user_room').on('join_user_room', ({ userId: uid, peerId } = {}) => {
                const rid    = parseInt(uid, 10);
                const strRid = String(rid);
                if (!rid || rid !== userId) return;
                socket.join(`user:${rid}`);
                socket.join(`user_${rid}`);
                socket.join(`user:${strRid}`);
                socket.join(`user_${strRid}`);
                const rooms = Array.from(socket.rooms || []);
                     _flog(`[WSService] uid=${userId} rooms: [${rooms.join(', ')}]`);
                // If peerId is provided (call setup), confirm peer is reachable
                if (peerId) {
                    Promise.resolve(this.isUserOnline(peerId)).then(online => {
                        socket.emit('peer_room_status', { peerId, online, timestamp: Date.now() });
                        if (!online) console.warn(`[WSService] ⚠️  Peer uid=${peerId} offline — call may fail`);
                    }).catch(() => {});
                }
            });

            // ── FIX-MSG-DELIVERY: Phase-2 ack — receiver confirms message got ─
            socket.removeAllListeners('message:delivery_ack').on('message:delivery_ack', async ({ messageId, chatId, senderId } = {}) => {
                if (!messageId || !senderId) return;
                this.clearMessageDeliveryTimeout(messageId);
                await this.sendToUser(senderId, 'message:delivered', {
                    messageId, chatId, deliveredTo: userId, timestamp: Date.now(),
                }).catch(() => {});
                     _flog(`[WSService] 📨 Delivered mid=${messageId} to uid=${userId}`);
            });

            // ── FIX-ONLINE-STATUS: Let sender check if receiver is online ─────
            socket.removeAllListeners('check_user_online').on('check_user_online', async ({ targetUserId } = {}) => {
                if (!targetUserId) return;
                const online = await this.isUserOnline(targetUserId).catch(() => false);
                socket.emit('user_online_status', { userId: targetUserId, online, timestamp: Date.now() });
            });

            // ── FIX: message:ack — sender confirms message was saved server-side ──
            // Previously the queue showed "sent successfully" but the backend never
            // received a socket-level ACK. Now the parent frame emits message:ack after
            // a successful POST /messages, and here we relay delivery:confirmed to sender
            // AND push a delivery notification to the recipient.
            socket.removeAllListeners('message:ack').on('message:ack', async ({ messageId, chatId, status } = {}) => {
                if (!messageId) return;
                try {
                    // Notify sender that message was durably saved
                    socket.emit('message:delivery_confirmed', {
                        messageId, chatId, status: status || 'delivered', timestamp: Date.now()
                    });
                } catch(_) {}
            });

            // ── FIX-OFFLINE-QUEUE: Flush any queued messages on reconnect ─────
            this.flushOfflineMessages(userId).catch(() => {});

            // ── PHASE14 FIX: sync:missed_messages ────────────────────────────
            socket.removeAllListeners('sync:missed_messages').on('sync:missed_messages', async ({ chatIds, since } = {}) => {
                try {
                    const sequelize = require('../models').sequelize;
                    if (!sequelize || !since) return;
                    const sinceDate = new Date(since);
                    if (isNaN(sinceDate.getTime())) return;
                    const chatList = Array.isArray(chatIds) ? chatIds.slice(0, 20) : [];
                    if (chatList.length === 0) {
                        const chats = await sequelize.query(
                            `SELECT DISTINCT "chatId" FROM chat_participants WHERE "userId" = :userId LIMIT 20`,
                            { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
                        ).catch(() => []);
                        chatList.push(...(chats || []).map(c => c.chatId));
                    }
                    for (const chatId of chatList) {
                        try {
                            const messages = await sequelize.query(
                                `SELECT m.*, u.username AS "senderUsername", u.avatar AS "senderAvatar"
                                 FROM "Messages" m
                                 LEFT JOIN "Users" u ON u.id = m."senderId"
                                 WHERE m."chatId" = :chatId AND m."createdAt" > :since AND m."isDeleted" = false
                                 ORDER BY m."createdAt" ASC LIMIT 50`,
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

            // ── PHASE14 FIX: sync:missed_events ──────────────────────────────
            socket.removeAllListeners('sync:missed_events').on('sync:missed_events', async ({ since } = {}) => {
                try {
                    const sinceDate = new Date(since);
                    if (isNaN(sinceDate.getTime())) return;
                    const payload = { since, events: [] };
                    try {
                        const sequelize = require('../models').sequelize;
                        const friends = await sequelize.query(
                            `SELECT f.id, f."requesterId", f."recipientId", f.status, f."createdAt",
                                    u.username AS "requesterUsername", u.avatar AS "requesterAvatar"
                             FROM "Friends" f
                             LEFT JOIN "Users" u ON u.id = f."requesterId"
                             WHERE f."recipientId" = :userId AND f.status = 'pending' AND f."createdAt" > :since
                             LIMIT 20`,
                            { replacements: { userId, since: sinceDate }, type: sequelize.QueryTypes.SELECT }
                        ).catch(() => []);
                        if (friends && friends.length > 0) {
                            friends.forEach(f => {
                                socket.emit('friend:request', {
                                    requestId: f.id, senderId: f.requesterId,
                                    senderUsername: f.requesterUsername, senderAvatar: f.requesterAvatar,
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

            // ── PHASE14 FIX: online:check ─────────────────────────────────────
            socket.removeAllListeners('online:check').on('online:check', ({ userIds } = {}) => {
                try {
                    if (!Array.isArray(userIds)) return;
                    const result = {};
                    userIds.slice(0, 50).forEach(uid => {
                        const intUid = parseInt(uid, 10);
                        result[uid] = this.onlineUsers && this.onlineUsers.has(intUid);
                    });
                    socket.emit('online:status', result);
                } catch (_) {}
            });

            // ── PHASE14 FIX: mark_as_read ─────────────────────────────────────
            socket.removeAllListeners('mark_as_read').on('mark_as_read', async ({ chatId, messageIds } = {}) => {
                try {
                    if (!chatId) return;
                    const sequelize = require('../models').sequelize;
                    if (Array.isArray(messageIds) && messageIds.length > 0) {
                        await sequelize.query(
                            `INSERT INTO "ReadReceipts" ("messageId","userId","readAt","createdAt","updatedAt")
                             SELECT unnest(ARRAY[:messageIds]::int[]), :userId, NOW(), NOW(), NOW()
                             ON CONFLICT ("messageId","userId") DO NOTHING`,
                            { replacements: { messageIds: messageIds.map(Number), userId }, type: sequelize.QueryTypes.INSERT }
                        ).catch(() => {});
                    }
                    socket.to(`chat:${chatId}`).emit('message:read', {
                        chatId, readerId: userId, messageIds: messageIds || [], readAt: new Date().toISOString()
                    });
                } catch (err) {
                    console.warn('[WSService] mark_as_read error:', err.message);
                }
            });

            // ── PHASE14 FIX: group:join ───────────────────────────────────────
            socket.removeAllListeners('group:join').on('group:join', async ({ groupId } = {}) => {
                try {
                    if (!groupId) return;
                    const sequelize = require('../models').sequelize;
                    const [member] = await sequelize.query(
                        `SELECT 1 FROM "GroupMembers" WHERE "groupId"=:groupId AND "userId"=:userId AND "leftAt" IS NULL LIMIT 1`,
                        { replacements: { groupId, userId }, type: sequelize.QueryTypes.SELECT }
                    ).catch(() => [null]);
                    if (member) {
                        socket.join(`group:${groupId}`);
                        socket.join(`group_${groupId}`);
                        socket.emit('group:joined', { groupId, success: true });
                             _flog(`[WSService] uid=${userId} joined group:${groupId}`);
                    }
                } catch (err) {
                    console.warn('[WSService] group:join error:', err.message);
                }
            });

            // ── PHASE14 FIX: message:delivered relay ──────────────────────────
            socket.removeAllListeners('message:delivered').on('message:delivered', ({ chatId, messageId } = {}) => {
                if (!chatId || !messageId) return;
                socket.to(`chat:${chatId}`).emit('message:delivered', {
                    chatId, messageId, deliveredTo: userId, deliveredAt: new Date().toISOString()
                });
            });

            // ── PHASE14 FIX P0: WebRTC socket-level signaling relay ───────────
            // FIX: this handler (and the three below it — webrtc_signal,
            // call:webrtc_offer, call:webrtc_answer) is now a deliberate
            // no-op. CallSignalingService (Phase 3) owns these events —
            // it re-registers all four with socket.removeAllListeners(...)
            // .on(...) once it initializes, which normally wipes out
            // whatever was bound here first. So in steady-state operation
            // these were already dead code. The problem: if Phase 3 ever
            // fails to initialize for any reason, the app silently falls
            // back to THIS implementation with no visible error — and this
            // version relays each offer/answer to 4 different room-name
            // variants under 2 different event names apiece, which is
            // exactly the kind of duplicate delivery that breaks WebRTC
            // (a second setRemoteDescription() on an already-negotiating
            // connection throws and drops the call). Rather than relying on
            // initialization-order luck to keep this dead, these are now
            // genuinely inert so CallSignalingService is the only possible
            // source of these events regardless of init timing.
            socket.removeAllListeners('webrtc:signal').on('webrtc:signal', () => {
                console.warn('[WSService] webrtc:signal received but CallSignalingService should own this — Phase 3 may not be initialized');
            });

            socket.removeAllListeners('webrtc_signal').on('webrtc_signal', () => {});

            socket.removeAllListeners('call:heartbeat').on('call:heartbeat', ({ callId: hbCallId, targetUserId: hbTarget } = {}) => {
                if (!hbCallId || !hbTarget) return;
                const io = this.getIO();
                if (!io) return;
                try {
                    io.to(`user:${hbTarget}`).emit('call:heartbeat', { callId: hbCallId, fromUserId: userId, ts: Date.now() });
                    io.to(`user_${hbTarget}`).emit('call:heartbeat', { callId: hbCallId, fromUserId: userId, ts: Date.now() });
                } catch (_) {}
            });

            // ── PHASE14 FIX: call:webrtc_offer / call:webrtc_answer relay ────
            // See the no-op note above — CallSignalingService owns these now.
            socket.removeAllListeners('call:webrtc_offer').on('call:webrtc_offer', () => {});

            socket.removeAllListeners('call:webrtc_answer').on('call:webrtc_answer', () => {});

            // ── PHASE14 FIX P0: message:send socket handler ───────────────────
            socket.removeAllListeners('message:send').on('message:send', async (payload = {}) => {
                try {
                    const { chatId: msChatId, content: msContent, type: msType = 'text', replyToId: msReplyId, localId: msLocalId } = payload;
                    if (!msChatId || !msContent) {
                        socket.emit('message:send:error', { localId: msLocalId, error: 'chatId and content are required' });
                        return;
                    }
                    const messageService = require('./messageService');
                    const msg = await messageService.createMessage({
                        chatId: parseInt(msChatId, 10), senderId: userId,
                        content: String(msContent).trim().substring(0, 5000), type: msType,
                        replyToId: msReplyId ? parseInt(msReplyId, 10) : null
                    });
                    socket.emit('message:send:ack', { localId: msLocalId, messageId: msg.id, chatId: msChatId, sentAt: msg.sentAt || msg.createdAt });
                } catch (err) {
                    const { localId: msErrLocalId } = payload || {};
                    console.warn('[WSService] message:send socket error:', err.message);
                    socket.emit('message:send:error', { localId: msErrLocalId, error: err.message });
                }
            });


            // ── Multi-device call sync ────────────────────────────────────────────
            // When user answers/declines on one device, broadcast to ALL their other
            // devices so the incoming call UI dismisses everywhere automatically.
            socket.removeAllListeners('call:device_sync').on('call:device_sync', async (payload = {}) => {
                try {
                    const { callId: syncCallId, action } = payload; // action: 'answered'|'declined'|'ended'
                    if (!syncCallId || !action) return;
                    const io = this.getIO();
                    if (io) {
                        const syncPayload = { callId: syncCallId, action, userId, timestamp: Date.now() };
                        io.to(`user:${userId}`).except(socket.id).emit('call:device_sync', syncPayload);
                        io.to(`user_${userId}`).except(socket.id).emit('call:device_sync', syncPayload);
                    }
                } catch (err) { console.warn('[WSService] call:device_sync error:', err.message); }
            });

            // ── Live Caption relay ────────────────────────────────────────────────
            socket.removeAllListeners('call:caption').on('call:caption', async (payload = {}) => {
                try {
                    const { callId: capCallId, text, ts } = payload;
                    if (!capCallId || !text) return;
                    const Call = this._db && (this._db.Calls || this._db.Call);
                    if (!Call) return;
                    const callRecord = await Call.findOne({ where: { id: capCallId } }).catch(() => null);
                    if (!callRecord) return;
                    const isParticipant = (callRecord.participants || []).includes(userId) ||
                                         callRecord.callerId === userId || callRecord.receiverId === userId;
                    if (!isParticipant) return;
                    const User = this._db && (this._db.Users || this._db.User);
                    let senderName = `User ${userId}`;
                    if (User) {
                        const u = await User.findByPk(userId, { attributes: ['username'] }).catch(() => null);
                        if (u) senderName = u.username;
                    }
                    const out = { callId: capCallId, text: String(text).substring(0, 500), senderId: userId, senderName, ts: ts || Date.now() };
                    for (const pid of (callRecord.participants || []).filter(p => p !== userId)) {
                        await this.sendToUser(pid, 'call:caption', out);
                        // Dispatch to frontend via custom event name for SR announcements
                        await this.sendToUser(pid, 'kyn:socket:call:caption', out);
                    }
                } catch (err) { console.warn('[WSService] call:caption relay error:', err.message); }
            });

            // ── Waiting room knock ─────────────────────────────────────────────────
            socket.removeAllListeners('call:waiting_room_knock').on('call:waiting_room_knock', async (payload = {}) => {
                try {
                    const { callId: wrCallId } = payload;
                    if (!wrCallId) return;
                    const Call = this._db && (this._db.Calls || this._db.Call);
                    if (!Call) return;
                    const callRecord = await Call.findOne({ where: { id: wrCallId } }).catch(() => null);
                    if (!callRecord) return;
                    const User = this._db && (this._db.Users || this._db.User);
                    let uInfo = { userId, username: `User ${userId}` };
                    if (User) {
                        const u = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] }).catch(() => null);
                        if (u) uInfo = { userId, username: u.username, avatar: u.avatar };
                    }
                    await this.sendToUser(callRecord.callerId, 'call:waiting_room_join', { callId: wrCallId, participant: uInfo, timestamp: Date.now() });
                } catch (err) { console.warn('[WSService] waiting_room_knock error:', err.message); }
            });

            // ── In-call poll relay ────────────────────────────────────────────────
            socket.removeAllListeners('call:poll_event').on('call:poll_event', async (payload = {}) => {
                try {
                    const { callId: pollCallId, action, poll, vote, pollId } = payload;
                    if (!pollCallId || !action) return;

                    const Call = this._db && (this._db.Calls || this._db.Call);
                    if (!Call) return;

                    const callRecord = await Call.findOne({ where: { id: pollCallId } }).catch(() => null);
                    if (!callRecord) return;

                    const participants = callRecord.participants || [];
                    const isParticipant = participants.includes(userId) ||
                                         callRecord.callerId === userId ||
                                         callRecord.receiverId === userId;
                    if (!isParticipant) return;

                    const outPayload = { callId: pollCallId, action, poll, vote, pollId, senderId: userId, timestamp: Date.now() };
                    for (const pid of participants.filter(p => p !== userId)) {
                        await this.sendToUser(pid, 'call:poll_event', outPayload);
                    }
                } catch (err) {
                    console.warn('[WSService] call:poll_event relay error:', err.message);
                }
            });

            // ── In-call chat relay — persists messages across ICE restarts ───────
            // Frontend dual-paths chat: data channel (fast) + socket (persistent).
            // This handler relays the message to all OTHER call participants so
            // the in-call chat is not lost when data channels are recreated.
            socket.removeAllListeners('call:chat_message').on('call:chat_message', async (payload = {}) => {
                try {
                    const { callId: chatCallId, message: chatMsg, timestamp: chatTs } = payload;
                    if (!chatCallId || !chatMsg) return;

                    // Verify sender is a participant
                    const Call = this._db && (this._db.Calls || this._db.Call);
                    if (!Call) return;

                    const callRecord = await Call.findOne({
                        where: {
                            id: chatCallId,
                            status: { [WsOp.in]: ['ringing', 'in-progress'] },
                        },
                    }).catch(() => null);

                    if (!callRecord) return;

                    const participants = callRecord.participants || [];
                    const isParticipant = participants.includes(userId) ||
                                         callRecord.callerId === userId ||
                                         callRecord.receiverId === userId;
                    if (!isParticipant) return;

                    const outPayload = {
                        callId:    chatCallId,
                        message:   String(chatMsg).substring(0, 2000),
                        senderId:  userId,
                        timestamp: chatTs || Date.now(),
                    };

                    // Relay to all other participants
                    const otherParticipants = participants.filter(pid => pid !== userId);
                    for (const pid of otherParticipants) {
                        await this.sendToUser(pid, 'call:chat_message', outPayload);
                    }
                } catch (err) {
                    console.warn('[WSService] call:chat_message relay error:', err.message);
                }
            });
        });

        _flog('[WSService] Connection handler registered ✅');
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
                     _flog(`[WSService] Evicting oldest socket ${sid} for uid=${uid} (limit ${MAX_SOCKETS_PER_USER})`);
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

        // FIX-NETWORK-BLIP: If this user had a call-cleanup timer pending from a
        // recent disconnect (see the 'disconnect' handler below), cancel it — they
        // reconnected within the grace period, so the call should NOT be ended.
        if (this._pendingCallCleanupTimers && this._pendingCallCleanupTimers.has(uid)) {
            clearTimeout(this._pendingCallCleanupTimers.get(uid));
            this._pendingCallCleanupTimers.delete(uid);
             _flog(`[WSService] uid=${uid} reconnected within grace period — cancelled pending call cleanup`);
        }

        if (!this.onlineUsers.has(uid)) this.onlineUsers.set(uid, new Set());
        this.onlineUsers.get(uid).add(socketId);

        // FIX-AUDIT: io.emit() broadcasts to EVERY connected socket on the server,
        // not just this user's contacts. Two problems: (1) privacy — any stranger
        // can observe this user's online status; (2) scalability — at 100M+
        // concurrent users this is an O(N) fan-out per single connect event,
        // which is catastrophic for throughput. Restrict delivery to the user's
        // actual contacts/chat participants via targeted per-room emits instead.
        this._broadcastPresenceToContacts(uid, 'user:online', { userId: uid, timestamp: Date.now() })
            .catch(() => {});

        if (socketOrSocketId && typeof socketOrSocketId.join === 'function') {
            const joinRooms = () => {
                // FIX-AUDIT: `${uid}` and `${String(uid)}` are the SAME string in a
                // template literal — there were only ever 2 distinct room names here,
                // each joined twice. Reduced to the 2 actually-distinct rooms.
                socketOrSocketId.join(`user:${uid}`);
                socketOrSocketId.join(`user_${uid}`);

                // Gated: only log per-connect room detail when DEBUG_MESSAGES is on
                try {
                    const actualRooms = Array.from(socketOrSocketId.rooms || []);
                    _flog(`[WSService] registerUser uid=${uid} socket=${socketId} rooms joined ✅ — in rooms: [${actualRooms.join(', ')}]`);
                } catch (_) {
                    _flog(`[WSService] registerUser uid=${uid} socket=${socketId} rooms joined ✅`);
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
                // FIX-AUDIT: scope offline broadcast to contacts only (see online fix above)
                this._broadcastPresenceToContacts(uid, 'user:offline', {
                    userId: uid, lastSeen: new Date().toISOString(), timestamp: Date.now()
                }).catch(() => {});
            }
        }

             _flog(`[WSService] removeUser uid=${uid} socket=${socketId}`);
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
            _flog(`[WSService] EMITTING TO: uid=${uid} event=${event}`);
        }

        // NOTE: HTR routing is handled by the phase10.bootstrap.js wrapper that overrides
        // this function. When called directly (as fallback from that wrapper), we do pure
        // Socket.IO delivery here — no HTR to avoid double-delivery and recursion.

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
        // ── Multi-device sync: ALL of a user's devices are in these rooms ──────────
        // When a call is accepted on device A, device B (same user) receives the same
        // call:accepted event and can dismiss its incoming call UI automatically.
        //
        // FIX-DELIVERED-FALSE-POSITIVE: io.to(room).emit() never throws even when the
        // room has zero members — Socket.IO broadcasts are fire-and-forget. The old code
        // set delivered = true unconditionally inside the try block, so a fully offline
        // recipient was reported as "delivered". Two real consequences: (1) the offline
        // push-notification fallback in messages.js (POST /messages) never fired, because
        // it only triggers when sendToUser resolves false; (2) message:delivery_failed /
        // delivery-timeout bookkeeping never saw a true failure. We now check the room's
        // actual member count via io.sockets.adapter.rooms before counting it as delivered.
        // FIX-AUDIT (MSG-WS-001): `uid` is already coerced via parseInt(userId, 10)
        // at the top of this method. In a JS template literal, `${uid}` and
        // `${String(uid)}` ALWAYS produce the identical string — there is no
        // "integer room" vs "string room" distinction at the room-name level,
        // since Socket.IO room names are always strings. The previous 4-entry
        // array therefore emitted to only 2 actually-distinct room names, each
        // twice — doubling socket I/O across the whole platform for zero benefit.
        const rooms = [
            `user:${uid}`,
            `user_${uid}`,
        ];
        for (const room of rooms) {
            try {
                const roomSet = io.sockets?.adapter?.rooms?.get(room);
                const hasMembers = !!(roomSet && roomSet.size > 0);
                io.to(room).emit(event, payload);
                if (hasMembers) delivered = true;
            } catch (_) {}
        }

        if (delivered) {
            _flog(`[FORENSIC] RECEIVER_RECEIVED | uid=${uid} | event=${event} | rooms=[${rooms.join(',')}] | ts=${Date.now()}`);
        }

        // Per-socket-ID fallback — ONLY when room emit missed (receiver not in any room yet).
        // This handles the race where the socket connected but hasn't joined user:X rooms yet.
        // When delivered=true (room emit worked), skip this block to prevent duplicate delivery.
        if (!delivered) {
            const socketIds = await this.getSocketIdsForUser(uid);
            for (const sid of socketIds) {
                if (!this._isSocketAliveInAdapter(io, sid)) {
                    const set = this.onlineUsers.get(uid);
                    if (set) set.delete(sid);
                    continue;
                }
                try { io.to(sid).emit(event, payload); delivered = true; } catch (_) {}
            }
        }

        // FIX-OFFLINE-QUEUE: If not delivered and it's a message event, enqueue for retry
        if (!delivered) {
            const _queueableEvents = ['new_message', 'message:new', 'message_received', 'chat:message'];
            if (_queueableEvents.includes(event)) {
                this.enqueueOfflineMessage(uid, event, data);
            }
        }

        return delivered;
    }

    // ── CALL / SIGNAL HELPERS ─────────────────────────────────────────────────

    async notifyCallInitiated(userId, data = {}) {
        // FIX-003: single canonical event 'call:incoming' only
        const delivered = await this.sendToUser(userId, 'call:incoming', data);

        // FIX-CALL-ONLINE: When receiver IS online but sendToUser returns false
        // (socket adapter mismatch or room join race), also try emitting directly
        // to the call room if it exists, and to socket IDs directly.
        if (!delivered) {
            const io = this.getIO();
            if (io && data.callId) {
                try {
                    // Try the call room (CallSignalingService may have pre-joined receiver)
                    io.to(`call:${data.callId}`).emit('call:incoming', {
                        ...data, timestamp: Date.now()
                    });
                } catch(_) {}
            }
        }

        // FIX-CALL-OFFLINE: receiver not connected — tell caller immediately
        if (!delivered && data.callerId) {
            // Double-check: isUserOnline is the authoritative source
            const receiverOnline = await this.isUserOnline(userId).catch(() => false);
            if (!receiverOnline) {
                await this.sendToUser(data.callerId, 'call:receiver_offline', {
                    callId: data.callId, reason: 'receiver_offline', timestamp: Date.now(),
                }).catch(() => {});
                console.warn(`[WSService] 📵 Receiver uid=${userId} offline — notified caller`);
                return false;
            }
            // Receiver IS online but delivery failed — log and still return true
            // so the call room route above gets a chance to deliver
            console.warn(`[WSService] ⚠️ call:incoming delivery uncertain for uid=${userId} — tried call room`);
        }

        // FIX-CALL-TIMEOUT: 20-second "no answer" guard
        // notifyCallReceived() (called when receiver's UI shows the ring) clears this.
        const callId   = data.callId;
        const callerId = data.callerId;
        if (callId && callerId) {
            if (!this._pendingCallAcks) this._pendingCallAcks = new Set();
            this._pendingCallAcks.add(callId);
            setTimeout(async () => {
                if (this._pendingCallAcks && this._pendingCallAcks.has(callId)) {
                    this._pendingCallAcks.delete(callId);
                    await this.sendToUser(callerId, 'call:no_answer', {
                        callId, reason: 'user_didnt_answer', timestamp: Date.now(),
                    }).catch(() => {});
                         _flog(`[WSService] 📵 Call ${callId} — no answer after 20s`);
                }
            }, 20_000);
        }

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

    // ── FIX-MSG-DELIVERY: Two-phase delivery timeout (10 s) ──────────────────
    /**
     * Call this right after emitting 'new_message' to the receiver.
     * Cleared when receiver's socket fires 'message:delivery_ack'.
     */
    scheduleMessageDeliveryTimeout(messageId, chatId, senderId) {
        if (!this._msgTimeouts) this._msgTimeouts = new Map();
        const key = `msg:${messageId}`;
        if (this._msgTimeouts.has(key)) return;
        const t = setTimeout(async () => {
            this._msgTimeouts.delete(key);
            await this.sendToUser(senderId, 'message:delivery_failed', {
                messageId, chatId, reason: 'delivery_timeout', timestamp: Date.now(),
            }).catch(() => {});
            console.warn(`[WSService] ⚠️  Message ${messageId} undelivered after 10s — sender notified`);
        }, 10_000);
        this._msgTimeouts.set(key, t);
    }

    clearMessageDeliveryTimeout(messageId) {
        if (!this._msgTimeouts) return;
        const t = this._msgTimeouts.get(`msg:${messageId}`);
        if (t) { clearTimeout(t); this._msgTimeouts.delete(`msg:${messageId}`); }
    }

    // ── FIX-OFFLINE-QUEUE: Store messages for offline users; flush on reconnect ─
    enqueueOfflineMessage(targetUserId, event, payload) {
        if (!this._offlineQueue) this._offlineQueue = new Map();
        const uid = String(targetUserId);
        if (!this._offlineQueue.has(uid)) this._offlineQueue.set(uid, []);
        const q = this._offlineQueue.get(uid);
        if (q.length < 200) q.push({ event, payload, queuedAt: Date.now() });
             _flog(`[WSService] 📦 Queued offline msg for uid=${uid} (total: ${q.length})`);
    }

    async flushOfflineMessages(userId) {
        if (!this._offlineQueue) return;
        const uid = String(userId);
        const queue = this._offlineQueue.get(uid);
        if (!queue || queue.length === 0) return;
        this._offlineQueue.delete(uid);
             _flog(`[WSService] 🚀 Flushing ${queue.length} queued msgs to uid=${uid}`);
        for (const item of queue) {
            await this.sendToUser(userId, item.event, item.payload).catch(() => {});
        }
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

    /**
     * FIX-AUDIT: Scoped presence broadcast — replaces the old io.emit() global
     * fan-out for user:online / user:offline. Looks up the set of users who
     * share a chat with `uid` (their actual contacts) and emits only to them.
     * Falls back to a no-op (not a global broadcast) if the lookup fails, since
     * silently degrading to "no presence update" is far safer than leaking
     * presence to the entire user base.
     */
    async _broadcastPresenceToContacts(uid, event, payload) {
        const io = this.getIO();
        if (!io || !uid) return false;
        try {
            const db = require('../models');
            const sequelize = db.sequelize || db;
            const contacts = await sequelize.query(
                `SELECT DISTINCT cp2."userId" FROM chat_participants cp1
                 JOIN chat_participants cp2 ON cp2."chatId" = cp1."chatId" AND cp2."userId" != cp1."userId"
                 WHERE cp1."userId" = :uid`,
                { replacements: { uid }, type: sequelize.QueryTypes.SELECT }
            );
            for (const row of (contacts || [])) {
                const cid = row.userId;
                if (cid) {
                    io.to(`user:${cid}`).emit(event, payload);
                    io.to(`user_${cid}`).emit(event, payload);
                }
            }
            return true;
        } catch (_) {
            return false;
        }
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

    // FIX-GROUP-CALL-NOTICE: notify every member of a group (via their own
    // user:{id} room, not just members currently sitting inside the group's
    // socket room) that a voice/video call has just started, so the group
    // chat screen can show a "<caller> started a call — Join" banner even
    // for members who have the group list open rather than the group itself.
    async notifyGroupCallStarted(groupId, { callId, callerId, callerName, callType, groupName } = {}) {
        const payload = {
            groupId, callId, callerId, callerName: callerName || 'Someone',
            callType: callType || 'audio', groupName: groupName || null,
            timestamp: new Date().toISOString()
        };
        // Broadcast to sockets already in the group room AND to every member's
        // personal user room (covers members who haven't opened this group yet).
        this.broadcastToGroup(groupId, 'group:call-started', payload, callerId);
        return this.broadcastGroupMessageToMembers(groupId, 'group:call-started', payload);
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
                 _flog(`[WSService] Stale reaper removed ${pruned} dead socket(s).`);
        }
    }

    async _joinUserChatRooms(userId, socket) {
        if (!userId || !socket || typeof socket.join !== 'function') return;

        // ── CRITICAL: Join personal user rooms FIRST (sync, no DB needed) ────
        const uid    = parseInt(userId, 10);
        const strUid = String(uid);
        socket.join(`user:${uid}`);
        socket.join(`user_${uid}`);
        socket.join(`user:${strUid}`);
        socket.join(`user_${strUid}`);
             _flog(`[WSService] uid=${userId} joined personal user rooms: user:${uid}, user_${uid}`);

        try {
            const db = require('../models');
            const sequelize = db.sequelize || db;
            if (!sequelize || typeof sequelize.query !== 'function') return;

            // FIX-PHASE15: Try both casing variants of chat_participants table.
            // Sequelize defines it as 'chat_participants' (lowercase) but some
            // Postgres deployments preserve case or have a different migration.
            let chatRows = [];
            const chatQueries = [
                'SELECT "chatId" FROM chat_participants WHERE "userId" = :userId',
                'SELECT "chatId" FROM "ChatParticipants" WHERE "userId" = :userId',
            ];
            for (const q of chatQueries) {
                try {
                    chatRows = await sequelize.query(q,
                        { replacements: { userId }, type: sequelize.QueryTypes.SELECT });
                    if (chatRows && chatRows.length >= 0) break; // found the right table
                } catch (_) { chatRows = []; }
            }

            for (const { chatId } of (chatRows || [])) {
                if (chatId) {
                    socket.join(`chat:${chatId}`);
                    socket.join(`chat_${chatId}`);
                }
            }

            // Join group rooms
            let groupRows = [];
            try {
                groupRows = await sequelize.query(
                    'SELECT "groupId" FROM "GroupMembers" WHERE "userId" = :userId AND status != \'left\' AND status != \'banned\'',
                    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
                );
            } catch (_) {
                try {
                    groupRows = await sequelize.query(
                        'SELECT "groupId" FROM "GroupMembers" WHERE "userId" = :userId',
                        { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
                    );
                } catch (__) {}
            }

            for (const { groupId } of (groupRows || [])) {
                if (groupId) {
                    socket.join(`group:${groupId}`);
                    socket.join(`group_${groupId}`);
                }
            }

            const totalRooms = (chatRows || []).length + (groupRows || []).length;
            if (totalRooms > 0) {
                     _flog(`[WSService] uid=${userId} auto-joined ${(chatRows||[]).length} chat room(s) + ${(groupRows||[]).length} group room(s)`);
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
             _flog(`[WSService] uid=${userId} rejoined group:${groupId}`);
    }
}

// ── NOTE: All PHASE14 handlers (sync, mark_as_read, group:join, webrtc, message:send)
// have been moved INSIDE the main setupConnectionHandler() in the WebSocketService class.
// The monkey-patch pattern below was removed because each patch registered a NEW
// io.on('connection') listener, resulting in 5 duplicate connection handlers firing
// for every socket connection — causing duplicate DB writes, duplicate event emissions,
// and the "duplicate listeners" console warnings.
//
// All handlers are now in the single io.on('connection') block inside the class.

module.exports = new WebSocketService();
