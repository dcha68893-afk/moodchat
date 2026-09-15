'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const db = require('../models');
const Chat = db.Chat;
const User = db.User;
const ChatParticipant = db.ChatParticipant;

function uid(req) { return req.user?.userId || req.user?.id || req.user?.sub; }
async function loadGroup(chatId) {
  const chat = await Chat.findByPk(chatId);
  if (!chat || chat.type !== 'group' || chat.isActive === false) {
    const e = new Error('Group not found'); e.status = 404; throw e;
  }
  return chat;
}
async function membership(chatId, userId) {
  return ChatParticipant.findOne({ where: { chatId, userId } });
}
async function requireManager(chat, userId) {
  const p = await membership(chat.id, userId);
  if (!p) { const e = new Error('You are not a member of this group'); e.status = 403; throw e; }
  const owner = String(chat.createdBy) === String(userId);
  if (!owner && p.role !== 'admin') { const e = new Error('Admin permission required'); e.status = 403; throw e; }
  return { participant: p, owner };
}
async function emitGroup(req, event, payload) {
  const io = req.io || global.__socketIO;
  if (!io) return;
  try {
    const ids = await ChatParticipant.findAll({ where: { chatId: payload.groupId }, attributes: ['userId'] });
    for (const row of ids) {
      io.to(`user:${row.userId}`).emit(event, payload);
      io.to(`user_${row.userId}`).emit(event, payload);
    }
  } catch (_) {}
}

// GET /api/group-admin/:chatId/members
router.get('/:chatId/members', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const me = await membership(chat.id, uid(req));
    if (!me) return res.status(403).json({ success:false, message:'Not a group member' });
    const rows = await ChatParticipant.findAll({
      where: { chatId: chat.id },
      include: [{ model: User, as: 'chatParticipantUser', attributes: ['id','username','avatar','firstName','lastName','status','lastSeen'] }],
      order: [['joinedAt','ASC']]
    });
    return res.json({ success:true, data: rows.map(p => ({
      id:p.userId, role:p.role, isMuted:p.isMuted, mutedUntil:p.mutedUntil, joinedAt:p.joinedAt,
      user:p.chatParticipantUser
    })) });
  } catch (e) { return res.status(e.status || 500).json({ success:false, message:e.message }); }
});

// POST /api/group-admin/:chatId/members { userId }
router.post('/:chatId/members', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    await requireManager(chat, uid(req));
    const userId = Number(req.body?.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({success:false,message:'Valid userId is required'});
    const user = await User.findByPk(userId, { attributes:['id','username','avatar','firstName','lastName','status'] });
    if (!user) return res.status(404).json({success:false,message:'User not found'});
    const existing = await membership(chat.id, userId);
    if (existing) return res.status(409).json({success:false,message:'User is already a member'});
    await ChatParticipant.create({ chatId:chat.id, userId, role:'member', joinedAt:new Date() });
    const payload = { groupId:chat.id, member:{ id:user.id, userId:user.id, username:user.username, avatar:user.avatar, firstName:user.firstName, lastName:user.lastName, role:'member' }, addedBy:uid(req), timestamp:new Date().toISOString() };
    await emitGroup(req,'GROUP_MEMBER_ADDED',payload);
    await emitGroup(req,'group:member:added',payload);
    return res.status(201).json({success:true,data:payload.member});
  } catch (e) { return res.status(e.status || 500).json({success:false,message:e.message}); }
});

// DELETE /api/group-admin/:chatId/members/:userId
router.delete('/:chatId/members/:userId', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    await requireManager(chat, actor);
    const targetId = Number(req.params.userId);
    if (String(targetId) === String(chat.createdBy)) return res.status(403).json({success:false,message:'The group owner cannot be removed'});
    const target = await membership(chat.id, targetId);
    if (!target) return res.status(404).json({success:false,message:'Member not found'});
    const actorMembership = await membership(chat.id, actor);
    if (target.role === 'admin' && String(chat.createdBy) !== String(actor) && actorMembership.role !== 'admin') return res.status(403).json({success:false,message:'Cannot remove an administrator'});
    await ChatParticipant.destroy({ where:{ chatId:chat.id, userId:targetId } });
    const payload = { groupId:chat.id, userId:targetId, removedBy:actor, timestamp:new Date().toISOString() };
    await emitGroup(req,'GROUP_MEMBER_REMOVED',payload);
    await emitGroup(req,'group:member:removed',payload);
    return res.json({success:true,data:payload});
  } catch (e) { return res.status(e.status || 500).json({success:false,message:e.message}); }
});

// PATCH /api/group-admin/:chatId/members/:userId/role { role: admin|member }
router.patch('/:chatId/members/:userId/role', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    const { owner } = await requireManager(chat, actor);
    const targetId = Number(req.params.userId);
    const role = req.body?.role;
    if (!['admin','member'].includes(role)) return res.status(400).json({success:false,message:'Role must be admin or member'});
    if (String(targetId) === String(chat.createdBy)) return res.status(403).json({success:false,message:'The owner always remains owner'});
    if (!owner) return res.status(403).json({success:false,message:'Only the group owner can change administrator roles'});
    const target = await membership(chat.id, targetId);
    if (!target) return res.status(404).json({success:false,message:'Member not found'});
    target.role = role; await target.save();
    const payload={groupId:chat.id,userId:targetId,role,updatedBy:actor,timestamp:new Date().toISOString()};
    await emitGroup(req,'group:role_update',payload);
    return res.json({success:true,data:payload});
  } catch(e){ return res.status(e.status||500).json({success:false,message:e.message}); }
});

// PATCH /api/group-admin/:chatId/members/:userId/mute { muted, mutedUntil }
router.patch('/:chatId/members/:userId/mute', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    await requireManager(chat, actor);
    const targetId = Number(req.params.userId);
    const target = await membership(chat.id, targetId);
    if (!target) return res.status(404).json({success:false,message:'Member not found'});
    const muted = req.body?.muted !== false;
    target.isMuted = muted;
    target.mutedUntil = muted && req.body?.mutedUntil ? new Date(req.body.mutedUntil) : null;
    await target.save();
    const payload={groupId:chat.id,userId:targetId,muted,mutedUntil:target.mutedUntil,updatedBy:actor,timestamp:new Date().toISOString()};
    await emitGroup(req,'group:mute',payload);
    return res.json({success:true,data:payload});
  } catch(e){ return res.status(e.status||500).json({success:false,message:e.message}); }
});

// PATCH /api/group-admin/:chatId/settings { settings }
router.patch('/:chatId/settings', async (req, res) => {
  try {
    const chat = await loadGroup(req.params.chatId);
    const actor = uid(req);
    await requireManager(chat, actor);
    const allowed=['allowMedia','allowCalls','allowReactions','allowReplies','allowEditing','allowDeleting','slowMode','requireAdminApproval'];
    const incoming=req.body?.settings || {};
    const next={...(chat.settings || {})};
    for(const key of allowed) if(Object.prototype.hasOwnProperty.call(incoming,key)) next[key]=incoming[key];
    await chat.update({settings:next,updatedAt:new Date()});
    const payload={groupId:chat.id,settings:next,updatedBy:actor,timestamp:new Date().toISOString()};
    await emitGroup(req,'group:settings:updated',payload);
    return res.json({success:true,data:{settings:next}});
  } catch(e){ return res.status(e.status||500).json({success:false,message:e.message}); }
});

module.exports = router;
