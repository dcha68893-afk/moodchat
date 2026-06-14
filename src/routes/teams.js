'use strict';
/**
 * teams.js — Teams / workspace member management routes
 * Mapped from api.core.js calls to /api/teams/*
 * Teams in MoodChat are Groups with type='team'
 */
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter }    = require('../middleware/rateLimiter');

const uid  = req => req.user?.id || req.user?.userId;
const ok   = (res, data) => res.json({ success: true, data });

// GET /api/teams/members  or  GET /api/teams/:teamId/members
router.get('/:teamId?/members', authenticateToken, apiRateLimiter, async (req, res) => {
    try {
        const db      = req.app.locals.models;
        const GroupM  = db?.GroupMembers || db?.GroupMember;
        const { teamId } = req.params;
        if (!GroupM || !teamId) return ok(res, []);
        const members = await GroupM.findAll({ where: { groupId: teamId } }).catch(() => []);
        return ok(res, members);
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/teams/invite
router.post('/invite', authenticateToken, apiRateLimiter, async (req, res) => {
    try {
        const { email, role = 'member', teamId } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'email required' });
        // Basic invite stub — wire up email service when ready
        return ok(res, { invited: email, role, teamId, status: 'pending' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// PUT /api/teams/:teamId/members/:memberId/role
router.put('/:teamId/members/:memberId/role', authenticateToken, apiRateLimiter, async (req, res) => {
    try {
        const { role }  = req.body;
        const { teamId, memberId } = req.params;
        const db    = req.app.locals.models;
        const GroupM = db?.GroupMembers || db?.GroupMember;
        if (!GroupM) return res.status(503).json({ success: false, message: 'Model unavailable' });
        await GroupM.update({ role }, { where: { groupId: teamId, userId: memberId } });
        return ok(res, { teamId, memberId, role });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
