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
  // Add who sent / who reported and the message type. Content stays out: chats are end-to-end encrypted,
  // so the readable copy is the one the reporter attaches via a problem report.
  const { sequelize } = require('../models');
  let facts = {};
  try {
    const ids = reports.map(r => Number(r.messageId)).filter(Boolean);
    if (ids.length) {
      const [rows] = await sequelize.query(`SELECT m.id, m."senderId", m.type, m."isDeleted", u.username AS "senderName" FROM "Messages" m LEFT JOIN "Users" u ON u.id=m."senderId" WHERE m.id IN (:ids)`, { replacements:{ ids } });
      rows.forEach(r => { facts[r.id] = r; });
    }
    const rids = [...new Set(reports.map(r => Number(r.reporterId)).filter(Boolean))];
    if (rids.length) { const us = await Users.findAll({ where:{ id:{ [Op.in]: rids } }, attributes:['id','username'] }); us.forEach(u => { facts['u'+u.id] = u.username; }); }
  } catch (_) {}
  const data = reports.map(r => { const j = r.toJSON ? r.toJSON() : r; const f = facts[j.messageId] || {};
    return { ...j, reporterName: facts['u'+j.reporterId] || null, senderId: f.senderId || null, senderName: f.senderName || null, messageType: f.type || null, messageDeleted: !!f.isDeleted }; });
  return res.json({ success:true, data });
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

  // Prefer a real in-app administrator account. If none is configured, fall
  // back to the WhatsApp destination already stored in the environment.
  if (admin) {
    try {
      const chatId = await messageDeliveryService.resolveOrCreateDirectChat(userId, admin.id);
      return res.json({ success:true, data:{ chatId, admin:{ userId:admin.id, username:admin.username, displayName:admin.displayName || admin.username } } });
    } catch (error) {
      console.warn('[Admin] internal contact chat unavailable; checking WhatsApp fallback:', error.message);
    }
  }

  const raw = String(process.env.ADMIN_WHATSAPP_NUMBER || process.env.ADMIN_WHATSAPP || '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits) return res.json({ success:true, data:{ whatsapp:`https://wa.me/${digits}`, fallback:'whatsapp' } });
  return res.status(404).json({ success:false, message:'No administrator account or WhatsApp support contact is configured' });
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
  // Older deployments created this table from an earlier shape. Verify every
  // column additively instead of assuming the old table already matches the
  // current INSERT contract; this makes report submission self-healing after
  // partial/older migrations.
  await sequelize.query(`CREATE TABLE IF NOT EXISTS problem_reports (
      id SERIAL PRIMARY KEY, "reporterId" INTEGER NOT NULL, category VARCHAR(40) NOT NULL,
      module VARCHAR(60), subject VARCHAR(200), details TEXT, "targetUserId" INTEGER, "targetRef" VARCHAR(120),
      status VARCHAR(20) NOT NULL DEFAULT 'pending', "actionTaken" VARCHAR(30), "adminNote" TEXT,
      "handledBy" INTEGER, "handledAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "reporterId" INTEGER`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS category VARCHAR(40)`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS module VARCHAR(60)`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS subject VARCHAR(200)`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS details TEXT`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "targetUserId" INTEGER`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "targetRef" VARCHAR(120)`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending'`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "actionTaken" VARCHAR(30)`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "adminNote" TEXT`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "handledBy" INTEGER`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "handledAt" TIMESTAMPTZ`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await sequelize.query(`ALTER TABLE problem_reports ADD COLUMN IF NOT EXISTS "messageRef" JSONB`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS problem_reports_status_idx ON problem_reports (status, "createdAt" DESC)`);
  _prTable = sequelize;
  return _prTable;
}
async function prNotify(userId, type, title, body, data) {
  try { await Notification.create({ userId, type, title, body, data }); } catch (_) {}
  try { require('../services/webSocketService').sendToUser(userId, 'notification:new', { type, title, body, data }); } catch (_) {}
}


// ---- Report evidence (attachments + reported-message snapshot) -------------
// Attachments must be files this app's own upload endpoint produced, so an
// admin's browser is never pointed at an arbitrary third-party URL.
function allowedEvidenceHost(req, url) {
  let u; try { u = new URL(url); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  const own = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean).map(h => String(h).split(',')[0].trim().split(':')[0].toLowerCase());
  // Uploads are addressed with RENDER_EXTERNAL_URL / BACKEND_URL when set (see routes/files.js absUrl), which can differ from the Host header.
  const envHosts = [process.env.RENDER_EXTERNAL_URL, process.env.BACKEND_URL].filter(Boolean).map(v => { try { return new URL(v).hostname.toLowerCase(); } catch (_) { return ''; } }).filter(Boolean);
  const extra = envHosts.concat(String(process.env.REPORT_ATTACHMENT_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
  return own.includes(host) || host === 'res.cloudinary.com' || host.endsWith('.cloudinary.com') || extra.includes(host);
}
function cleanEvidenceFile(req, f) {
  if (!f || typeof f !== 'object') return null;
  const url = String(f.url || '').slice(0, 1000);
  if (!url || !allowedEvidenceHost(req, url)) return null;
  const mime = String(f.mimeType || f.mime || '').slice(0, 100);
  const type = ['image','video','audio','document','file'].includes(f.type) ? f.type : (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');
  return { url, name: String(f.name || f.originalName || 'file').slice(0, 160), mimeType: mime, type, size: Number(f.size) || 0 };
}
async function buildMessageRef(req, db, reporterId, raw) {
  const messageId = Number(raw && raw.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  const ref = { messageId, chatId: Number(raw.chatId) || null, verified: false,
    text: String(raw.text || '').slice(0, 2000),
    media: (Array.isArray(raw.media) ? raw.media : []).slice(0, 5).map(m => cleanEvidenceFile(req, m)).filter(Boolean),
    senderId: Number(raw.senderId) || null, senderName: String(raw.senderName || '').slice(0, 80), type: String(raw.type || '').slice(0, 20), sentAt: raw.sentAt || null };
  try {
    // Server-side facts always win: only a message the reporter can actually see is "verified".
    const [rows] = await db.query(
      `SELECT m.id, m."chatId", m."senderId", m.type, m."sentAt", m."createdAt", u.username AS "senderName"
         FROM "Messages" m JOIN chat_participants cp ON cp."chatId"=m."chatId" AND cp."userId"=:reporterId
         LEFT JOIN "Users" u ON u.id=m."senderId" WHERE m.id=:messageId LIMIT 1`, { replacements: { reporterId, messageId } });
    const m = rows[0];
    if (m) { ref.verified = true; ref.chatId = m.chatId; ref.senderId = m.senderId; ref.senderName = m.senderName || ref.senderName; ref.type = m.type || ref.type; ref.sentAt = m.sentAt || m.createdAt || ref.sentAt; }
  } catch (_) {}
  return ref;
}

// Any signed-in user: submit a report from any module.
router.post('/problem-reports', asyncHandler(async (req, res) => {
  const requestId = req.id || req.requestId || null;
  try {
  const reporterId = callerId(req);
  if (!reporterId) return res.status(401).json({ success:false, message:'Authentication required' });
  const category = String(req.body?.category || 'other');
  if (!PR_CATEGORIES.includes(category)) return res.status(400).json({ success:false, message:'Invalid category' });
  const details = String(req.body?.details || '').trim().slice(0, 5000);
  if (details.length < 5) return res.status(400).json({ success:false, message:'Please describe the problem' });
  const moduleName = String(req.body?.module || 'app').slice(0, 60);
  const subject    = String(req.body?.subject || '').slice(0, 200);
  let targetUserId = Number(req.body?.targetUserId) || null;
  const targetRef    = req.body?.targetRef ? String(req.body.targetRef).slice(0, 120) : null;
  const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : []).slice(0, 5).map(f => cleanEvidenceFile(req, f)).filter(Boolean);
  const dbEv = await ensureProblemReports();
  const messageRef = req.body?.messageRef ? await buildMessageRef(req, dbEv, reporterId, req.body.messageRef) : null;
  // Reporting a message tags whoever sent it, unless the reporter picked someone else.
  if (messageRef && messageRef.verified && !targetUserId && messageRef.senderId && messageRef.senderId !== reporterId) targetUserId = messageRef.senderId;
  // Tagged user must be a real account, and nobody can report themselves.
  if (targetUserId) {
    if (targetUserId === reporterId) return res.status(400).json({ success:false, message:'You cannot report your own account' });
    const targetUser = await Users.findByPk(targetUserId, { attributes: ['id'] }).catch(() => null);
    if (!targetUser) return res.status(400).json({ success:false, message:'The tagged user could not be found' });
  }
  const db = await ensureProblemReports();
  const [rows] = await db.query(
    `INSERT INTO problem_reports ("reporterId",category,module,subject,details,"targetUserId","targetRef",attachments,"messageRef")
     VALUES (:reporterId,:category,:moduleName,:subject,:details,:targetUserId,:targetRef,CAST(:attachments AS jsonb),CAST(:messageRef AS jsonb)) RETURNING id`,
    { replacements: { reporterId, category, moduleName, subject, details, targetUserId, targetRef, attachments: JSON.stringify(attachments), messageRef: messageRef ? JSON.stringify(messageRef) : null } });
  const reportId = rows[0].id;
  const admins = await getAdminUsers();
  await Promise.allSettled(admins.map(a => prNotify(a.id, 'system', 'New problem report',
    `${category.replace(/_/g,' ')} reported in ${moduleName}.`, { reportId, category, module: moduleName, kind: 'problem_report' })));
  return res.status(201).json({ success:true, data:{ id: reportId } });
  } catch (error) {
    console.error('[Admin] problem report submission failed', {
      requestId, reporterId: callerId(req), name: error?.name, message: error?.message, stack: error?.stack
    });
    return res.status(500).json({
      success:false,
      message:'Internal server error',
      code:'INTERNAL_SERVER_ERROR',
      requestId
    });
  }
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
  if (!['warn','suspend','remove','dismiss','respond','remove_message'].includes(action)) return res.status(400).json({ success:false, message:'Invalid action' });
  const note = String(req.body?.message || '').slice(0, 2000);
  const db = await ensureProblemReports();
  const [reportRows] = await db.query(`SELECT * FROM problem_reports WHERE id=:id`, { replacements:{ id:Number(req.params.id) } });
  const report = reportRows[0];
  if (!report) return res.status(404).json({ success:false, message:'Report not found' });

  const targetId = report.targetUserId;
  if (['warn','suspend','remove'].includes(action) && !targetId)
    return res.status(400).json({ success:false, message:'This report has no target user' });
  if (targetId && targetId === adminId) return res.status(400).json({ success:false, message:'You cannot act on your own account' });

  if (action === 'remove_message') {
    const ref = report.messageRef;
    if (!ref || !ref.verified || !ref.messageId) return res.status(400).json({ success:false, message:'This report has no verified message to remove' });
    const [mrows] = await db.query(`SELECT id,"chatId" FROM "Messages" WHERE id=:id LIMIT 1`, { replacements:{ id: ref.messageId } });
    if (!mrows[0]) return res.status(404).json({ success:false, message:'Message no longer exists' });
    await db.query(`UPDATE "Messages" SET "isDeleted"=true,"deletedAt"=NOW(),"deletedBy"=:adminId,"updatedAt"=NOW() WHERE id=:id`, { replacements:{ id: ref.messageId, adminId } });
    try { await require('../services/webSocketService').broadcastToChatFull(mrows[0].chatId, 'message:deleted', { messageId: ref.messageId, chatId: mrows[0].chatId, deletedBy: adminId, deleteForEveryone: true, deletedFor: null }); } catch (_) {}
  }
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
  const outcome = { remove_message:'We removed the reported message.', warn:'We issued a warning.', suspend:'We took action on the account.', remove:'We removed the account.', dismiss:'We reviewed it and found no violation.', respond:'' }[action];
  await prNotify(report.reporterId, 'info', 'Update on your report', `${outcome} ${action==='respond' ? note : ''}`.trim(), { reportId: report.id });
  return res.json({ success:true, data:{ id: report.id, status, action } });
}));

module.exports = router;
