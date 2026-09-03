// =============================================================================
// messageBroadcast.js
// -----------------------------------------------------------------------------
// The single "a message was created — now deliver it live and notify" step.
//
// This exists so REST (routes/messages.js) and realtime (webSocketService.js's
// 'message:send' handler) never each maintain their own copy of "look up the
// other participants, push message:new over the socket, decide who needs an
// OS push". Both transports create the message via
// messageDeliveryService.sendMessage(), then both call broadcastNewMessage()
// here. This is the one authoritative post-create step (spec §10).
// =============================================================================

'use strict';

function getSequelize() {
  const db = require('../models');
  return db.sequelize;
}

/**
 * @param {object} message  the row returned by messageDeliveryService.sendMessage()
 * @param {number} senderId the id of the user who sent it (excluded from recipients)
 * @returns {Promise<{recipientIds: number[], delivered: number[], offline: number[]}>}
 */
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
  if (recipientIds.length === 0) {
    return { recipientIds: [], delivered: [], offline: [] };
  }

  // Canonical wire shape for the 'message:new' event — REST and socket
  // sends both produce exactly this, so the frontend has one shape to
  // handle regardless of which transport the message came in over.
  const payload = {
    id: message.id,
    chatId: message.chatId,
    conversationId: message.chatId,
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
