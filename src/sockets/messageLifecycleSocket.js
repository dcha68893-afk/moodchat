// =============================================================================
// Canonical 1:1 message lifecycle socket.
// One send -> one canonical msg:new -> receiver persists -> msg:delivered_ack.
// Read receipts remain separate from delivery receipts.
//
// WIRING STATUS (verified against the live call graph, not assumed):
//   - pushToRecipients() below IS live — the legacy socket 'message:send'
//     handler in webSocketService.js requires and calls it directly for its
//     participant lookup + the single 'msg:new' emit, independent of
//     register(). So msg:new does reach clients today.
//   - register() itself is NOT currently called anywhere — grep the repo
//     for `messageLifecycleSocket.register(` and there's no live call site
//     (webSocketService.js's connection handler has a "REMOVED
//     (consolidation pass)" comment where it used to call this, taken out
//     after a double-ack bug traced to both this pipeline and the legacy
//     message:* pipeline independently acking the same message). That
//     means socket.on('msg:send'/'msg:delivered_ack'/'msg:read'/'msg:sync')
//     in this file never fire — in particular, the frontend's
//     MessageLifecycleClient.js unconditionally emits 'msg:delivered_ack'
//     on every message it receives, and nothing on this server is
//     listening for it: that ack currently goes nowhere, so senders never
//     get an 'msg:delivered' receipt through this path even though the
//     message itself was delivered and displayed. Re-enabling register()
//     fixes that, but needs to first confirm the legacy message:* ack path
//     stands down for anything this module already handled — that's a
//     webSocketService.js change, outside this file.
// =============================================================================
const messageDeliveryService = require('../services/messageDeliveryService');

function trace(serverId, stage, extra) {
  try { console.log(`[MsgLifecycle][${serverId != null ? serverId : '?'}][server] ${stage}`, extra || ''); } catch (_) {}
}

function register(wsService, socket, userId) {
  if (socket.__msgLifecycleBound) return;
  socket.__msgLifecycleBound = true;

  socket.on('msg:send', async (payload = {}, cb) => {
    const { chatId, receiverId, content, type, clientMessageId, replyToId } = payload;
    try {
      if (!clientMessageId) return fail(socket, cb, clientMessageId, 'clientMessageId is required');
      if (!chatId && !receiverId) return fail(socket, cb, clientMessageId, 'chatId or receiverId is required');

      const { message, alreadyExisted } = await messageDeliveryService.sendMessage({
        chatId, receiverId, senderId: userId, content, type, clientMessageId, replyToId,
      });

      const ack = {
        clientMessageId,
        serverId: message.id,
        chatId: message.chatId,
        status: message.status || 'sent',
        sentAt: message.sentAt || message.createdAt,
        alreadyExisted: !!alreadyExisted,
      };
      socket.emit('msg:send:ack', ack);
      if (typeof cb === 'function') cb({ ok: true, ...ack });

      // Idempotent retry: the original recipient push already happened.
      if (alreadyExisted) return;
      await pushToRecipients(wsService, message, userId);
    } catch (err) {
      fail(socket, cb, clientMessageId, err.message);
    }
  });

  socket.on('msg:delivered_ack', async ({ serverId, chatId } = {}) => {
    if (!serverId) return;
    trace(serverId, 'DELIVERED_ACK_RECEIVED', { chatId, ackedBy: userId });
    try {
      await messageDeliveryService.markDelivered(serverId, userId);
      if (typeof wsService.clearMessageDeliveryTimeout === 'function') {
        wsService.clearMessageDeliveryTimeout(serverId);
      }
      const senderId = await getSenderIdForMessage(serverId);
      if (senderId) {
        await wsService.sendToUser(senderId, 'msg:delivered', {
          serverId, chatId, deliveredBy: userId, deliveredAt: new Date().toISOString(),
        }).catch(() => {});
        trace(serverId, 'DELIVERED_NOTIFIED_SENDER', { senderId });
      } else {
        trace(serverId, 'DELIVERED_SENDER_LOOKUP_FAILED');
      }
    } catch (err) {
      trace(serverId, 'DELIVERED_ACK_ERROR', { error: err.message });
      console.warn('[messageLifecycleSocket] msg:delivered_ack error:', err.message);
    }
  });

  socket.on('msg:read', async ({ chatId, messageIds } = {}) => {
    if (!Array.isArray(messageIds) || !messageIds.length) return;
    try {
      await messageDeliveryService.markRead(messageIds, userId);
      socket.to(`chat:${chatId}`).emit('msg:read', {
        chatId, readerId: userId, messageIds, readAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[messageLifecycleSocket] msg:read error:', err.message);
    }
  });

  socket.on('msg:sync', async ({ chats } = {}) => {
    if (!Array.isArray(chats)) return;
    for (const c of chats.slice(0, 30)) {
      try {
        const messages = await messageDeliveryService.getMissedMessages(userId, c.chatId, {
          sinceId: c.sinceId || null,
          sinceTimestamp: c.sinceTimestamp || null,
        });
        if (messages.length) socket.emit('msg:sync:result', { chatId: c.chatId, messages });
      } catch (err) {
        console.warn('[messageLifecycleSocket] msg:sync error for chat', c.chatId, err.message);
      }
    }
    socket.emit('msg:sync:done', { chatCount: chats.length, at: new Date().toISOString() });
  });
}

function fail(socket, cb, clientMessageId, error) {
  socket.emit('msg:send:error', { clientMessageId, error });
  if (typeof cb === 'function') cb({ ok: false, error });
}

async function pushToRecipients(wsService, message, senderId) {
  const sequelize = require('../models').sequelize;
  const participants = await sequelize.query(
    `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
    { replacements: { chatId: parseInt(message.chatId, 10), senderId: parseInt(senderId, 10) }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);

  const payload = {
    serverId: message.id,
    chatId: message.chatId,
    conversationId: message.chatId,
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
    // Exactly one canonical realtime event. Do not also emit message:new here;
    // that legacy event is handled by a different relay stack and was the
    // source of duplicate packets observed in the browser network trace.
    await wsService.sendToUser(recipientId, 'msg:new', payload).catch(() => {});
    trace(message.id, 'PUSHED_MSG_NEW', { recipientId });
  }
  return { recipients: participants.map(p => p.userId), payload };
}

async function getSenderIdForMessage(messageId) {
  const sequelize = require('../models').sequelize;
  const [row] = await sequelize.query(
    `SELECT "senderId" FROM "Messages" WHERE id = :messageId LIMIT 1`,
    { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  return row ? row.senderId : null;
}

module.exports = { register, pushToRecipients };
