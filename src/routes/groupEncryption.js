/**
 * groupEncryption.js — Group (Sender Keys) encryption key distribution
 *
 * Implements the server side of the Sender Keys group-encryption model:
 * the server only ever stores/relays Sender Key material that has ALREADY
 * been encrypted client-side (via the existing 1:1 ECDH channel between
 * each pair of members) — it never sees a plaintext Sender Key, the same
 * property as message content itself.
 *
 * POST   /api/group-encryption/:groupId/distribute
 *          Called once per OTHER current member by whoever generated/
 *          rotated a Sender Key — body carries one encrypted copy per
 *          recipient (an array), each already encrypted for that specific
 *          recipient using the caller's existing 1:1 ECDH channel with them.
 *
 * GET    /api/group-encryption/:groupId/keys
 *          Returns every active Sender Key distribution addressed TO the
 *          requesting user in this group — i.e. everything they need to
 *          be able to decrypt every other member's messages. Each entry
 *          still requires the requester to decrypt it client-side using
 *          their own private key + the owner's public key.
 *
 * GET    /api/group-encryption/:groupId/my-generation
 *          Returns the requester's own current Sender Key generation
 *          number for this group (or 0 if they've never distributed one),
 *          so a client can tell whether it needs to generate+distribute a
 *          fresh key before sending (e.g. after being newly added to a
 *          pre-existing group).
 *
 * POST   /api/group-encryption/:groupId/rotate-notify
 *          Marks all of the CALLER's previous-generation distribution rows
 *          inactive. Called by a client immediately after it has finished
 *          distributing a freshly-rotated key to every current member, so
 *          old (now-superseded) rows stop being served to anyone querying
 *          GET /keys. Membership-change rotation (remove/ban/leave) is
 *          triggered server-side (see groupMembersService.js), but the
 *          actual NEW key generation + distribution always happens
 *          client-side — the server cannot generate a Sender Key for a
 *          member it doesn't have the private key for.
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('express-async-handler');

function getDb() { return require('../models/index'); }

// Shared membership check: is `userId` a current (isActive) member of `groupId`?
async function assertActiveMember(groupId, userId) {
    const db = getDb();
    const GroupMembers = db.models?.GroupMembers;
    if (!GroupMembers) throw new Error('GroupMembers model unavailable');
    const membership = await GroupMembers.findOne({
        where: { groupId, userId, isActive: true },
    });
    return !!membership;
}

// ── POST /api/group-encryption/:groupId/distribute ─────────────────────────
router.post('/:groupId/distribute', asyncHandler(async (req, res) => {
    const groupId = parseInt(req.params.groupId, 10);
    const ownerUserId = req.user.id;
    const { keyGeneration, distributions } = req.body;
    // distributions: [{ recipientUserId, encryptedSenderKey }, ...]

    if (!groupId || !Array.isArray(distributions) || distributions.length === 0) {
        return res.status(400).json({ success: false, message: 'groupId and distributions[] are required' });
    }
    if (!keyGeneration || keyGeneration < 1) {
        return res.status(400).json({ success: false, message: 'keyGeneration must be a positive integer' });
    }

    const isMember = await assertActiveMember(groupId, ownerUserId);
    if (!isMember) {
        return res.status(403).json({ success: false, message: 'You are not an active member of this group' });
    }

    const db = getDb();
    const sequelize = db.sequelize;
    const GroupSenderKeyDistribution = db.models?.GroupSenderKeyDistribution;
    if (!GroupSenderKeyDistribution) {
        return res.status(500).json({ success: false, message: 'GroupSenderKeyDistribution model unavailable' });
    }

    // FIX-SAFETY: cap to a sane batch size — a malicious/buggy client
    // shouldn't be able to force unbounded row inserts in one request.
    if (distributions.length > 500) {
        return res.status(400).json({ success: false, message: 'Too many distributions in one request (max 500)' });
    }

    const rows = distributions
        .filter(d => d && d.recipientUserId && d.encryptedSenderKey)
        .map(d => ({
            groupId,
            ownerUserId,
            recipientUserId: d.recipientUserId,
            keyGeneration,
            encryptedSenderKey: typeof d.encryptedSenderKey === 'string'
                ? d.encryptedSenderKey
                : JSON.stringify(d.encryptedSenderKey),
            isActive: true,
        }));

    if (rows.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid distribution entries provided' });
    }

    await sequelize.transaction(async (t) => {
        await GroupSenderKeyDistribution.bulkCreate(rows, {
            updateOnDuplicate: ['encryptedSenderKey', 'isActive', 'updatedAt'],
            transaction: t,
        });
    });

    // Notify currently-online recipients in real time so active group chats
    // pick up the new key without needing a manual refresh.
    try {
        const io = req.io || global.__socketIO;
        if (io) {
            for (const d of distributions) {
                if (!d.recipientUserId) continue;
                io.to(`user:${d.recipientUserId}`).emit('group:sender_key_distributed', {
                    groupId, ownerUserId, keyGeneration, timestamp: Date.now(),
                });
                io.to(`user_${d.recipientUserId}`).emit('group:sender_key_distributed', {
                    groupId, ownerUserId, keyGeneration, timestamp: Date.now(),
                });
            }
        }
    } catch (_) { /* real-time notify is best-effort; distribution itself already succeeded */ }

    return res.status(201).json({
        success: true,
        message: `Distributed sender key generation ${keyGeneration} to ${rows.length} member(s)`,
        data: { groupId, keyGeneration, distributedCount: rows.length },
    });
}));

// ── GET /api/group-encryption/:groupId/keys ─────────────────────────────────
router.get('/:groupId/keys', asyncHandler(async (req, res) => {
    const groupId = parseInt(req.params.groupId, 10);
    const recipientUserId = req.user.id;

    const isMember = await assertActiveMember(groupId, recipientUserId);
    if (!isMember) {
        return res.status(403).json({ success: false, message: 'You are not an active member of this group' });
    }

    const db = getDb();
    const GroupSenderKeyDistribution = db.models?.GroupSenderKeyDistribution;
    if (!GroupSenderKeyDistribution) {
        return res.status(500).json({ success: false, message: 'GroupSenderKeyDistribution model unavailable' });
    }

    const rows = await GroupSenderKeyDistribution.findAll({
        where: { groupId, recipientUserId, isActive: true },
        order: [['ownerUserId', 'ASC'], ['keyGeneration', 'DESC']],
    });

    // One active row per (ownerUserId) is what a client actually needs —
    // dedupe to the highest keyGeneration per owner in case of any overlap.
    const latestPerOwner = new Map();
    for (const r of rows) {
        if (!latestPerOwner.has(r.ownerUserId)) {
            latestPerOwner.set(r.ownerUserId, r);
        }
    }

    return res.status(200).json({
        success: true,
        data: {
            groupId,
            keys: Array.from(latestPerOwner.values()).map(r => ({
                ownerUserId: r.ownerUserId,
                keyGeneration: r.keyGeneration,
                encryptedSenderKey: r.encryptedSenderKey,
            })),
        },
    });
}));

// ── GET /api/group-encryption/:groupId/my-generation ────────────────────────
router.get('/:groupId/my-generation', asyncHandler(async (req, res) => {
    const groupId = parseInt(req.params.groupId, 10);
    const ownerUserId = req.user.id;

    const db = getDb();
    const GroupSenderKeyDistribution = db.models?.GroupSenderKeyDistribution;
    if (!GroupSenderKeyDistribution) {
        return res.status(500).json({ success: false, message: 'GroupSenderKeyDistribution model unavailable' });
    }

    const latest = await GroupSenderKeyDistribution.findOne({
        where: { groupId, ownerUserId, isActive: true },
        order: [['keyGeneration', 'DESC']],
    });

    return res.status(200).json({
        success: true,
        data: { groupId, currentGeneration: latest ? latest.keyGeneration : 0 },
    });
}));

// ── POST /api/group-encryption/:groupId/rotate-notify ───────────────────────
router.post('/:groupId/rotate-notify', asyncHandler(async (req, res) => {
    const groupId = parseInt(req.params.groupId, 10);
    const ownerUserId = req.user.id;
    const { keyGeneration } = req.body;

    if (!keyGeneration || keyGeneration < 1) {
        return res.status(400).json({ success: false, message: 'keyGeneration is required' });
    }

    const db = getDb();
    const sequelize = db.sequelize;
    const { Op } = require('sequelize');
    const GroupSenderKeyDistribution = db.models?.GroupSenderKeyDistribution;
    if (!GroupSenderKeyDistribution) {
        return res.status(500).json({ success: false, message: 'GroupSenderKeyDistribution model unavailable' });
    }

    const [updatedCount] = await GroupSenderKeyDistribution.update(
        { isActive: false },
        {
            where: {
                groupId, ownerUserId,
                keyGeneration: { [Op.lt]: keyGeneration },
                isActive: true,
            },
        }
    );

    return res.status(200).json({
        success: true,
        message: `Deactivated ${updatedCount} superseded distribution row(s)`,
        data: { groupId, keyGeneration, deactivatedCount: updatedCount },
    });
}));

module.exports = router;
