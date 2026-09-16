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

  // GROUP/1:1 BOUNDARY: always determine the real chat type from the canonical
  // lowercase chats table. A failed type lookup must NOT silently turn a group
  // message into a direct-message event.
  const [chat] = await sequelize.query(
    `SELECT "type" FROM "chats" WHERE id = :chatId LIMIT 1`,
    { replacements: { chatId: chatIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  const chatType = chat?.type;
  if (!chatType) {
    console.error(`[Messages] Refusing realtime broadcast: chat type unavailable for chatId=${chatIdInt}`);
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

  let delivered = [];
  let offline = [];
  if (chatType === 'group') {
    // Primary path: group room. Fallback path: personal user rooms. The latter
    // is important when a member has not opened the group yet and therefore
    // has not joined the group socket room. Client-side message-id dedup keeps
    // the two paths from rendering duplicates when a member is in both.
    const roomSent = wsService.broadcastToGroup(
      chatIdInt,
      'group:message',
      { message: payload, groupId: chatIdInt },
      senderIdInt
    );
    let memberSent = false;
    if (typeof wsService.broadcastGroupMessageToMembers === 'function') {
      memberSent = await wsService.broadcastGroupMessageToMembers(
        chatIdInt,
        'group:message',
        { message: payload, groupId: chatIdInt }
      ).catch(() => false);
    }
    if (roomSent || memberSent) delivered = recipientIds.slice();
    else offline = recipientIds.slice();
  } else {
    // Direct/private messages remain strictly on message:new and are never
    // emitted through the group event path.
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
