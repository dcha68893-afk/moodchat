'use strict';

const express = require('express');
const router = express.Router();
const db = require('../models');
const Chat = db.Chats || db.Chat;
const ChatParticipant = db.ChatParticipant;

let installed = false;

async function getPolicy(chatId, userId) {
  if (!Chat || !ChatParticipant) return null;
  const chat = await Chat.findByPk(chatId, { attributes: ['id', 'type', 'metadata'] });
  if (!chat || chat.type !== 'group') return null;
  const participant = await ChatParticipant.findOne({ where: { chatId, userId } });
  if (!participant) return null;
  const gp = chat.metadata?.groupPlatform || {};
  return { chat, participant, blocked: Array.isArray(gp.blockedUsers) && gp.blockedUsers.map(Number).includes(Number(userId)), announcementOnly: gp.announcementOnly === true, disappearingSeconds: Number(gp.disappearingSeconds || 0) };
}

function install() {
  if (installed || !db.Messages && !db.Message) return;
  const Message = db.Messages || db.Message;
  Message.addHook('beforeValidate', 'group-platform-policy', async message => {
    if (!message || !message.chatId || !message.senderId) return;
    const policy = await getPolicy(message.chatId, message.senderId);
    if (!policy) return;
    if (policy.blocked) {
      const error = new Error('You are blocked from sending messages in this group');
      error.status = 403;
      throw error;
    }
    if (policy.announcementOnly && !['admin', 'owner'].includes(policy.participant.role) && message.type !== 'system') {
      const error = new Error('This is an announcement group. Only administrators can publish messages.');
      error.status = 403;
      throw error;
    }
    if (policy.disappearingSeconds > 0 && !message.expiresAt) {
      message.disappearingTimer = policy.disappearingSeconds;
      message.expiresAt = new Date(Date.now() + policy.disappearingSeconds * 1000);
    }
  });
  installed = true;
}

install();

router.get('/health', (_req, res) => res.json({ success: true, installed }));

module.exports = router;
