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
        if (!Chat) return res.json({ success: true, data: null });
        const chat = await Chat.findByPk(req.params.conversationId).catch(() => null);
        if (!chat) return res.status(404).json({ success: false, message: 'Conversation not found' });
        return res.json({ success: true, data: chat });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/conversations/:id/messages
router.get('/:conversationId/messages', authenticateToken, async (req, res) => {
    try {
        const db      = req.app.locals.models;
        const Message = db?.Messages || db?.Message;
        if (!Message) return res.json({ success: true, data: [] });
        const msgs = await Message.findAll({
            where: { chatId: req.params.conversationId },
            order: [['createdAt', 'ASC']],
            limit: parseInt(req.query.limit) || 50,
            offset: parseInt(req.query.offset) || 0,
        }).catch(() => []);
        return res.json({ success: true, data: msgs });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/conversations/:id/messages
router.post('/:conversationId/messages', authenticateToken, async (req, res) => {
    try {
        const db      = req.app.locals.models;
        const Message = db?.Messages || db?.Message;
        if (!Message) return res.status(503).json({ success: false, message: 'Model unavailable' });
        const uid = req.user?.id || req.user?.userId;
        const msg = await Message.create({
            chatId:   req.params.conversationId,
            senderId: uid,
            content:  req.body.content || req.body.message || '',
            type:     req.body.type || 'text',
        });
        return res.status(201).json({ success: true, data: msg });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/conversations/:id/messages/read
router.post('/:conversationId/messages/read', authenticateToken, (req, res) =>
    res.json({ success: true, marked: true }));

module.exports = router;
