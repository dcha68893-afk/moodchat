// =============================================================================
// messageBroadcast.js — canonical post-create realtime delivery
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
  if (!recipientIds.length) return { recipientIds: [], delivered: [], offline: [] };

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

  // ROOT-CAUSE FIX (GROUP-MESSAGE-DUPLICATES-INTO-1:1-PANEL): this used to
  // emit a per-user 'group:message:new' for group chats — an event name
  // NOTHING in the frontend listens for (the group panel's 17 listener
  // registrations, and every other one of the 11 other backend broadcast
  // call sites, all use the plain 'group:message' event, delivered via
  // wsService's room-based broadcastToGroup, not per-user sendToUser).
  // Because nothing consumed 'group:message:new', the message never
  // rendered live in the group panel for anyone (sender included); it only
  // surfaced later when a generic chat-history/sync pass — which does not
  // filter by chat type — pulled the same chatId's rows into the 1:1
  // message list. Routing group chats through the same room broadcast every
  // other group feature already uses fixes both: it renders live in the
  // group panel, and stops being per-user-delivered in a way indistinguishable
  // from a direct message.
  let delivered = [];
  let offline = [];
  if (chatType === 'group') {
    const sent = wsService.broadcastToGroup(chatIdInt, 'group:message', { message: payload, groupId: chatIdInt }, senderIdInt);
    if (sent) delivered = recipientIds.slice();
    else offline = recipientIds.slice();
  } else {
    // Direct/private messages stay on message:new, per-user.
    const results = await Promise.allSettled(
      recipientIds.map(uid => wsService.sendToUser(uid, 'message:new', payload))
    );
    recipientIds.forEach((uid, i) => {
      const ok = results[i].status === 'fulfilled' && results[i].value === true;
      (ok ? delivered : offline).push(uid);
    });
  }

  await messageDeliveryService.notifyMessageRecipients(message, recipientIds, {
    push: true,
    offlineRecipientIds: offline,
  }).catch(() => {});

  return { recipientIds, delivered, offline };
}

module.exports = { broadcastNewMessage };
