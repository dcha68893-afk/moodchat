/**
 * routes/contact.js — "Contact Us" (login page + Settings)
 * ──────────────────────────────────────────────────────────────────────────
 * FIX (contact-us-goes-nowhere): the frontend contact form previously had
 * nowhere to send to — index.html's submit handler literally faked success
 * with a comment reading "In production this would POST to /api/contact".
 * This file IS that endpoint.
 *
 * POST /api/contact            — public (optional auth) — submit a message
 * GET  /api/contact/inbox       — admin only — list submissions
 * POST /api/contact/:id/read    — admin only — mark as read
 *
 * Delivery model:
 *  1. Always durably stored in contact_messages first (never lost even if
 *     step 2 fails).
 *  2. If the visitor is logged in AND an admin account is resolvable via
 *     ADMIN_EMAIL / ADMIN_USERNAME in .env, the message is ALSO delivered
 *     as a real chat message straight into that admin's normal message
 *     panel (a direct chat between the sender and the admin), using the
 *     existing ChatService — so "Contact Us" behaves like any other
 *     conversation instead of a one-off mailbox.
 *  3. The admin identity is resolved ONLY from ADMIN_EMAIL/ADMIN_USERNAME
 *     in .env, matching how admin login access already works (see
 *     controllers/authController.js and middleware/auth.js) — messages
 *     never get routed to anyone else.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { optionalAuthenticateToken, authenticateToken, adminOnly } = require('../middleware/auth');

let ChatService;
try { ChatService = require('../services/chatService'); } catch (_) { ChatService = null; }

function getModels() {
    try { return require('../models'); } catch (_) { return null; }
}

async function _resolveAdminUser() {
    const db = getModels();
    if (!db || !db.models || !db.models.Users) return null;
    const adminEmail    = (process.env.ADMIN_EMAIL    || '').toLowerCase().trim();
    const adminUsername = (process.env.ADMIN_USERNAME || '').toLowerCase().trim();
    if (!adminEmail && !adminUsername) return null;

    const { Op } = require('sequelize');
    const where = { [Op.or]: [] };
    if (adminEmail)    where[Op.or].push({ email: adminEmail });
    if (adminUsername) where[Op.or].push({ username: adminUsername });
    if (!where[Op.or].length) return null;

    try {
        return await db.models.Users.findOne({ where });
    } catch (e) {
        console.error('[Contact] Failed to resolve admin user from .env:', e.message);
        return null;
    }
}

// ── POST /api/contact — submit a message ────────────────────────────────────
router.post('/', optionalAuthenticateToken, async (req, res) => {
    try {
        const { name, email, subject, message } = req.body || {};

        if (!name || !email || !subject || !message) {
            return res.status(400).json({ success: false, message: 'Name, email, subject and message are all required.' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
            return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
        }

        const db = getModels();
        if (!db || !db.models || !db.models.ContactMessage) {
            return res.status(503).json({ success: false, message: 'Contact system is not available right now — please try again shortly.' });
        }

        const senderId = req.user ? (req.user.id || req.user.userId) : null;

        // Step 1: durable storage — always happens first.
        const record = await db.models.ContactMessage.create({
            senderId,
            name: String(name).trim().slice(0, 150),
            email: String(email).trim().slice(0, 255),
            subject: String(subject).trim().slice(0, 50),
            message: String(message).trim().slice(0, 5000),
        });

        // Step 2: also deliver into the admin's real message panel, if possible.
        let deliveredToChat = false;
        let chatId = null;
        try {
            if (senderId && ChatService) {
                const admin = await _resolveAdminUser();
                if (admin && String(admin.id) !== String(senderId)) {
                    const { chat } = await ChatService.createDirectChat(senderId, admin.id);
                    const content =
                        `📩 Contact Us submission\n` +
                        `Subject: ${record.subject}\n` +
                        `From: ${record.name} <${record.email}>\n\n` +
                        `${record.message}`;
                    await ChatService.sendMessage(chat.id, senderId, { content, messageType: 'text' });
                    deliveredToChat = true;
                    chatId = chat.id;
                }
            }
        } catch (deliveryError) {
            // Non-fatal — the submission is already safely stored above.
            console.error('[Contact] Chat delivery to admin failed (message still saved):', deliveryError.message);
        }

        if (deliveredToChat) {
            await record.update({ deliveredToChat: true, chatId });
        }

        return res.status(201).json({
            success: true,
            message: "Your message has been sent. We'll reply within 24 hours.",
            data: { id: record.id, deliveredToChat },
        });
    } catch (error) {
        console.error('[Contact] submit error:', error.message, error.stack);
        return res.status(500).json({ success: false, message: 'Failed to send your message. Please try again.' });
    }
});

// ── GET /api/contact/inbox — admin views all submissions ────────────────────
router.get('/inbox', authenticateToken, adminOnly, async (req, res) => {
    try {
        const db = getModels();
        if (!db || !db.models || !db.models.ContactMessage) {
            return res.status(503).json({ success: false, message: 'Contact system is not available right now.' });
        }
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));

        const { count, rows } = await db.models.ContactMessage.findAndCountAll({
            order: [['createdAt', 'DESC']],
            limit,
            offset: (page - 1) * limit,
        });

        return res.status(200).json({
            success: true,
            data: { messages: rows, total: count, page, totalPages: Math.ceil(count / limit) },
        });
    } catch (error) {
        console.error('[Contact] inbox error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to load contact messages.' });
    }
});

// ── POST /api/contact/:id/read — admin marks a submission as read ───────────
router.post('/:id/read', authenticateToken, adminOnly, async (req, res) => {
    try {
        const db = getModels();
        if (!db || !db.models || !db.models.ContactMessage) {
            return res.status(503).json({ success: false, message: 'Contact system is not available right now.' });
        }
        const record = await db.models.ContactMessage.findByPk(req.params.id);
        if (!record) return res.status(404).json({ success: false, message: 'Message not found.' });
        await record.update({ status: 'read' });
        return res.status(200).json({ success: true, data: record });
    } catch (error) {
        console.error('[Contact] mark-read error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update message.' });
    }
});

module.exports = router;
