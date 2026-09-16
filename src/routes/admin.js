'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { MessageReport, Users, Notification, sequelize } = require('../models');
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
  const where = ids.length ? { [Op.or]: [{ role: { [Op.in]: ['admin', 'superadmin', 'administrator'] } }, { id: { [Op.in]: ids } }] } : { role: { [Op.in]: ['admin', 'superadmin', 'administrator'] } };
  return Users.findAll({ where, attributes: ['id', 'username', 'displayName', 'role'], order: [['id', 'ASC']] }).catch(() => []);
}

// Submit a message abuse report. One report per user/message is enforced by
// the model's unique index; the operation is transactional and also alerts
// every configured admin through the existing notification pipeline.
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

// Return the configured admin destination for the "Chat with admin" action.
// The client then uses the canonical direct-chat resolver, so it never creates
// a second private-chat pipeline.
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

module.exports = router;
