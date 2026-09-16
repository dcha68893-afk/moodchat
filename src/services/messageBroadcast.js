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

  // ROOT-CAUSE FIX (GROUP-MESSAGE-CREATES-DUPLICATE-1:1-CONTACT — primary
  // cause): this query referenced the table as "Chats" (capital C, quoted —
  // meaning Postgres looks for a relation literally named "Chats"), but the
  // actual physical table created by migrations/2026999990000_create_chats_
  // and_chat_participants.js (and matching src/models/Chats.js's
  // `tableName: 'chats'`) is lowercase "chats". Querying a relation that
  // doesn't exist threw on every single call, was silently swallowed by the
  // .catch(() => [null]) below, and made chatType default to 'direct' for
  // EVERY message — group chats included. That defeated this whole
  // function's reason for existing: the `if (chatType === 'group')` branch
  // a few lines down never ran, so every group message was sent through the
  // per-user, per-recipient 'message:new' socket event (the same event a
  // real 1:1 DM uses) instead of the room-based 'group:message' broadcast.
  // On the receiving client, the Messages module has no reliable way to
  // know that a bare 'message:new' actually came from a group (see
  // js/group-message-isolation.js's isKnownGroupMessage(), which can only
  // catch it via a separately-loaded, async group-id list racing against
  // message arrival) — so it very often got treated as a genuine new DM
  // from the sender, creating a duplicate 1:1 conversation entry for that
  // group member. Fixed to query the real "chats" table.
  const [chat] = await sequelize.query(
    `SELECT "type" FROM "chats" WHERE id = :chatId LIMIT 1`,
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
