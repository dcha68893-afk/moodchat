/**
 * smart-groups.js — REST API Routes for Smart Group OS (FIXED - robust auth)
 */
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });

// ── SAFE auth middleware ──────────────────────────────────────────────────
function auth(req, res, next) {
    // Try multiple auth middleware paths used in this project
    const paths = [
        '../middleware/auth',
        '../middleware/authenticate', 
        '../middleware/authMiddleware',
        './auth'
    ];
    for (const p of paths) {
        try {
            const mw = require(p);
            const fn = mw.authenticateToken || mw.authenticate || mw.auth || (typeof mw === 'function' ? mw : null);
            if (fn) return fn(req, res, next);
        } catch(_) {}
    }
    // JWT fallback
    try {
        const jwt = require('jsonwebtoken');
        const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
        if (!tok) return res.status(401).json({ success:false, message:'No token' });
        const secret = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'secret';
        const decoded = jwt.verify(tok, secret);
        req.user = decoded;
        next();
    } catch(e) { 
        return res.status(401).json({ success:false, message:'Invalid token' }); 
    }
}

function uid(req) { 
    return req.user?.id || req.user?.userId || req.user?.sub || req.userId; 
}
function gid(req) { 
    return parseInt(req.params.groupId, 10); 
}

const wrap = fn => (req,res,next) => {
    Promise.resolve(fn(req,res,next)).catch(err => {
        console.error('[SmartGroups] Route error:', err.message);
        res.status(err.status||500).json({ success:false, message: err.message||'Server error' });
    });
};

// Lazy-load service to prevent startup crash if models aren't ready
function _svc() {
    try { return require('../services/smartGroupService'); } 
    catch(e) { 
        console.warn('[SmartGroups] Service unavailable:', e.message);
        return null; 
    }
}

function _handler(serviceFn) {
    return wrap(async (req, res) => {
        const svc = _svc();
        if (!svc) return res.status(503).json({ success:false, message:'Smart Group service unavailable - run migration first' });
        const result = await serviceFn(svc, req);
        res.json({ success:true, data: result });
    });
}

// ── MODULES ───────────────────────────────────────────────────────────────
router.get('/:groupId/modules', auth, _handler((svc,req) => svc.ModuleService.getEnabled(gid(req))));
router.put('/:groupId/modules', auth, _handler((svc,req) => svc.ModuleService.setEnabled(gid(req), uid(req), req.body.modules)));

// ── TASKS ─────────────────────────────────────────────────────────────────
router.get('/:groupId/tasks',              auth, _handler((svc,req) => svc.TaskService.list(gid(req), uid(req), req.query)));
router.post('/:groupId/tasks',             auth, wrap(async(req,res) => { const svc=_svc(); if(!svc) return res.status(503).json({success:false,message:'Service unavailable'}); const r=await svc.TaskService.create(gid(req),uid(req),req.body); res.status(201).json({success:true,data:r}); }));
router.put('/:groupId/tasks/:taskId',      auth, _handler((svc,req) => svc.TaskService.update(gid(req), uid(req), req.params.taskId, req.body)));
router.delete('/:groupId/tasks/:taskId',   auth, _handler((svc,req) => svc.TaskService.delete(gid(req), uid(req), req.params.taskId)));

// ── EVENTS ────────────────────────────────────────────────────────────────
router.get('/:groupId/smart-events',                  auth, _handler((svc,req) => svc.EventService.list(gid(req), uid(req), req.query)));
router.post('/:groupId/smart-events',                 auth, wrap(async(req,res) => { const svc=_svc(); if(!svc) return res.status(503).json({success:false,message:'Service unavailable'}); const r=await svc.EventService.create(gid(req),uid(req),req.body); res.status(201).json({success:true,data:r}); }));
router.post('/:groupId/smart-events/:eventId/rsvp',           auth, _handler((svc,req) => svc.EventService.rsvp(gid(req), uid(req), req.params.eventId, req.body.status)));
router.post('/:groupId/smart-events/:eventId/attendance',     auth, _handler((svc,req) => svc.EventService.markAttendance(gid(req), uid(req), req.params.eventId, req.body.userId, req.body.status, req.body)));
router.get('/:groupId/smart-events/:eventId/stats',           auth, _handler((svc,req) => svc.EventService.getStats(gid(req), uid(req), req.params.eventId)));

// ── POLLS ─────────────────────────────────────────────────────────────────
router.get('/:groupId/polls',               auth, _handler((svc,req) => svc.PollService.list(gid(req), uid(req), req.query)));
router.post('/:groupId/polls',              auth, wrap(async(req,res) => { const svc=_svc(); if(!svc) return res.status(503).json({success:false,message:'Service unavailable'}); const r=await svc.PollService.create(gid(req),uid(req),req.body); res.status(201).json({success:true,data:r}); }));
router.post('/:groupId/polls/:pollId/vote', auth, _handler((svc,req) => svc.PollService.vote(gid(req), uid(req), req.params.pollId, req.body.optionIds)));
router.post('/:groupId/polls/:pollId/close',auth, _handler((svc,req) => svc.PollService.close(gid(req), uid(req), req.params.pollId)));

// ── NOTES ─────────────────────────────────────────────────────────────────
router.get('/:groupId/notes',              auth, _handler((svc,req) => svc.NoteService.list(gid(req), uid(req), req.query)));
router.post('/:groupId/notes',             auth, wrap(async(req,res) => { const svc=_svc(); if(!svc) return res.status(503).json({success:false,message:'Service unavailable'}); const r=await svc.NoteService.create(gid(req),uid(req),req.body); res.status(201).json({success:true,data:r}); }));
router.put('/:groupId/notes/:noteId',      auth, _handler((svc,req) => svc.NoteService.update(gid(req), uid(req), req.params.noteId, req.body)));
router.delete('/:groupId/notes/:noteId',   auth, _handler((svc,req) => svc.NoteService.delete(gid(req), uid(req), req.params.noteId)));

// ── FILES ─────────────────────────────────────────────────────────────────
router.get('/:groupId/group-files',              auth, _handler((svc,req) => svc.FileService.list(gid(req), uid(req), req.query)));
router.post('/:groupId/group-files',             auth, wrap(async(req,res) => { const svc=_svc(); if(!svc) return res.status(503).json({success:false,message:'Service unavailable'}); const r=await svc.FileService.create(gid(req),uid(req),req.body); res.status(201).json({success:true,data:r}); }));
router.delete('/:groupId/group-files/:fileId',   auth, _handler((svc,req) => svc.FileService.delete(gid(req), uid(req), req.params.fileId)));

// ── FINANCES ──────────────────────────────────────────────────────────────
router.get('/:groupId/finances',               auth, _handler((svc,req) => svc.FinanceService.list(gid(req), uid(req), req.query)));
router.post('/:groupId/finances',              auth, wrap(async(req,res) => { const svc=_svc(); if(!svc) return res.status(503).json({success:false,message:'Service unavailable'}); const r=await svc.FinanceService.create(gid(req),uid(req),req.body); res.status(201).json({success:true,data:r}); }));
router.post('/:groupId/finances/:txId/approve',auth, _handler((svc,req) => svc.FinanceService.approve(gid(req), uid(req), req.params.txId)));

// ── ANALYTICS ─────────────────────────────────────────────────────────────
router.get('/:groupId/analytics', auth, _handler((svc,req) => svc.AnalyticsService.getDashboard(gid(req), uid(req), parseInt(req.query.days)||30)));

// ── AI SUMMARIES ──────────────────────────────────────────────────────────
router.get('/:groupId/ai/summary',  auth, _handler((svc,req) => svc.AIService.getLatest(gid(req), uid(req), req.query.type||'daily')));
router.post('/:groupId/ai/summary', auth, _handler((svc,req) => svc.AIService.queueSummary(gid(req), req.body.type||'daily')));

module.exports = router;
