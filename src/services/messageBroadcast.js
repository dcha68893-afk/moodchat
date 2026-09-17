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

  if (!Number.isInteger(chatIdInt) || chatIdInt <= 0) {
    console.error('[Messages] Refusing realtime broadcast: invalid chatId');
    return { recipientIds: [], delivered: [], offline: [] };
  }

  const participants = await sequelize.query(
    `SELECT DISTINCT "userId" FROM chat_participants
     WHERE "chatId" = :chatId AND "userId" != :senderId`,
    {
      replacements: { chatId: chatIdInt, senderId: senderIdInt },
      type: sequelize.QueryTypes.SELECT,
    }
  ).catch(() => []);
  const recipientIds = participants.map(p => p.userId).filter(Boolean);

  const [chat] = await sequelize.query(
    `SELECT "type" FROM "chats" WHERE id = :chatId LIMIT 1`,
    { replacements: { chatId: chatIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  const chatType = String(chat?.type || '').toLowerCase();

  if (chatType !== 'group' && chatType !== 'direct') {
    console.error(`[Messages] Refusing realtime broadcast: unsupported chat type for chatId=${chatIdInt}`);
    return { recipientIds, delivered: [], offline: recipientIds.slice() };
  }

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

  // IMPORTANT: do NOT echo message:new back to the sender. The sender already
  // has the optimistic bubble and the REST response reconciles it. Echoing
  // message:new creates a second bubble and also sends the sender's own
  // ciphertext through the decrypt path, producing V3_DECRYPT_REFUSED_OWN_MESSAGE.
  // Sender acknowledgement remains the dedicated message:sent event emitted
  // by the socket send handler; recipient delivery remains message:new.

  if (!recipientIds.length) {
    await messageDeliveryService.notifyMessageRecipients(message, [], {
      push: false,
      offlineRecipientIds: [],
    }).catch(() => {});
    return { recipientIds: [], delivered: [], offline: [] };
  }

  let delivered = [];
  let offline = [];

  if (chatType === 'group') {
    const results = await Promise.allSettled(
      recipientIds.map(uid =>
        wsService.sendToUser(uid, 'group:message', {
          message: payload,
          groupId: chatIdInt,
        })
      )
    );

    recipientIds.forEach((uid, index) => {
      const ok = results[index].status === 'fulfilled' && results[index].value === true;
      (ok ? delivered : offline).push(uid);
    });
  } else {
    const results = await Promise.allSettled(
      recipientIds.map(uid => wsService.sendToUser(uid, 'message:new', payload))
    );

    recipientIds.forEach((uid, index) => {
      const ok = results[index].status === 'fulfilled' && results[index].value === true;
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
