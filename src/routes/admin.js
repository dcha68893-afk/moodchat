'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { MessageReport, Users, Notification } = require('../models');
const messageDeliveryService = require('../services/messageDeliveryService');

function callerId(req) { return Number(req.user?.userId || req.user?.id) || null; }
function configuredAdminIds() {
  return String(process.env.ADMIN_USER_IDS || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
}
async function isAdmin(req) {
  const id = callerId(req);
  if (!id) return false;
  if (configuredAdminIds().includes(id)) return true;
  const user = await Users.findByPk(id, { attributes: ['id', 'role'] }).catch(() => null);
  return ['admin', 'superadmin', 'administrator'].includes(String(user?.role || '').toLowerCase());
}
async function getAdminUsers() {
  const ids = configuredAdminIds();
  const where = ids.length
    ? { [Op.or]: [{ role: { [Op.in]: ['admin', 'superadmin', 'administrator'] } }, { id: { [Op.in]: ids } }] }
    : { role: { [Op.in]: ['admin', 'superadmin', 'administrator'] } };
  return Users.findAll({ where, attributes: ['id', 'username', 'displayName', 'role'], order: [['id', 'ASC']] }).catch(() => []);
}

router.post('/reports', asyncHandler(async (req, res) => {
  const reporterId = callerId(req);
  if (!reporterId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const messageId = Number(req.body?.messageId);
  const chatId = Number(req.body?.chatId);
  const allowed = ['spam','harassment','hate_speech','violence','sexual_content','misinformation','other'];
  const reason = String(req.body?.reason || 'other');
  if (!Number.isInteger(messageId) || messageId <= 0 || !Number.isInteger(chatId) || chatId <= 0 || !allowed.includes(reason)) return res.status(400).json({ success:false, message:'messageId, chatId and a valid reason are required' });
  const details = String(req.body?.details || '').slice(0, 5000);
  try {
    const [report, created] = await MessageReport.findOrCreate({ where:{ reporterId, messageId }, defaults:{ reporterId, messageId, chatId, reason, details } });
    if (!created) return res.status(200).json({ success:true, duplicate:true, data:report });
    const admins = await getAdminUsers();
    await Promise.allSettled(admins.map(a => Notification.create({ userId:a.id, type:'system', title:'New message report', body:`A message was reported for ${reason.replace('_',' ')}.`, data:{ reportId:report.id, messageId, chatId, reporterId }, priority:'high', actionUrl:`/admin/reports/${report.id}`, actionText:'Review report', icon:'flag' })));
    return res.status(201).json({ success:true, data:report });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') return res.status(200).json({ success:true, duplicate:true });
    throw error;
  }
}));

router.get('/reports', asyncHandler(async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ success:false, message:'Admin access required' });
  const status = ['pending','reviewed','actioned','dismissed'].includes(String(req.query.status)) ? String(req.query.status) : null;
  const where = status ? { status } : {};
  const reports = await MessageReport.findAll({ where, order:[['createdAt','DESC']], limit:Math.min(Number(req.query.limit)||100,200) });
  return res.json({ success:true, data:reports });
}));

router.patch('/reports/:id', asyncHandler(async (req, res) => {
  const adminId = callerId(req);
  if (!(await isAdmin(req))) return res.status(403).json({ success:false, message:'Admin access required' });
  const report = await MessageReport.findByPk(Number(req.params.id));
  if (!report) return res.status(404).json({ success:false, message:'Report not found' });
  const status = ['pending','reviewed','actioned','dismissed'].includes(String(req.body?.status)) ? String(req.body.status) : null;
  if (!status) return res.status(400).json({ success:false, message:'Invalid report status' });
  await report.update({ status, reviewedBy:adminId, reviewedAt:new Date() });
  return res.json({ success:true, data:report });
}));

router.get('/contact', asyncHandler(async (req, res) => {
  const admins = await getAdminUsers();
  if (!admins.length) return res.status(404).json({ success:false, message:'No administrator account is configured' });
  const a = admins[0];
  return res.json({ success:true, data:{ userId:a.id, username:a.username, displayName:a.displayName || a.username } });
}));

router.post('/contact', asyncHandler(async (req, res) => {
  const userId = callerId(req);
  if (!userId) return res.status(401).json({ success:false, message:'Authentication required' });
  const admins = await getAdminUsers();
  const admin = admins.find(a => a.id !== userId) || admins[0];
  if (!admin) return res.status(404).json({ success:false, message:'No administrator account is configured' });
  const chatId = await messageDeliveryService.resolveOrCreateDirectChat(userId, admin.id);
  return res.json({ success:true, data:{ chatId, admin:{ userId:admin.id, username:admin.username, displayName:admin.displayName || admin.username } } });
}));

// Uses environment configuration only; no phone number is embedded in source.
// Accepted keys keep existing deployments compatible while allowing a clearer
// ADMIN_WHATSAPP value going forward. Both international (+254...) and
// whatsapp.com/wa.me URLs are normalized to a safe wa.me destination.
router.get('/whatsapp', asyncHandler(async (req, res) => {
  const raw = String(process.env.ADMIN_WHATSAPP || process.env.ADMIN_WHATSAPP_NUMBER || process.env.WHATSAPP_ADMIN_NUMBER || '').trim();
  if (!raw) return res.status(404).json({ success:false, message:'Admin WhatsApp destination is not configured' });
  const digits = raw.replace(/^https?:\/\/(?:www\.)?(?:wa\.me|api\.whatsapp\.com)\//i, '').replace(/[^0-9]/g, '');
  if (!digits) return res.status(500).json({ success:false, message:'Admin WhatsApp destination is invalid' });
  return res.json({ success:true, data:{ url:`https://wa.me/${digits}` } });
}));


/* =====================================================================
   PROBLEM REPORTS (all modules) -> admin inbox
   Users report scam / harassment / bias / bugs from anywhere in the app.
   Admins get a notification, review it, and act: warn, suspend, remove,
   dismiss, or reply (bugs/errors). The reporter is told the outcome.
   ===================================================================== */
const PR_CATEGORIES = ['scam','harassment','bias','hate_speech','spam','inappropriate_content','fake_account','payment_issue','bug','error','other'];
let _prTable = null;
async function ensureProblemReports() {
  if (_prTable) return _prTable;
  const { sequelize } = require('../models');
  await sequelize.query(`CREATE TABLE IF NOT EXISTS problem_reports (
      id SERIAL PRIMARY KEY, "reporterId" INTEGER NOT NULL, category VARCHAR(40) NOT NULL,
      module VARCHAR(60), subject VARCHAR(200), details TEXT, "targetUserId" INTEGER, "targetRef" VARCHAR(120),
      status VARCHAR(20) NOT NULL DEFAULT 'pending', "actionTaken" VARCHAR(30), "adminNote" TEXT,
      "handledBy" INTEGER, "handledAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS problem_reports_status_idx ON problem_reports (status, "createdAt" DESC)`);
  _prTable = sequelize;
  return _prTable;
}
async function prNotify(userId, type, title, body, data) {
  try { await Notification.create({ userId, type, title, body, data }); } catch (_) {}
  try { require('../services/webSocketService').sendToUser(userId, 'notification:new', { type, title, body, data }); } catch (_) {}
}

// Any signed-in user: submit a report from any module.
router.post('/problem-reports', asyncHandler(async (req, res) => {
  const reporterId = callerId(req);
  if (!reporterId) return res.status(401).json({ success:false, message:'Authentication required' });
  const category = String(req.body?.category || 'other');
  if (!PR_CATEGORIES.includes(category)) return res.status(400).json({ success:false, message:'Invalid category' });
  const details = String(req.body?.details || '').trim().slice(0, 5000);
  if (details.length < 5) return res.status(400).json({ success:false, message:'Please describe the problem' });
  const moduleName = String(req.body?.module || 'app').slice(0, 60);
  const subject    = String(req.body?.subject || '').slice(0, 200);
  const targetUserId = Number(req.body?.targetUserId) || null;
  const targetRef    = req.body?.targetRef ? String(req.body.targetRef).slice(0, 120) : null;
  const db = await ensureProblemReports();
  const [rows] = await db.query(
    `INSERT INTO problem_reports ("reporterId",category,module,subject,details,"targetUserId","targetRef")
     VALUES (:reporterId,:category,:moduleName,:subject,:details,:targetUserId,:targetRef) RETURNING id`,
    { replacements: { reporterId, category, moduleName, subject, details, targetUserId, targetRef } });
  const reportId = rows[0].id;
  const admins = await getAdminUsers();
  await Promise.allSettled(admins.map(a => prNotify(a.id, 'system', 'New problem report',
    `${category.replace(/_/g,' ')} reported in ${moduleName}.`, { reportId, category, module: moduleName, kind: 'problem_report' })));
  return res.status(201).json({ success:true, data:{ id: reportId } });
}));

// Reporter: see own reports and outcomes.
router.get('/problem-reports/mine', asyncHandler(async (req, res) => {
  const reporterId = callerId(req);
  if (!reporterId) return res.status(401).json({ success:false, message:'Authentication required' });
  const db = await ensureProblemReports();
  const [rows] = await db.query(`SELECT id,category,module,subject,status,"actionTaken","adminNote","createdAt" FROM problem_reports WHERE "reporterId"=:reporterId ORDER BY "createdAt" DESC LIMIT 50`, { replacements:{ reporterId } });
  return res.json({ success:true, data: rows });
}));

// Admin: inbox with filters.
router.get('/problem-reports', asyncHandler(async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ success:false, message:'Admin access required' });
  const db = await ensureProblemReports();
  const where = []; const replacements = { limit: Math.min(Number(req.query.limit) || 100, 300) };
  if (['pending','reviewed','actioned','dismissed'].includes(String(req.query.status))) { where.push('r.status=:status'); replacements.status = String(req.query.status); }
  if (PR_CATEGORIES.includes(String(req.query.category))) { where.push('r.category=:category'); replacements.category = String(req.query.category); }
  const [rows] = await db.query(
    `SELECT r.*, ru.username AS "reporterName", tu.username AS "targetName"
       FROM problem_reports r LEFT JOIN "Users" ru ON ru.id=r."reporterId" LEFT JOIN "Users" tu ON tu.id=r."targetUserId"
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r."createdAt" DESC LIMIT :limit`, { replacements });
  return res.json({ success:true, data: rows });
}));

// Admin: act on a report. action = warn | suspend | remove | dismiss | respond
router.patch('/problem-reports/:id', asyncHandler(async (req, res) => {
  const adminId = callerId(req);
  if (!(await isAdmin(req))) return res.status(403).json({ success:false, message:'Admin access required' });
  const action = String(req.body?.action || '');
  if (!['warn','suspend','remove','dismiss','respond'].includes(action)) return res.status(400).json({ success:false, message:'Invalid action' });
  const note = String(req.body?.message || '').slice(0, 2000);
  const db = await ensureProblemReports();
  const [reportRows] = await db.query(`SELECT * FROM problem_reports WHERE id=:id`, { replacements:{ id:Number(req.params.id) } });
  const report = reportRows[0];
  if (!report) return res.status(404).json({ success:false, message:'Report not found' });

  const targetId = report.targetUserId;
  if (['warn','suspend','remove'].includes(action) && !targetId)
    return res.status(400).json({ success:false, message:'This report has no target user' });
  if (targetId && targetId === adminId) return res.status(400).json({ success:false, message:'You cannot act on your own account' });

  if (action === 'warn') {
    await prNotify(targetId, 'warning', 'Warning from the moderation team', note || 'Your recent activity broke our community rules. Further violations may lead to suspension.', { reportId: report.id });
  } else if (action === 'suspend' || action === 'remove') {
    await Users.update({ isActive: false }, { where: { id: targetId } });
    if (action === 'remove') {
      // Also take down everything they have listed in the marketplace.
      try { const { Tool } = require('../models'); await Tool.update({ status:'deleted', available:false }, { where:{ sellerId: targetId } }); } catch (_) {}
    }
    try { require('../services/webSocketService').sendToUser(targetId, 'account:suspended', { reason: note || 'Policy violation' }); } catch (_) {}
  }
  const status = action === 'dismiss' ? 'dismissed' : (action === 'respond' ? 'reviewed' : 'actioned');
  await db.query(`UPDATE problem_reports SET status=:status,"actionTaken"=:action,"adminNote"=:note,"handledBy"=:adminId,"handledAt"=NOW(),"updatedAt"=NOW() WHERE id=:id`,
    { replacements:{ status, action, note, adminId, id: report.id } });
  // Tell the reporter what happened (never reveals details about the other user).
  const outcome = { warn:'We issued a warning.', suspend:'We took action on the account.', remove:'We removed the account.', dismiss:'We reviewed it and found no violation.', respond:'' }[action];
  await prNotify(report.reporterId, 'info', 'Update on your report', `${outcome} ${action==='respond' ? note : ''}`.trim(), { reportId: report.id });
  return res.json({ success:true, data:{ id: report.id, status, action } });
}));

module.exports = router;
