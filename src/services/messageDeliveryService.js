// =============================================================================
// messageDeliveryService.js
// -----------------------------------------------------------------------------
// MESSAGE LIFECYCLE REBUILD (messages-only scope, added 2026-07-26).
//
// This is a NEW, additive module — it does not remove or replace
// messageService.js, webSocketService.js's existing handlers, or anything
// calls/groups/games rely on. It exists purely to give the 1:1 message
// pipeline exactly one canonical, idempotent path for:
//
//   create (idempotent on clientMessageId) -> SENT
//   -> markDelivered                        -> DELIVERED
//   -> markRead                             -> READ
//   -> getMissedMessages                    (reconnect catch-up / dead-letter fix)
//
// WHY THIS EXISTS
// ----------------
// The previous pipeline had two structural gaps that explain "sometimes the
// message just doesn't show up":
//
//  1. No idempotency key. A client that resent a message after a dropped
//     connection (because it never got a server ACK) had no way to avoid
//     creating a duplicate row — so clients avoided aggressive retry, which
//     means a message that silently failed to send just... didn't send.
//     `clientMessageId` fixes this: same ID sent twice always resolves to
//     the same row.
//
//  2. The reconnect flow (`sync:missed_messages`, already implemented in
//     webSocketService.js) sends its results back as
//     `sync:missed_messages_result` — but nothing in the frontend was
//     listening for that event. Messages the server correctly held for an
//     offline recipient were fetched on reconnect and then silently
//     discarded client-side. This is fixed on the frontend side of this
//     change (MessageLifecycleClient.js), and `getMissedMessages` below is
//     the same query, exposed as a plain function so both the socket layer
//     and a REST fallback route can use it.
// =============================================================================

const { ValidationError, ForbiddenError, ServerError } = require('../utils/errors');

function getSequelize() {
  const db = require('../models');
  if (!db || !db.sequelize) throw new ServerError('Database not available');
  return db.sequelize;
}

class MessageDeliveryService {
  /**
   * FIX-RECEIVERID-GAP (msg:* lifecycle pipeline): this method used to
   * require an already-resolved `chatId` and had no concept of a
   * `receiverId` at all. That's fine for replies inside an existing
   * conversation, but every "message this person" entry point opened from
   * Friends, Calls, or Status starts with only a receiverId — there is no
   * chatId yet until a direct chat is found-or-created for that pair. The
   * REST `POST /messages` route (the path the app actually uses today) has
   * always handled this correctly; this mirrors that exact find-or-create
   * logic so the msg:* socket pipeline (messageLifecycleSocket.js's
   * `msg:send`) can resolve a receiver the same way instead of failing /
   * parseInt(undefined)-ing into NaN and silently dropping the send.
   */
  async resolveOrCreateDirectChat(senderId, receiverId) {
    // FIX (CONSOLIDATE-DIRECT-CHAT-RESOLUTION): this used to be a second,
    // independent reimplementation of the exact same find-or-create-direct-
    // chat-with-advisory-lock logic that chats.js's POST /start route (and
    // now POST /bootstrap) already had — see the long comment there. Having
    // two hand-maintained copies is exactly the drift that already caused a
    // real bug once (a fix landing in one copy and not the other). Both now
    // delegate to the single shared implementation in directChatResolver.js.
    // Signature and return shape here are unchanged — just a plain numeric
    // chatId — so nothing calling this method needs to change.
    const { resolveOrCreateDirectChat: _sharedResolve } = require('./directChatResolver');
    try {
      const result = await _sharedResolve({ userId: senderId, otherUserId: receiverId });
      return result.chat.id;
    } catch (err) {
      if (err.message === 'Invalid userId') throw new ValidationError('Invalid senderId');
      if (err.message === 'Invalid otherUserId') throw new ValidationError('Invalid receiverId');
      if (err.message === 'Cannot message yourself') throw new ValidationError('Cannot message yourself');
      if (err.message === 'Receiver not found') throw new ValidationError('Receiver not found');
      // FIX (ENFORCE-BLOCK-ON-CONVERSATION-CREATION): surface the shared
      // resolver's block check as a 403-shaped error instead of a generic
      // ValidationError/500, so callers (REST route, msg:send socket
      // handler) can distinguish "you can't message this person" from a
      // plain bad-request.
      if (err.code === 'USER_BLOCKED') {
        const blockedErr = new ValidationError(err.message);
        blockedErr.status = 403;
        blockedErr.code = 'USER_BLOCKED';
        throw blockedErr;
      }
      throw err;
    }
  }

  /**
   * Create a message idempotently. If clientMessageId was already used by
   * this sender, returns the existing row instead of creating a new one —
   * this is what makes client-side retry/resend safe.
   *
   * FIX-RECEIVERID-GAP: `chatId` is no longer strictly required up front —
   * pass `receiverId` instead when this is a brand-new/pending conversation
   * (opened from Friends/Calls/Status before any chatId exists) and this
   * method resolves/creates the real chat first, same as the REST path.
   *
   * CONSOLIDATE-MESSAGE-PROTOCOL (point 1 of the messaging-architecture
   * cleanup): `metadata` and `expiresAt` were added so this is the ONE
   * INSERT path for every caller, including the feature-rich REST
   * `POST /messages` route (link previews, disappearing-message timers,
   * arbitrary client metadata) — that route used to run its own,
   * independent INSERT with a slightly different column set instead of
   * calling this. Optional and additive: existing callers that don't pass
   * these fields behave exactly as before.
   */
  async sendMessage({ chatId, receiverId = null, senderId, content, type = 'text', clientMessageId, replyToId = null, metadata = null, expiresAt = null }) {
    const sequelize = getSequelize();

    // FIX-STALE-CHAT-ID (identity-resolution consolidation): previously,
    // whenever a chatId was already present in the payload it was trusted
    // unconditionally and receiverId was only consulted when chatId was
    // completely absent. That is unsafe: a client can hold a stale/incorrect
    // chatId (e.g. a cached pending-conversation id that got reused, or a
    // chatId for a different, previously-opened conversation) alongside a
    // perfectly correct receiverId for who the user actually meant to
    // message. In that situation the stale chatId silently won and the
    // message could be written into the wrong conversation. When BOTH are
    // supplied, verify the given chatId actually is the direct chat between
    // (senderId, receiverId); if it isn't (or the check can't confirm it),
    // fall back to the canonical resolver instead of trusting the chatId
    // blindly. When only one of the two is supplied, behavior is unchanged.
    if (chatId && receiverId) {
      const chatIdIntCheck = parseInt(chatId, 10);
      const receiverIdIntCheck = parseInt(receiverId, 10);
      const senderIdIntCheck = parseInt(senderId, 10);
      const [match] = await sequelize.query(
        `SELECT c.id FROM chats c
         WHERE c.id = :chatId AND c.type = 'direct'
           AND EXISTS (SELECT 1 FROM chat_participants WHERE "chatId" = c.id AND "userId" = :senderId)
           AND EXISTS (SELECT 1 FROM chat_participants WHERE "chatId" = c.id AND "userId" = :receiverId)
         LIMIT 1`,
        { replacements: { chatId: chatIdIntCheck, senderId: senderIdIntCheck, receiverId: receiverIdIntCheck }, type: sequelize.QueryTypes.SELECT }
      ).catch(() => [null]);
      if (!match) {
        chatId = await this.resolveOrCreateDirectChat(senderId, receiverId);
      }
    } else if (!chatId && receiverId) {
      chatId = await this.resolveOrCreateDirectChat(senderId, receiverId);
    }

    if (!chatId || !senderId) throw new ValidationError('chatId (or receiverId) and senderId are required');
    if (!clientMessageId) throw new ValidationError('clientMessageId is required for idempotent send');
    const sanitizedContent = content ? String(content).trim().substring(0, 5000) : '';
    if (type === 'text' && !sanitizedContent) throw new ValidationError('Content cannot be empty for text messages');

    const chatIdInt = parseInt(chatId, 10);
    const senderIdInt = parseInt(senderId, 10);

    // Idempotency check FIRST — if this exact (sender, clientMessageId) pair
    // already produced a message, return it rather than inserting again.
    //
    // FIX-DUAL-IDEMPOTENCY-SYSTEMS: also check metadata->>'localId' — the
    // key the REST POST /messages route's idempotency check uses — so a
    // retry that happens to go out over the OTHER transport (REST vs this
    // socket path) with the same underlying id is still recognized as a
    // duplicate instead of creating a second row. See the matching fix in
    // routes/messages.js for the reverse direction.
    const [existing] = await sequelize.query(
      `SELECT * FROM "Messages" WHERE "senderId" = :senderId
         AND ("clientMessageId" = :clientMessageId OR metadata->>'localId' = :clientMessageId) LIMIT 1`,
      { replacements: { senderId: senderIdInt, clientMessageId }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [null]);

    if (existing) {
      return { message: existing, alreadyExisted: true };
    }

    // Confirm sender is actually a participant (same guard messageService.js uses).
    const [participant] = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :senderId LIMIT 1`,
      { replacements: { chatId: chatIdInt, senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [null]);
    if (!participant) throw new ValidationError('Sender is not a participant in this chat');

    // FIX (ENFORCE-BLOCK-ON-CONVERSATION-CREATION, part 2): the check inside
    // resolveOrCreateDirectChat() only runs when THIS call needed to
    // resolve/create the chat. A reply into an already-existing direct chat
    // skips that path entirely — chatId is already known and valid. Without
    // a check here, a user who gets blocked mid-conversation could still
    // send further messages into that same chat. See
    // directChatResolver.assertDirectChatNotBlocked's doc comment for why
    // this is a shared helper rather than a third copy of this check.
    try {
      await require('./directChatResolver').assertDirectChatNotBlocked(senderIdInt, chatIdInt);
    } catch (blockErr) {
      if (blockErr.code === 'USER_BLOCKED') {
        const forbidden = new ForbiddenError(blockErr.message);
        forbidden.code = 'USER_BLOCKED';
        throw forbidden;
      }
      throw blockErr;
    }

    // FIX-DUAL-IDEMPOTENCY-SYSTEMS: also store the id under metadata.localId
    // (the shape the REST idempotency check and some frontend read paths
    // expect), not just in the clientMessageId column, so a message created
    // here is recognizable by either system. Callers (e.g. POST /messages)
    // can pass their own richer metadata (linkPreview, poll data, etc.) —
    // localId is merged in without clobbering it.
    const mergedMetadata = { ...(metadata && typeof metadata === 'object' ? metadata : {}), localId: clientMessageId };

    let rows;
    try {
      [rows] = await sequelize.query(
        `INSERT INTO "Messages"
           ("chatId","senderId",content,type,reactions,metadata,"isEdited","isDeleted","replyToId",
            "clientMessageId","expiresAt","status","deliveryAttempts","sentAt","deliveredAt","createdAt","updatedAt")
         VALUES (:chatId,:senderId,:content,:type,'{}',:metadata,false,false,:replyToId,
                 :clientMessageId,:expiresAt,'sent',0,NOW(),NULL,NOW(),NOW())
         RETURNING *`,
        {
          replacements: {
            chatId: chatIdInt, senderId: senderIdInt, content: sanitizedContent, type,
            replyToId: replyToId || null, clientMessageId, metadata: JSON.stringify(mergedMetadata),
            expiresAt: expiresAt || null,
          },
          type: sequelize.QueryTypes.INSERT,
        }
      );
    } catch (insertErr) {
      // FIX-DUAL-IDEMPOTENCY-SYSTEMS: the pre-check above is a plain SELECT
      // with no atomic guarantee — two near-simultaneous identical retries
      // (e.g. one over REST, one over the msg:* socket, for the same
      // logical send) could both pass it before either INSERT commits. The
      // real unique index on (senderId, clientMessageId) is the atomic
      // backstop; treat that specific failure as "already sent" instead of
      // surfacing a 500 for what is actually a successful duplicate send.
      const isUniqueViolation = insertErr && (insertErr.name === 'SequelizeUniqueConstraintError' || /duplicate key value/i.test(insertErr.message || ''));
      if (isUniqueViolation) {
        const [dup] = await sequelize.query(
          `SELECT * FROM "Messages" WHERE "senderId" = :senderId AND "clientMessageId" = :clientMessageId LIMIT 1`,
          { replacements: { senderId: senderIdInt, clientMessageId }, type: sequelize.QueryTypes.SELECT }
        ).catch(() => [null]);
        if (dup) return { message: dup, alreadyExisted: true };
      }
      throw insertErr;
    }

    if (!rows || !rows[0] || !rows[0].id) {
      throw new ServerError('Failed to create message - database returned invalid data');
    }

    const message = rows[0];

    await sequelize.query(
      `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :mid, "lastMessageAt" = NOW() WHERE id = :chatId`,
      { replacements: { mid: message.id, chatId: chatIdInt } }
    ).catch(() => {});

    const [sender] = await sequelize.query(
      `SELECT id, username, avatar, "firstName", "lastName" FROM "Users" WHERE id = :senderId`,
      { replacements: { senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [null]);
    message.sender = sender || null;

    return { message, alreadyExisted: false };
  }

  /**
   * FIX (UNREAD-COUNT-DUAL-SYSTEM): traced the actual "mark as read"
   * write path used by the live app (messages-core.operations.js's
   * markAsRead(), called when a conversation is opened) and found it only
   * ever calls POST /messages/mark-read/batch, which inserts rows into the
   * "ReadReceipts" table. It never touches Messages.isRead — the only
   * things that ever wrote isRead=true are routes/chats.js's POST
   * /:chatId/read route and this class's own markRead() (both dead code:
   * neither is ever called by the live frontend, and markRead()'s only
   * caller, messageLifecycleSocket.js, was already removed from
   * webSocketService.js's socket registration). Meanwhile GET /chats (the
   * route that actually populates the conversation-list unread badges via
   * ChatManager.fetchConversations()) computed unreadCount from
   * Messages.isRead — a column the live read flow never updates. Net
   * effect, verified end to end: a user reads a conversation, the local
   * badge clears optimistically, but the very next full conversation-list
   * refetch (reload, reopen, another device) shows it unread again,
   * because the server-side count never actually changed.
   *
   * This is now the one canonical "how many of this chat's messages has
   * this user not yet read" query — the same ReadReceipts-based logic
   * routes/messages.js's GET /unread-counts already used correctly — so
   * every caller (the per-chat list computation and the aggregate-counts
   * route) reads from the same source the live mark-as-read path writes
   * to.
   */
  async getUnreadCountForChat(chatId, userId) {
    const sequelize = getSequelize();
    const [row] = await sequelize.query(
      `SELECT COUNT(*)::int AS count
       FROM "Messages" m
       LEFT JOIN "ReadReceipts" rr
         ON rr."messageId" = m.id AND rr."userId" = :userId
       WHERE m."chatId" = :chatId
         AND m."senderId" != :userId
         AND m."isDeleted" = false
         AND rr.id IS NULL`,
      { replacements: { chatId: parseInt(chatId, 10), userId: parseInt(userId, 10) }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [{ count: 0 }]);
    return (row && row.count) || 0;
  }

  /**
   * FIX (STRUCTURE-MISSING-MESSAGE-NOTIFICATIONS): traced every live path
   * that creates a message and found the "tell the recipient a message
   * arrived" step was inconsistent and, in one case, entirely missing —
   * exactly the kind of unstructured gap worth fixing properly rather than
   * leaving as a known-missing feature:
   *   - routes/messages.js's POST '/' route had its own inline, one-off
   *     block that did ONLY an OS-level push notification
   *     (pushNotificationService.notifyNewMessage), and only for
   *     recipients not reached over an active socket. It never persisted
   *     anything to the "Notifications" table.
   *   - The 'message:send' socket handler in webSocketService.js (kept for
   *     older clients) had NO notification logic at all — not push, not
   *     in-app. A message sent by a legacy client generated zero
   *     notification for a recipient who wasn't actively online.
   *   - notificationService.createFromTemplate('new_message', ...) already
   *     exists, is fully built (respects the recipient's per-category
   *     notification preference and preview-privacy setting, persists a
   *     row, and pushes a realtime 'notification' event) — but had zero
   *     callers anywhere in the codebase.
   * Rather than hand-write "look up sender info, build a payload, notify"
   * a third time for the socket path, this is the one shared
   * implementation both real message-creation paths call. It does not
   * replace routes/messages.js's existing push-notification retry logic
   * (which also handles a "zombie socket" timeout retry this method knows
   * nothing about) — that stays as-is; this only adds the previously
   * entirely-absent in-app Notification persistence there, and supplies
   * BOTH the in-app and push pieces for the socket path, which had
   * neither.
   *
   * @param {object} message - the created message row (id, chatId, senderId, content, type)
   * @param {number[]} recipientIds - every other participant in the chat
   * @param {object} [opts]
   * @param {boolean} [opts.push=true] - also send an OS-level push notification
   * @param {number[]|null} [opts.offlineRecipientIds=null] - if provided (and
   *   opts.push is true), only these recipients get the OS push, matching
   *   the existing "don't push-notify someone already looking at their
   *   phone with a live socket connection" behavior. If null, all
   *   recipientIds are treated as needing a push.
   */
  async notifyMessageRecipients(message, recipientIds, opts = {}) {
    if (!recipientIds || recipientIds.length === 0) return;
    const { push = true, offlineRecipientIds = null } = opts;
    const sequelize = getSequelize();
    const notificationService = require('./notificationService');

    const [senderRow] = await sequelize.query(
      `SELECT username, avatar FROM "Users" WHERE id = :id LIMIT 1`,
      { replacements: { id: parseInt(message.senderId, 10) }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [null]);
    const senderName = senderRow?.username || 'Someone';
    const senderAvatar = senderRow?.avatar || null;
    const preview = (message.type === 'text' || !message.type)
      ? String(message.content || '').slice(0, 100)
      : `Sent a ${message.type}`;

    const offlineSet = (push && offlineRecipientIds)
      ? new Set(offlineRecipientIds.map(id => parseInt(id, 10)))
      : null;

    await Promise.allSettled(recipientIds.map(async (rawRecipientId) => {
      const recipientId = parseInt(rawRecipientId, 10);
      if (!recipientId) return;

      // In-app Notification row + realtime 'notification' push. Every
      // recipient, regardless of online/offline — a recipient can be
      // online but viewing a different chat entirely (or no chat), and
      // still needs this. createFromTemplate is itself a no-op if the
      // recipient has turned message notifications off in settings.
      await notificationService.createFromTemplate(recipientId, 'new_message', {
        senderName,
        senderAvatar,
        messagePreview: preview,
        chatId: message.chatId,
        messageId: message.id,
      }).catch(() => {});

      if (push && (!offlineSet || offlineSet.has(recipientId))) {
        const pushNotificationService = require('./pushNotificationService');
        await pushNotificationService.notifyNewMessage(recipientId, {
          senderName, senderAvatar, content: preview,
          chatId: message.chatId, messageId: message.id,
        }, sequelize).catch(() => {});
      }
    }));
  }

  /** Recipient's client confirms it actually stored the message locally. */
  async markDelivered(messageId, userId) {
    const sequelize = getSequelize();
    await sequelize.query(
      `UPDATE "Messages" SET "deliveredAt" = NOW(), status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END
       WHERE id = :messageId AND "deliveredAt" IS NULL`,
      { replacements: { messageId } }
    );
    await sequelize.query(
      `INSERT INTO message_delivery_logs ("messageId","userId","chatId","event","createdAt")
       SELECT :messageId, :userId, "chatId", 'delivered', NOW() FROM "Messages" WHERE id = :messageId
       ON CONFLICT ("messageId","userId","event") DO NOTHING`,
      { replacements: { messageId, userId } }
    ).catch(() => {});
  }

  /** Recipient opened the chat / read the message. */
  async markRead(messageIds, userId) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const sequelize = getSequelize();
    await sequelize.query(
      `UPDATE "Messages" SET "isRead" = true, "readAt" = NOW(), status = 'read'
       WHERE id = ANY(:messageIds::int[])`,
      { replacements: { messageIds: messageIds.map(Number) } }
    );
  }

  /**
   * Reconnect / cold-start catch-up: every message in `chatId` created after
   * `sinceId` (preferred) or `sinceTimestamp`, so a client that missed a
   * live socket push while offline/reconnecting always has a second,
   * server-authoritative way to get it. This is the query that plugs the
   * "sync:missed_messages_result had no listener" gap on the frontend.
   */
  async getMissedMessages(userId, chatId, { sinceId = null, sinceTimestamp = null, limit = 100 } = {}) {
    const sequelize = getSequelize();
    const chatIdInt = parseInt(chatId, 10);
    const userIdInt = parseInt(userId, 10);

    const [participant] = await sequelize.query(
      `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
      { replacements: { chatId: chatIdInt, userId: userIdInt }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => [null]);
    if (!participant) throw new ValidationError('User is not a participant in this chat');

    const conditions = [`m."chatId" = :chatId`, `m."isDeleted" = false`];
    const replacements = { chatId: chatIdInt, limit: Math.min(limit, 200) };

    if (sinceId) {
      conditions.push(`m.id > :sinceId`);
      replacements.sinceId = parseInt(sinceId, 10);
    } else if (sinceTimestamp) {
      conditions.push(`m."createdAt" > :sinceTimestamp`);
      replacements.sinceTimestamp = new Date(sinceTimestamp);
    }

    const messages = await sequelize.query(
      `SELECT m.*, u.username AS "senderUsername", u.avatar AS "senderAvatar"
       FROM "Messages" m
       LEFT JOIN "Users" u ON u.id = m."senderId"
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.id ASC
       LIMIT :limit`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    ).catch(() => []);

    return messages || [];
  }
}

module.exports = new MessageDeliveryService();
