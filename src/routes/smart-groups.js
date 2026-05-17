/**
 * smart-groups.js — REST API Routes for Smart Group OS
 * Mount in server: app.use('/api/groups', require('./routes/smart-groups'))
 * All routes are additive — existing /api/groups routes are unchanged
 */
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { TaskService, EventService, PollService, NoteService, FileService, FinanceService, AnalyticsService, AIService, ModuleService } = require('../services/smartGroupService');

// ── Auth middleware (reuse existing) ──────────────────────────────────────
function auth(req, res, next) {
  try {
    const authMw = require('./auth').__authMiddleware || require('../middleware/auth');
    return authMw(req, res, next);
  } catch(_) {
    // Fallback: check for userId in token
    const tok = req.headers.authorization?.replace('Bearer ','');
    if (!tok) return res.status(401).json({ success:false, message:'Unauthorized' });
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(tok, process.env.JWT_SECRET || 'secret');
      req.user = decoded; next();
    } catch(e) { return res.status(401).json({ success:false, message:'Invalid token' }); }
  }
}
function uid(req) { return req.user?.id || req.user?.userId || req.userId; }
function gid(req) { return parseInt(req.params.groupId); }
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(err => {
  res.status(err.status||500).json({ success:false, message: err.message||'Server error' });
});

// ── MODULES ───────────────────────────────────────────────────────────────
router.get ('/:groupId/modules',    auth, wrap(async(req,res) => res.json({ success:true, data: await ModuleService.getEnabled(gid(req)) })));
router.put ('/:groupId/modules',    auth, wrap(async(req,res) => res.json({ success:true, data: await ModuleService.setEnabled(gid(req), uid(req), req.body.modules) })));

// ── TASKS ─────────────────────────────────────────────────────────────────
router.get ('/:groupId/tasks',             auth, wrap(async(req,res) => res.json({ success:true, data: await TaskService.list(gid(req), uid(req), req.query) })));
router.post('/:groupId/tasks',             auth, wrap(async(req,res) => res.status(201).json({ success:true, data: await TaskService.create(gid(req), uid(req), req.body) })));
router.put ('/:groupId/tasks/:taskId',     auth, wrap(async(req,res) => res.json({ success:true, data: await TaskService.update(gid(req), uid(req), req.params.taskId, req.body) })));
router.delete('/:groupId/tasks/:taskId',  auth, wrap(async(req,res) => res.json({ success:true, data: await TaskService.delete(gid(req), uid(req), req.params.taskId) })));

// ── EVENTS ────────────────────────────────────────────────────────────────
router.get ('/:groupId/smart-events',            auth, wrap(async(req,res) => res.json({ success:true, data: await EventService.list(gid(req), uid(req), req.query) })));
router.post('/:groupId/smart-events',            auth, wrap(async(req,res) => res.status(201).json({ success:true, data: await EventService.create(gid(req), uid(req), req.body) })));
router.post('/:groupId/smart-events/:eventId/rsvp',      auth, wrap(async(req,res) => res.json({ success:true, data: await EventService.rsvp(gid(req), uid(req), req.params.eventId, req.body.status) })));
router.post('/:groupId/smart-events/:eventId/attendance', auth, wrap(async(req,res) => res.json({ success:true, data: await EventService.markAttendance(gid(req), uid(req), req.params.eventId, req.body.userId, req.body.status, req.body) })));
router.get ('/:groupId/smart-events/:eventId/stats',     auth, wrap(async(req,res) => res.json({ success:true, data: await EventService.getStats(gid(req), uid(req), req.params.eventId) })));

// ── POLLS ─────────────────────────────────────────────────────────────────
router.get ('/:groupId/polls',             auth, wrap(async(req,res) => res.json({ success:true, data: await PollService.list(gid(req), uid(req), req.query) })));
router.post('/:groupId/polls',             auth, wrap(async(req,res) => res.status(201).json({ success:true, data: await PollService.create(gid(req), uid(req), req.body) })));
router.post('/:groupId/polls/:pollId/vote', auth, wrap(async(req,res) => res.json({ success:true, data: await PollService.vote(gid(req), uid(req), req.params.pollId, req.body.optionIds) })));
router.post('/:groupId/polls/:pollId/close', auth, wrap(async(req,res) => res.json({ success:true, data: await PollService.close(gid(req), uid(req), req.params.pollId) })));

// ── NOTES ─────────────────────────────────────────────────────────────────
router.get ('/:groupId/notes',             auth, wrap(async(req,res) => res.json({ success:true, data: await NoteService.list(gid(req), uid(req), req.query) })));
router.post('/:groupId/notes',             auth, wrap(async(req,res) => res.status(201).json({ success:true, data: await NoteService.create(gid(req), uid(req), req.body) })));
router.put ('/:groupId/notes/:noteId',     auth, wrap(async(req,res) => res.json({ success:true, data: await NoteService.update(gid(req), uid(req), req.params.noteId, req.body) })));
router.delete('/:groupId/notes/:noteId',  auth, wrap(async(req,res) => res.json({ success:true, data: await NoteService.delete(gid(req), uid(req), req.params.noteId) })));

// ── FILES ─────────────────────────────────────────────────────────────────
router.get ('/:groupId/group-files',             auth, wrap(async(req,res) => res.json({ success:true, data: await FileService.list(gid(req), uid(req), req.query) })));
router.post('/:groupId/group-files',             auth, wrap(async(req,res) => res.status(201).json({ success:true, data: await FileService.create(gid(req), uid(req), req.body) })));
router.delete('/:groupId/group-files/:fileId',  auth, wrap(async(req,res) => res.json({ success:true, data: await FileService.delete(gid(req), uid(req), req.params.fileId) })));

// ── FINANCES ──────────────────────────────────────────────────────────────
router.get ('/:groupId/finances',             auth, wrap(async(req,res) => res.json({ success:true, data: await FinanceService.list(gid(req), uid(req), req.query) })));
router.post('/:groupId/finances',             auth, wrap(async(req,res) => res.status(201).json({ success:true, data: await FinanceService.create(gid(req), uid(req), req.body) })));
router.post('/:groupId/finances/:txId/approve', auth, wrap(async(req,res) => res.json({ success:true, data: await FinanceService.approve(gid(req), uid(req), req.params.txId) })));

// ── ANALYTICS ─────────────────────────────────────────────────────────────
router.get('/:groupId/analytics', auth, wrap(async(req,res) => res.json({ success:true, data: await AnalyticsService.getDashboard(gid(req), uid(req), parseInt(req.query.days)||30) })));

// ── AI SUMMARIES ──────────────────────────────────────────────────────────
router.get ('/:groupId/ai/summary',       auth, wrap(async(req,res) => res.json({ success:true, data: await AIService.getLatest(gid(req), uid(req), req.query.type||'daily') })));
router.post('/:groupId/ai/summary',       auth, wrap(async(req,res) => res.json({ success:true, data: await AIService.queueSummary(gid(req), req.body.type||'daily') })));

module.exports = router;
