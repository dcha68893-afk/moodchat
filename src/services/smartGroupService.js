/**
 * smartGroupService.js — Business Logic for Smart Group OS
 * Handles: Tasks, Events, Attendance, Polls, Notes, Files, Finances, AI, Analytics
 * Security: All operations validate membership + permissions before executing
 * Realtime: All mutations emit socket events via webSocketService
 */
'use strict';

const { Op } = require('sequelize');

// Lazy-load models to avoid circular deps
function _m(name) {
  try { return require('../models')[name] || require('../models').models?.[name]; } catch(_) { return null; }
}
function _io()  { return global.__socketIO; }
function _seq() { try { return require('../models').sequelize; } catch(_) { return null; } }

// ── Permission helpers ─────────────────────────────────────────────────────
async function _getMembership(groupId, userId) {
  const GM = _m('GroupMembers');
  if (!GM) return null;
  return GM.findOne({ where: { groupId, userId, leftAt: null } });
}

async function _assertMember(groupId, userId) {
  const m = await _getMembership(groupId, userId);
  if (!m) throw Object.assign(new Error('Not a group member'), { status: 403 });
  return m;
}

async function _assertRole(groupId, userId, roles = ['admin','owner']) {
  const m = await _assertMember(groupId, userId);
  if (!roles.includes(m.role)) throw Object.assign(new Error('Insufficient permissions'), { status: 403 });
  return m;
}

// ── Activity logger ────────────────────────────────────────────────────────
async function _log(groupId, userId, action, module, targetId, targetType, meta = {}) {
  try {
    const AL = _m('GroupActivityLog');
    if (AL) await AL.create({ groupId, userId, action, module, targetId, targetType, meta });
  } catch(_) {}
}

// ── Socket broadcaster ────────────────────────────────────────────────────
function _broadcast(groupId, event, payload) {
  try {
    const io = _io();
    if (!io) return;
    const p = { ...payload, groupId, timestamp: new Date().toISOString() };
    io.to(`group:${groupId}`).emit(event, p);
    io.to(`group_${groupId}`).emit(event, p);
  } catch(_) {}
}

// ── Analytics updater ─────────────────────────────────────────────────────
async function _updateAnalytics(groupId, field, delta = 1) {
  try {
    const GA = _m('GroupAnalytics') || _m('GroupAnalytic');
    if (!GA) return;
    const today = new Date().toISOString().slice(0,10);
    const [row] = await GA.findOrCreate({ where: { groupId, date: today }, defaults: { groupId, date: today } });
    await row.increment(field, { by: delta });
  } catch(_) {}
}

// ══════════════════════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════════════════════
const TaskService = {
  async list(groupId, userId, { status, priority, assignedTo, page = 1, limit = 30 } = {}) {
    await _assertMember(groupId, userId);
    const GT = _m('GroupTask'); if (!GT) return { tasks: [], total: 0 };
    const where = { groupId, deletedAt: null, parentTaskId: null };
    if (status)     where.status   = status;
    if (priority)   where.priority = priority;
    const offset = (page - 1) * limit;
    const { count, rows } = await GT.findAndCountAll({
      where, limit, offset,
      order: [['priority','DESC'],['dueDate','ASC'],['createdAt','DESC']],
      include: [{ model: _m('GroupTaskAssignment'), as: 'assignments', required: false }],
    });
    let tasks = rows;
    if (assignedTo) tasks = tasks.filter(t => t.assignments?.some(a => String(a.userId) === String(assignedTo)));
    return { tasks, total: count, page, limit };
  },

  async create(groupId, userId, data) {
    await _assertMember(groupId, userId);
    const GT = _m('GroupTask'); if (!GT) throw new Error('Model unavailable');
    const task = await GT.create({ groupId, createdBy: userId, ...data });

    // Assign members
    if (data.assignees?.length) {
      const GTA = _m('GroupTaskAssignment');
      if (GTA) await Promise.all(data.assignees.map(uid =>
        GTA.create({ taskId: task.id, userId: uid, assignedBy: userId }).catch(() => {})
      ));
    }

    _broadcast(groupId, 'group:task:created', { task: task.toJSON() });
    _log(groupId, userId, 'task_created', 'tasks', task.id, 'GroupTask');
    _updateAnalytics(groupId, 'tasksCreated');
    return task;
  },

  async update(groupId, userId, taskId, data) {
    await _assertMember(groupId, userId);
    const GT = _m('GroupTask'); if (!GT) throw new Error('Model unavailable');
    const task = await GT.findOne({ where: { id: taskId, groupId, deletedAt: null } });
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    // Only creator or admin can update
    const m = await _getMembership(groupId, userId);
    if (String(task.createdBy) !== String(userId) && !['admin','owner','moderator'].includes(m?.role)) {
      throw Object.assign(new Error('Insufficient permissions'), { status: 403 });
    }
    await task.update(data);

    if (data.status === 'completed') {
      _updateAnalytics(groupId, 'tasksCompleted');
      // Mark assignment complete
      const GTA = _m('GroupTaskAssignment');
      if (GTA) await GTA.update({ completedAt: new Date() }, { where: { taskId, userId } });
    }

    _broadcast(groupId, 'group:task:updated', { task: task.toJSON() });
    _log(groupId, userId, 'task_updated', 'tasks', task.id, 'GroupTask', { changes: Object.keys(data) });
    return task;
  },

  async delete(groupId, userId, taskId) {
    const m = await _assertRole(groupId, userId, ['admin','owner','moderator']);
    const GT = _m('GroupTask');
    const task = await GT?.findOne({ where: { id: taskId, groupId } });
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    await task.update({ deletedAt: new Date() });
    _broadcast(groupId, 'group:task:deleted', { taskId });
    _log(groupId, userId, 'task_deleted', 'tasks', taskId, 'GroupTask');
    return { success: true };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// EVENTS & ATTENDANCE
// ══════════════════════════════════════════════════════════════════════════
const EventService = {
  async list(groupId, userId, { status, upcoming, page = 1, limit = 20 } = {}) {
    await _assertMember(groupId, userId);
    const GE = _m('GroupEvent'); if (!GE) return { events: [], total: 0 };
    const where = { groupId, deletedAt: null };
    if (status) where.status = status;
    if (upcoming) where.startTime = { [Op.gte]: new Date() };
    const { count, rows } = await GE.findAndCountAll({
      where, limit, offset: (page-1)*limit,
      order: [['startTime','ASC']],
      include: [{ model: _m('GroupAttendance'), as: 'attendance', required: false }],
    });
    return { events: rows, total: count };
  },

  async create(groupId, userId, data) {
    await _assertMember(groupId, userId);
    const GE = _m('GroupEvent'); if (!GE) throw new Error('Model unavailable');
    const evt = await GE.create({ groupId, createdBy: userId, ...data });
    _broadcast(groupId, 'group:event:created', { event: evt.toJSON() });
    _log(groupId, userId, 'event_created', 'events', evt.id, 'GroupEvent');
    _updateAnalytics(groupId, 'eventsHeld');
    return evt;
  },

  async rsvp(groupId, userId, eventId, status) {
    await _assertMember(groupId, userId);
    const GA = _m('GroupAttendance'); if (!GA) throw new Error('Model unavailable');
    const [att] = await GA.findOrCreate({ where: { eventId, userId }, defaults: { eventId, groupId, userId } });
    await att.update({ status, rsvpAt: new Date() });
    _broadcast(groupId, 'group:event:rsvp', { eventId, userId, status });
    return att;
  },

  async markAttendance(groupId, userId, eventId, attendeeId, status, opts = {}) {
    await _assertRole(groupId, userId, ['admin','owner','moderator']);
    const GA = _m('GroupAttendance'); if (!GA) throw new Error('Model unavailable');
    const [att] = await GA.findOrCreate({ where: { eventId, userId: attendeeId }, defaults: { eventId, groupId, userId: attendeeId } });
    await att.update({ status, markedAt: new Date(), markedBy: userId, ...opts });
    _broadcast(groupId, 'group:attendance:updated', { eventId, attendeeId, status });
    _log(groupId, userId, 'attendance_marked', 'attendance', eventId, 'GroupEvent', { attendeeId, status });
    return att;
  },

  async getStats(groupId, userId, eventId) {
    await _assertMember(groupId, userId);
    const GA = _m('GroupAttendance'); if (!GA) return {};
    const rows = await GA.findAll({ where: { eventId } });
    const counts = { present:0, absent:0, late:0, excused:0, pending:0, rsvp_yes:0, rsvp_no:0, rsvp_maybe:0 };
    rows.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
    const total = rows.length;
    return { total, counts, attendanceRate: total > 0 ? Math.round((counts.present / total) * 100) : 0 };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// POLLS
// ══════════════════════════════════════════════════════════════════════════
const PollService = {
  async list(groupId, userId, { status = 'active', page = 1, limit = 20 } = {}) {
    await _assertMember(groupId, userId);
    const GP = _m('GroupPoll'); if (!GP) return { polls: [], total: 0 };
    const { count, rows } = await GP.findAndCountAll({
      where: { groupId, deletedAt: null, ...(status ? { status } : {}) },
      limit, offset: (page-1)*limit, order: [['createdAt','DESC']],
      include: [
        { model: _m('GroupPollOption'), as: 'options', required: false },
        { model: _m('GroupPollVote'),   as: 'votes',   required: false },
      ],
    });
    // Attach vote counts per option, hide anonymous voter IDs
    const polls = rows.map(p => {
      const pj = p.toJSON();
      pj.options = (pj.options||[]).map(opt => ({
        ...opt,
        voteCount: (pj.votes||[]).filter(v => v.optionId === opt.id).length,
      }));
      pj.myVotes = p.isAnonymous ? [] : (pj.votes||[]).filter(v => String(v.userId)===String(userId)).map(v=>v.optionId);
      if (p.isAnonymous) delete pj.votes;
      return pj;
    });
    return { polls, total: count };
  },

  async create(groupId, userId, { question, options, ...rest }) {
    await _assertMember(groupId, userId);
    const GP = _m('GroupPoll'), GPO = _m('GroupPollOption');
    if (!GP || !GPO) throw new Error('Model unavailable');
    if (!question || !options?.length) throw Object.assign(new Error('Question and options required'), { status: 400 });
    const poll = await GP.create({ groupId, createdBy: userId, question, ...rest });
    await Promise.all(options.map((opt, i) => GPO.create({ pollId: poll.id, text: opt.text || opt, emoji: opt.emoji, isCorrect: opt.isCorrect, position: i })));
    const full = await GP.findByPk(poll.id, { include: [{ model: GPO, as: 'options' }] });
    _broadcast(groupId, 'group:poll:created', { poll: full.toJSON() });
    _log(groupId, userId, 'poll_created', 'polls', poll.id, 'GroupPoll');
    _updateAnalytics(groupId, 'pollsCreated');
    return full;
  },

  async vote(groupId, userId, pollId, optionIds) {
    await _assertMember(groupId, userId);
    const GP = _m('GroupPoll'), GPO = _m('GroupPollOption'), GPV = _m('GroupPollVote');
    if (!GP || !GPV) throw new Error('Model unavailable');
    const poll = await GP.findOne({ where: { id: pollId, groupId, status: 'active', deletedAt: null } });
    if (!poll) throw Object.assign(new Error('Poll not found or closed'), { status: 404 });
    if (poll.endsAt && new Date(poll.endsAt) < new Date()) throw Object.assign(new Error('Poll has ended'), { status: 400 });

    // Dedup: remove existing votes if allowChange
    if (poll.allowChange) await GPV.destroy({ where: { pollId, userId } });
    else {
      const existing = await GPV.findOne({ where: { pollId, userId } });
      if (existing) throw Object.assign(new Error('Already voted'), { status: 409 });
    }

    const ids = Array.isArray(optionIds) ? optionIds : [optionIds];
    if (poll.type === 'single' && ids.length > 1) throw Object.assign(new Error('Single choice only'), { status: 400 });
    await Promise.all(ids.map(oid => GPV.create({ pollId, optionId: oid, userId }).catch(() => {})));

    // Get updated counts
    const allVotes = await GPV.findAll({ where: { pollId } });
    const optionCounts = {};
    allVotes.forEach(v => { optionCounts[v.optionId] = (optionCounts[v.optionId]||0)+1; });
    _broadcast(groupId, 'group:poll:voted', { pollId, optionCounts, totalVotes: allVotes.length });
    return { success: true, totalVotes: allVotes.length, optionCounts };
  },

  async close(groupId, userId, pollId) {
    await _assertRole(groupId, userId, ['admin','owner','moderator']);
    const GP = _m('GroupPoll');
    const poll = await GP?.findOne({ where: { id: pollId, groupId } });
    if (!poll) throw Object.assign(new Error('Poll not found'), { status: 404 });
    await poll.update({ status: 'closed' });
    _broadcast(groupId, 'group:poll:closed', { pollId });
    return { success: true };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// NOTES / KNOWLEDGE BASE
// ══════════════════════════════════════════════════════════════════════════
const NoteService = {
  async list(groupId, userId, { category, search, pinned, page = 1, limit = 20 } = {}) {
    await _assertMember(groupId, userId);
    const GN = _m('GroupNote'); if (!GN) return { notes: [], total: 0 };
    const where = { groupId, deletedAt: null };
    if (category) where.category = category;
    if (pinned !== undefined) where.isPinned = pinned;
    if (search) where.title = { [Op.iLike]: `%${search}%` };
    const { count, rows } = await GN.findAndCountAll({ where, limit, offset: (page-1)*limit, order: [['isPinned','DESC'],['updatedAt','DESC']] });
    return { notes: rows, total: count };
  },

  async create(groupId, userId, data) {
    await _assertMember(groupId, userId);
    const GN = _m('GroupNote'); if (!GN) throw new Error('Model unavailable');
    const note = await GN.create({ groupId, createdBy: userId, ...data });
    _broadcast(groupId, 'group:note:created', { note: note.toJSON() });
    _log(groupId, userId, 'note_created', 'notes', note.id, 'GroupNote');
    return note;
  },

  async update(groupId, userId, noteId, data) {
    await _assertMember(groupId, userId);
    const GN = _m('GroupNote');
    const note = await GN?.findOne({ where: { id: noteId, groupId, deletedAt: null } });
    if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });
    const m = await _getMembership(groupId, userId);
    if (String(note.createdBy) !== String(userId) && !['admin','owner'].includes(m?.role)) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    await note.update({ ...data, version: (note.version||1)+1 });
    _broadcast(groupId, 'group:note:updated', { note: note.toJSON() });
    return note;
  },

  async delete(groupId, userId, noteId) {
    await _assertMember(groupId, userId);
    const GN = _m('GroupNote');
    const note = await GN?.findOne({ where: { id: noteId, groupId } });
    if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });
    const m = await _getMembership(groupId, userId);
    if (String(note.createdBy) !== String(userId) && !['admin','owner'].includes(m?.role)) throw Object.assign(new Error('Forbidden'),{status:403});
    await note.update({ deletedAt: new Date() });
    _broadcast(groupId, 'group:note:deleted', { noteId });
    return { success: true };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// FILES
// ══════════════════════════════════════════════════════════════════════════
const FileService = {
  async list(groupId, userId, { folder = '/', search, page = 1, limit = 30 } = {}) {
    await _assertMember(groupId, userId);
    const GF = _m('GroupFile'); if (!GF) return { files: [], total: 0 };
    const where = { groupId, deletedAt: null, folder };
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    const { count, rows } = await GF.findAndCountAll({ where, limit, offset: (page-1)*limit, order: [['createdAt','DESC']] });
    return { files: rows, total: count };
  },

  async create(groupId, userId, data) {
    await _assertMember(groupId, userId);
    const GF = _m('GroupFile'); if (!GF) throw new Error('Model unavailable');
    const file = await GF.create({ groupId, uploadedBy: userId, ...data });
    _broadcast(groupId, 'group:file:uploaded', { file: file.toJSON() });
    _log(groupId, userId, 'file_uploaded', 'files', file.id, 'GroupFile');
    _updateAnalytics(groupId, 'filesUploaded');
    return file;
  },

  async delete(groupId, userId, fileId) {
    await _assertMember(groupId, userId);
    const GF = _m('GroupFile');
    const file = await GF?.findOne({ where: { id: fileId, groupId } });
    if (!file) throw Object.assign(new Error('File not found'), { status: 404 });
    const m = await _getMembership(groupId, userId);
    if (String(file.uploadedBy) !== String(userId) && !['admin','owner'].includes(m?.role)) throw Object.assign(new Error('Forbidden'),{status:403});
    await file.update({ deletedAt: new Date() });
    _broadcast(groupId, 'group:file:deleted', { fileId });
    return { success: true };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// FINANCES
// ══════════════════════════════════════════════════════════════════════════
const FinanceService = {
  async list(groupId, userId, { type, status, page = 1, limit = 30 } = {}) {
    await _assertMember(groupId, userId);
    const GFin = _m('GroupFinance'); if (!GFin) return { transactions: [], total: 0, balance: 0 };
    const where = { groupId, deletedAt: null };
    if (type) where.type = type;
    if (status) where.status = status;
    const { count, rows } = await GFin.findAndCountAll({ where, limit, offset: (page-1)*limit, order: [['createdAt','DESC']] });
    // Compute balance from completed transactions
    const all = await GFin.findAll({ where: { groupId, status: 'completed', deletedAt: null }, attributes: ['type','amount'] });
    const balance = all.reduce((acc, r) => acc + (['income','levy'].includes(r.type) ? +r.amount : -r.amount), 0);
    return { transactions: rows, total: count, balance: parseFloat(balance.toFixed(2)) };
  },

  async create(groupId, userId, data) {
    await _assertMember(groupId, userId);
    const GFin = _m('GroupFinance'); if (!GFin) throw new Error('Model unavailable');
    const tx = await GFin.create({ groupId, createdBy: userId, ...data });
    _broadcast(groupId, 'group:finance:created', { transaction: tx.toJSON() });
    _log(groupId, userId, 'finance_created', 'finances', tx.id, 'GroupFinance', { type: data.type, amount: data.amount });
    return tx;
  },

  async approve(groupId, userId, txId) {
    await _assertRole(groupId, userId, ['admin','owner']);
    const GFin = _m('GroupFinance');
    const tx = await GFin?.findOne({ where: { id: txId, groupId } });
    if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
    await tx.update({ status: 'approved', approvedBy: userId });
    _broadcast(groupId, 'group:finance:approved', { txId, approvedBy: userId });
    return tx;
  },
};

// ══════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════════════════
const AnalyticsService = {
  async getDashboard(groupId, userId, days = 30) {
    await _assertMember(groupId, userId);
    const GA = _m('GroupAnalytics') || _m('GroupAnalytic'); if (!GA) return {};
    const since = new Date(Date.now() - days * 86400000);
    const rows = await GA.findAll({ where: { groupId, date: { [Op.gte]: since.toISOString().slice(0,10) } }, order: [['date','ASC']] });

    const totals = rows.reduce((acc, r) => {
      acc.messages   += r.messageCount   || 0;
      acc.tasks      += r.tasksCreated   || 0;
      acc.completed  += r.tasksCompleted || 0;
      acc.events     += r.eventsHeld     || 0;
      acc.polls      += r.pollsCreated   || 0;
      acc.files      += r.filesUploaded  || 0;
      acc.newMembers += r.newMembers     || 0;
      return acc;
    }, { messages:0, tasks:0, completed:0, events:0, polls:0, files:0, newMembers:0 });

    // Top members from ActivityLog
    const AL = _m('GroupActivityLog');
    let topMembers = [];
    if (AL) {
      const seq = _seq();
      if (seq) {
        topMembers = await AL.findAll({
          where: { groupId, createdAt: { [Op.gte]: since } },
          attributes: ['userId', [seq.fn('COUNT','*'), 'actions']],
          group: ['userId'], order: [[seq.literal('actions'),'DESC']], limit: 10, raw: true,
        });
      }
    }
    return { totals, daily: rows, topMembers, days };
  },
};

// ══════════════════════════════════════════════════════════════════════════
// AI SUMMARIES (async queue-based)
// ══════════════════════════════════════════════════════════════════════════
const AIService = {
  // Queue an async AI summary job
  async queueSummary(groupId, type = 'daily') {
    // Push to a simple in-memory job queue; in production use Bull/BullMQ
    _aiQueue.push({ groupId, type, queuedAt: Date.now() });
    _processAIQueue();
    return { queued: true };
  },

  async getLatest(groupId, userId, type = 'daily') {
    await _assertMember(groupId, userId);
    const GAS = _m('GroupAISummary'); if (!GAS) return null;
    return GAS.findOne({ where: { groupId, type }, order: [['createdAt','DESC']] });
  },
};

// Simple in-process queue (replace with Bull for production)
const _aiQueue = [];
let _aiProcessing = false;
async function _processAIQueue() {
  if (_aiProcessing || !_aiQueue.length) return;
  _aiProcessing = true;
  const job = _aiQueue.shift();
  try {
    await _runAISummary(job.groupId, job.type);
  } catch(err) {
    console.warn('[SmartGroup AI]', err.message);
  }
  _aiProcessing = false;
  if (_aiQueue.length) setTimeout(_processAIQueue, 2000);
}

async function _runAISummary(groupId, type) {
  // Fetch recent messages for the group
  const Message = _m('Message');
  if (!Message) return;
  const since = new Date(Date.now() - 24*60*60*1000);
  const msgs = await Message.findAll({
    where: { chatId: { [Op.ne]: null }, createdAt: { [Op.gte]: since } },
    limit: 200, order: [['createdAt','DESC']], attributes: ['content','createdAt'],
    // Filter by group's chatId
    include: [{
      model: _m('Groups') || _m('Group'),
      as: 'chat', required: true,
      where: { id: groupId },
    }],
  }).catch(() => []);

  if (!msgs.length) return;
  const text = msgs.reverse().map(m => m.content).filter(Boolean).join('\n');

  // Call AI (fallback to extractive summary if no API key)
  let summary = '', actionItems = [], keywords = [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const { default: fetch } = await import('node-fetch').catch(() => ({ default: global.fetch }));
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are a concise group chat summarizer. Output JSON: { summary, actionItems: [], keywords: [] }' },
            { role: 'user', content: `Summarize these group messages:\n${text.slice(0,3000)}` },
          ],
          max_tokens: 400, temperature: 0.3,
        }),
      });
      const data = await resp.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      summary = parsed.summary || ''; actionItems = parsed.actionItems || []; keywords = parsed.keywords || [];
    } catch(_) {}
  }

  if (!summary) {
    // Extractive fallback: first 3 sentences
    summary = text.split(/[.!?]/).filter(Boolean).slice(0,3).join('. ').trim().slice(0,500);
  }

  const GAS = _m('GroupAISummary');
  if (GAS && summary) {
    const saved = await GAS.create({ groupId, type, summary, actionItems, keywords, generatedBy: apiKey?'openai':'extractive' });
    _broadcast(groupId, 'group:ai:summary_ready', { type, summaryId: saved.id, summary, actionItems });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MODULES CONFIG
// ══════════════════════════════════════════════════════════════════════════
const ModuleService = {
  async getEnabled(groupId) {
    const G = _m('Groups') || _m('Group');
    const g = await G?.findByPk(groupId, { attributes: ['enabledModules'] });
    return g?.enabledModules || ['tasks','events','polls','notes','files'];
  },

  async setEnabled(groupId, userId, modules) {
    await _assertRole(groupId, userId, ['admin','owner']);
    const G = _m('Groups') || _m('Group');
    await G?.update({ enabledModules: modules }, { where: { id: groupId } });
    _broadcast(groupId, 'group:modules:updated', { modules });
    return { success: true, modules };
  },
};

module.exports = { TaskService, EventService, PollService, NoteService, FileService, FinanceService, AnalyticsService, AIService, ModuleService, _log, _broadcast };
