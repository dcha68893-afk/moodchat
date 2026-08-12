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

const { ValidationError, ServerError } = require('../utils/errors');

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
