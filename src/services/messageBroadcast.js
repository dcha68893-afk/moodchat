// =============================================================================
// messageBroadcast.js
// -----------------------------------------------------------------------------
// Single authoritative post-create realtime delivery step.
// =============================================================================

'use strict';

function getSequelize() {
  const db = require('../models');
  return db.sequelize;
}

async function broadcastNewMessage(message, senderId) {
  const sequelize = getSequelize();
  const wsService = require('./webSocketService');
  const messageDeliveryService = require('./messageDeliveryService');
  const senderIdInt = parseInt(senderId, 10);
  const chatIdInt = parseInt(message.chatId, 10);

  const participants = await sequelize.query(
    `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
    { replacements: { chatId: chatIdInt, senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  const recipientIds = participants.map(p => p.userId);
  if (recipientIds.length === 0) return { recipientIds: [], delivered: [], offline: [] };

  // Explicitly classify the conversation so the private Message module can
  // ignore group traffic while the Group module can consume it independently.
  const [chat] = await sequelize.query(
    `SELECT "type" FROM "Chats" WHERE id = :chatId LIMIT 1`,
    { replacements: { chatId: chatIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  const chatType = chat?.type || 'direct';

  const payload = {
    id: message.id,
    chatId: message.chatId,
    conversationId: message.chatId,
    chatType,
    isGroup: chatType === 'group',
    senderId: message.senderId,
    content: message.content,
    type: message.type,
    sender: message.sender || null,
    replyToId: message.replyToId || null,
    clientMessageId: message.clientMessageId || null,
    metadata: message.metadata || null,
    createdAt: message.createdAt,
    sentAt: message.sentAt,
    status: 'sent',
  };

  const results = await Promise.allSettled(
    recipientIds.map(uid => wsService.sendToUser(uid, 'message:new', payload))
  );
  const delivered = [];
  const offline = [];
  recipientIds.forEach((uid, i) => {
    const wasDelivered = results[i].status === 'fulfilled' && results[i].value === true;
    (wasDelivered ? delivered : offline).push(uid);
  });

  await messageDeliveryService.notifyMessageRecipients(message, recipientIds, {
    push: true,
    offlineRecipientIds: offline,
  }).catch(() => {});

  return { recipientIds, delivered, offline };
}

module.exports = { broadcastNewMessage };
