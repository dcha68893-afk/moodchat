'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
// ROOT-CAUSE FIX (GET/POST/DELETE /api/pins/:chatId always 500ing): this used
// to destructure { PinnedMessage, Messages, Users, ChatParticipant } straight
// off require('../models'). Models are only attached at db.models[name] in
// this codebase (see src/models/index.js) — the export object only exposes
// individually-named getters (User, Message, ChatParticipant, ...) for a
// subset of models, and PinnedMessage/Messages/Users were never among them.
// So PinnedMessage and Messages and Users were always undefined here, and
// the very first PinnedMessage.findAll()/Messages.findByPk()/Users.findByPk()
// call threw "Cannot read properties of undefined", caught by asyncHandler
// and turned into a 500 on every single call to this route.
const db = require('../models');
const PinnedMessage = db.models.PinnedMessage;
const Messages = db.Message;
const Users = db.User;
const ChatParticipant = db.ChatParticipant;

function userId(req) {
  return Number(req.user?.userId ?? req.user?.id) || null;
}
function chatId(req) {
  return Number(req.params.chatId) || null;
}

async function requireParticipant(req, res) {
  const uid = userId(req);
  const cid = chatId(req);
  if (!uid) { res.status(401).json({ success: false, message: 'Authentication required' }); return null; }
  if (!cid) { res.status(400).json({ success: false, message: 'Invalid chatId' }); return null; }
  const participant = await ChatParticipant.findOne({ where: { chatId: cid, userId: uid } });
  if (!participant) { res.status(403).json({ success: false, message: 'Not a participant of this chat' }); return null; }
  return { uid, cid };
}

router.get('/:chatId', asyncHandler(async (req, res) => {
  const ctx = await requireParticipant(req, res);
  if (!ctx) return;

  const rows = await PinnedMessage.findAll({
    where: { chatId: ctx.cid },
    order: [['pinnedAt', 'DESC']],
    limit: 3,
  });

  const pins = await Promise.all(rows.map(async pin => {
    const [message, pinnedBy] = await Promise.all([
      Messages.findByPk(pin.messageId),
      Users.findByPk(pin.pinnedBy, { attributes: ['id', 'username', 'displayName', 'avatar'] }),
    ]);
    return {
      id: pin.id,
      chatId: pin.chatId,
      messageId: pin.messageId,
      pinnedAt: pin.pinnedAt,
      pinnedBy: pinnedBy ? pinnedBy.toJSON() : null,
      message: message ? message.toJSON() : null,
    };
  }));

  return res.json({ success: true, data: { pins: pins.filter(p => p.message) } });
}));

router.post('/:chatId', asyncHandler(async (req, res) => {
  const ctx = await requireParticipant(req, res);
  if (!ctx) return;
  const messageId = Number(req.body?.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const message = await Messages.findOne({ where: { id: messageId, chatId: ctx.cid } });
  if (!message) return res.status(404).json({ success: false, message: 'Message not found in this chat' });

  const existing = await PinnedMessage.findOne({ where: { chatId: ctx.cid, messageId } });
  if (existing) return res.json({ success: true, data: existing, alreadyPinned: true });

  const count = await PinnedMessage.count({ where: { chatId: ctx.cid } });
  if (count >= 3) return res.status(409).json({ success: false, message: 'A chat can have at most 3 pinned messages' });

  const pin = await PinnedMessage.create({ chatId: ctx.cid, messageId, pinnedBy: ctx.uid });
  return res.status(201).json({ success: true, data: pin });
}));

router.delete('/:chatId/:messageId', asyncHandler(async (req, res) => {
  const ctx = await requireParticipant(req, res);
  if (!ctx) return;
  const messageId = Number(req.params.messageId);
  if (!messageId) return res.status(400).json({ success: false, message: 'Invalid messageId' });

  const deleted = await PinnedMessage.destroy({ where: { chatId: ctx.cid, messageId } });
  return res.json({ success: true, data: { removed: deleted > 0 } });
}));

module.exports = router;
