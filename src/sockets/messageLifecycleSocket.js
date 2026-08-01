// =============================================================================
// messageLifecycleSocket.js
// -----------------------------------------------------------------------------
// MESSAGE LIFECYCLE REBUILD (messages-only scope, added 2026-07-26).
//
// Registers a brand-new, deliberately separate event namespace (`msg:*`)
// for the 1:1 message send/ack/read/sync flow described in the Signal-style
// lifecycle diagram this rebuild follows:
//
//   msg:send            (client -> server)  create message, idempotent
//   msg:send:ack        (server -> sender)  server id assigned, status=sent
//   msg:send:error      (server -> sender)  validation/auth failure
//   msg:new             (server -> recipient) push to whoever is online
//   msg:delivered_ack   (client -> server)  recipient confirms local storage
//   msg:delivered       (server -> sender)  -> ✓✓ delivered
//   msg:read            (client -> server, then server -> sender) -> ✓✓ read
//   msg:sync            (client -> server)  reconnect catch-up request
//   msg:sync:result     (server -> client)  per-chat missed messages
//
// WHY A SEPARATE NAMESPACE INSTEAD OF REUSING message:*
// ------------------------------------------------------
// The existing `message:*` events are consumed by several overlapping
// frontend relay layers (iframe postMessage bridge, mesh relay, multiple
// "phaseN" patches) that coordinate via a shared "claim once" dedup flag.
// That coordination is what's actually causing messages to intermittently
// vanish: whichever relay path claims the event first is the only one that
// will render it, and if that path fails partway (iframe not ready, socket
// listener not yet rebound after reconnect), nothing else picks up the
// slack. Per the agreed scope, this rebuild does NOT touch that shared
// relay system (it's also used by calls/groups/games). Instead it gives
// messages their own event names that no existing relay/dedup code even
// looks at, so there is nothing for them to race against. The frontend's
// new MessageLifecycleClient.js listens directly on the socket for these,
// bypassing the claim system entirely, and re-dispatches through the
// existing (working) render pipeline once a message is confirmed unique.
// =============================================================================

const messageDeliveryService = require('../services/messageDeliveryService');

function register(wsService, socket, userId) {
  if (socket.__msgLifecycleBound) return; // idempotent registration guard
  socket.__msgLifecycleBound = true;

  // ---- client -> server: send a message -----------------------------------
  socket.on('msg:send', async (payload = {}, cb) => {
    // FIX-RECEIVERID-GAP: accept receiverId alongside chatId. Every "message
    // this person" entry point from Friends/Calls/Status starts with only a
    // receiverId (no chatId exists yet) — messageDeliveryService.sendMessage()
    // now resolves/creates the real direct chat from it, same as the
    // REST POST /messages path already does.
    const { chatId, receiverId, content, type, clientMessageId, replyToId } = payload;
    try {
      if (!clientMessageId) {
        socket.emit('msg:send:error', { clientMessageId, error: 'clientMessageId is required' });
        if (typeof cb === 'function') cb({ ok: false, error: 'clientMessageId is required' });
        return;
      }
      if (!chatId && !receiverId) {
        socket.emit('msg:send:error', { clientMessageId, error: 'chatId or receiverId is required' });
        if (typeof cb === 'function') cb({ ok: false, error: 'chatId or receiverId is required' });
        return;
      }

      const { message, alreadyExisted } = await messageDeliveryService.sendMessage({
        chatId, receiverId, senderId: userId, content, type, clientMessageId, replyToId,
      });

      const ackPayload = {
        clientMessageId,
        serverId: message.id,
        chatId: message.chatId,
        status: message.status || 'sent',
        sentAt: message.sentAt || message.createdAt,
        alreadyExisted: !!alreadyExisted,
      };
      socket.emit('msg:send:ack', ackPayload);
      if (typeof cb === 'function') cb({ ok: true, ...ackPayload });

      // Don't re-push to recipients if this was just a retried/duplicate
      // send that already delivered the first time.
      if (alreadyExisted) return;

      await pushToRecipients(wsService, message, userId);
    } catch (err) {
      socket.emit('msg:send:error', { clientMessageId, error: err.message });
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
    }
  });

  // ---- client -> server: recipient confirms local storage -----------------
  socket.on('msg:delivered_ack', async ({ serverId, chatId } = {}) => {
    if (!serverId) return;
    try {
      await messageDeliveryService.markDelivered(serverId, userId);
      // FIX-ACK-EVENT-MISMATCH: this is the ack event the client actually
      // sends on real receipt (confirmed live in traffic — 'msg:delivered_ack',
      // not 'message:delivery_ack'). The 10s ack-timeout armed in messages.js
      // was only ever wired to clear on 'message:delivery_ack', which nothing
      // emits, so it fired 'delivery_timeout' on every single message exactly
      // 10s after this real ack already confirmed delivery. Clear it here too.
      if (typeof wsService.clearMessageDeliveryTimeout === 'function') {
        wsService.clearMessageDeliveryTimeout(serverId);
      }
      const senderId = await getSenderIdForMessage(serverId);
      if (senderId) {
        await wsService.sendToUser(senderId, 'msg:delivered', {
          serverId, chatId, deliveredBy: userId, deliveredAt: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[messageLifecycleSocket] msg:delivered_ack error:', err.message);
    }
  });

  // ---- client -> server: reader opened the chat ----------------------------
  socket.on('msg:read', async ({ chatId, messageIds } = {}) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    try {
      await messageDeliveryService.markRead(messageIds, userId);
      socket.to(`chat:${chatId}`).emit('msg:read', {
        chatId, readerId: userId, messageIds, readAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[messageLifecycleSocket] msg:read error:', err.message);
    }
  });

  // ---- client -> server: reconnect catch-up --------------------------------
  // This is the direct fix for the dead-letter bug: the pre-existing
  // sync:missed_messages flow sent replies that nothing on the client read.
  // msg:sync/msg:sync:result is the same idea, paired with a client that
  // actually consumes the result (see MessageLifecycleClient.js).
  socket.on('msg:sync', async ({ chats } = {}) => {
    if (!Array.isArray(chats)) return;
    for (const c of chats.slice(0, 30)) {
      try {
        const messages = await messageDeliveryService.getMissedMessages(
          userId, c.chatId, { sinceId: c.sinceId || null, sinceTimestamp: c.sinceTimestamp || null }
        );
        if (messages.length > 0) {
          socket.emit('msg:sync:result', { chatId: c.chatId, messages });
        }
      } catch (err) {
        console.warn('[messageLifecycleSocket] msg:sync error for chat', c.chatId, err.message);
      }
    }
    socket.emit('msg:sync:done', { chatCount: chats.length, at: new Date().toISOString() });
  });
}

async function pushToRecipients(wsService, message, senderId) {
  const sequelize = require('../models').sequelize;
  const chatIdInt = parseInt(message.chatId, 10);
  const senderIdInt = parseInt(senderId, 10);

  const participants = await sequelize.query(
    `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
    { replacements: { chatId: chatIdInt, senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  if (!participants || participants.length === 0) return;

  const payload = {
    serverId: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    content: message.content,
    type: message.type,
    sender: message.sender || null,
    replyToId: message.replyToId || null,
    createdAt: message.createdAt,
    sentAt: message.sentAt,
    status: 'sent',
  };

  for (const { userId: recipientId } of participants) {
    await wsService.sendToUser(recipientId, 'msg:new', payload).catch(() => {});
  }
}

async function getSenderIdForMessage(messageId) {
  const sequelize = require('../models').sequelize;
  const [row] = await sequelize.query(
    `SELECT "senderId" FROM "Messages" WHERE id = :messageId LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  return row ? row.senderId : null;
}

module.exports = { register };
