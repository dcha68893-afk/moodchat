'use strict';
/**
 * conversations.js — Alias router that maps /api/conversations/* to the chats system
 *
 * Frontend api.messages.js uses /api/conversations/:id/messages paths.
 * Backend uses /api/chats/:id/messages. This router bridges the two so both
 * URL shapes work without changing frontend code.
 */
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');

let chatsRouter = null;
function getChatsRouter() {
    if (!chatsRouter) {
        try { chatsRouter = require('./chats'); } catch (_) {}
        try { chatsRouter = chatsRouter || require('./messages'); } catch (_) {}
    }
    return chatsRouter;
}

// SECURITY FIX (audit-driven, 2026-09-11 — IDOR): every route below used to
// operate on `:conversationId` with no check whatsoever that the requesting
// user (`req.user.id`) is actually a participant of that chat. Since this
// router is documented above as the real path the frontend's api.messages.js
// uses for /api/conversations/* URLs — not a dead/unused alias — this meant
// any authenticated user could: (1) fetch any other chat's metadata via
// GET /:conversationId, (2) read the full message history of any chat via
// GET /:conversationId/messages (plaintext for the several message types
// identified as unencrypted in the audit — status replies, polls, live
// location, game shares — and still chat metadata/participant info even for
// encrypted ones), and (3) inject a message into any other users' chat via
// POST /:conversationId/messages, simply by guessing or incrementing a
// numeric chat id. Added a single shared membership check, applied to all
// three handlers below, matching the participant-check pattern already used
// elsewhere in this codebase (see chatParticipantService.js).
async function assertParticipant(db, chatId, userId) {
    const ChatParticipant = db?.ChatParticipant || db?.ChatParticipants;
    if (!ChatParticipant || typeof ChatParticipant.isUserInChat !== 'function') {
        // Model/helper genuinely unavailable — fail closed rather than
        // silently allowing access we can't verify.
        const err = new Error('Membership could not be verified');
        err.statusCode = 503;
        throw err;
    }
    // Reuses the model's own existing helper (models/ChatParticipant.js)
    // instead of a second hand-rolled membership query.
    const ok = await ChatParticipant.isUserInChat(userId, chatId).catch(() => false);
    if (!ok) {
        const err = new Error('You are not a participant of this conversation');
        err.statusCode = 403;
        throw err;
    }
}

// GET /api/conversations — list conversations (= chats)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const db    = req.app.locals.models;
        const Chat  = db?.Chats || db?.Chat;
        const uid   = req.user?.id || req.user?.userId;
        if (!Chat) return res.json({ success: true, data: [], message: 'Model unavailable' });

        const { Op } = require('sequelize');
        const chats = await Chat.findAll({
            include: [{ association: 'participants', where: { userId: uid }, required: true }],
            order: [['updatedAt', 'DESC']],
            limit: parseInt(req.query.limit) || 50,
        }).catch(() => []);
        return res.json({ success: true, data: chats });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/conversations/pinned|muted|archived|backup|restore
router.get('/pinned',   authenticateToken, (req, res) => res.json({ success: true, data: [] }));
router.get('/muted',    authenticateToken, (req, res) => res.json({ success: true, data: [] }));
router.get('/archived', authenticateToken, (req, res) => res.json({ success: true, data: [] }));
router.get('/backup',   authenticateToken, (req, res) => res.json({ success: true, data: [], format: 'json' }));
router.post('/restore', authenticateToken, (req, res) => res.json({ success: true, restored: 0 }));

// GET /api/conversations/:conversationId — get a single chat
router.get('/:conversationId', authenticateToken, async (req, res) => {
    try {
        const db   = req.app.locals.models;
        const Chat = db?.Chats || db?.Chat;
        const uid  = req.user?.id || req.user?.userId;
        if (!Chat) return res.json({ success: true, data: null });
        await assertParticipant(db, req.params.conversationId, uid); // SECURITY FIX: was missing
        const chat = await Chat.findByPk(req.params.conversationId).catch(() => null);
        if (!chat) return res.status(404).json({ success: false, message: 'Conversation not found' });
        return res.json({ success: true, data: chat });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// GET /api/conversations/:id/messages
router.get('/:conversationId/messages', authenticateToken, async (req, res) => {
    try {
        const db      = req.app.locals.models;
        const Message = db?.Messages || db?.Message;
        const uid     = req.user?.id || req.user?.userId;
        if (!Message) return res.json({ success: true, data: [] });
        await assertParticipant(db, req.params.conversationId, uid); // SECURITY FIX: was missing — this previously let any authenticated user read any chat's message history
        const msgs = await Message.findAll({
            where: { chatId: req.params.conversationId },
            order: [['createdAt', 'ASC']],
            limit: parseInt(req.query.limit) || 50,
            offset: parseInt(req.query.offset) || 0,
        }).catch(() => []);
        return res.json({ success: true, data: msgs });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// POST /api/conversations/:id/messages
//
// SECURITY FIX (audit-driven — was: IDOR + unauthenticated plaintext INSERT):
// this handler previously (a) let any authenticated user write a message
// into ANY chatId with no membership check, and (b) inserted req.body.content
// directly with no encryption requirement, no clientMessageId, and none of
// the idempotency/validation this codebase's canonical send path already
// has (see services/messageDeliveryService.js's sendMessage, which the
// primary POST /messages route uses). This handler still cannot verify the
// caller actually encrypted `content` client-side — that has to happen in
// the browser before this request is made, and is outside what a server
// route can enforce — but it now at minimum: requires the caller to be a
// real participant of the chat, requires a clientMessageId so retries are
// idempotent instead of creating duplicate rows, and caps content length
// to match the canonical path's limit (defense against unbounded payloads).
// If nothing in the frontend actually calls this alias route (unverified —
// flagged in the audit), the safer long-term fix is removing it entirely in
// favor of the single canonical POST /messages path.
router.post('/:conversationId/messages', authenticateToken, async (req, res) => {
    try {
        const db      = req.app.locals.models;
        const Message = db?.Messages || db?.Message;
        if (!Message) return res.status(503).json({ success: false, message: 'Model unavailable' });
        const uid = req.user?.id || req.user?.userId;
        await assertParticipant(db, req.params.conversationId, uid); // SECURITY FIX: was missing
        const clientMessageId = req.body.clientMessageId || req.body.localId;
        if (!clientMessageId) {
            return res.status(400).json({ success: false, message: 'clientMessageId is required for idempotent send' });
        }
        const rawContent = req.body.content || req.body.message || '';
        const content = String(rawContent).trim().substring(0, 5000);
        if (!content) return res.status(400).json({ success: false, message: 'Content cannot be empty' });

        // Idempotency: mirror messageDeliveryService.sendMessage's dedup check
        // so a retry through THIS route doesn't create a duplicate row either.
        const sequelize = db.sequelize;
        const [existing] = await sequelize.query(
            `SELECT * FROM "Messages" WHERE "senderId" = :senderId
               AND ("clientMessageId" = :clientMessageId OR metadata->>'localId' = :clientMessageId) LIMIT 1`,
            { replacements: { senderId: uid, clientMessageId }, type: sequelize.QueryTypes.SELECT }
        ).catch(() => [null]);
        if (existing) return res.status(200).json({ success: true, data: existing, deduped: true });

        const msg = await Message.create({
            chatId:   req.params.conversationId,
            senderId: uid,
            content,
            type:     req.body.type || 'text',
            clientMessageId,
        });
        return res.status(201).json({ success: true, data: msg });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// POST /api/conversations/:id/messages/read
router.post('/:conversationId/messages/read', authenticateToken, (req, res) =>
    res.json({ success: true, marked: true }));

module.exports = router;
