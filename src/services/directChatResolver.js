// =============================================================================
// directChatResolver.js
// -----------------------------------------------------------------------------
// FIX (CONSOLIDATE-DIRECT-CHAT-RESOLUTION): this app had TWO independent,
// hand-written implementations of "find the existing direct chat between
// these two users, or create one if none exists" — src/routes/chats.js's
// resolveOrCreateDirectChat() (used by POST /start and POST /bootstrap, the
// endpoint every non-history "Open Chat" entry point calls in the
// background) and src/services/messageDeliveryService.js's own copy (used
// by the direct-send path: POST /messages with only a receiverId, and the
// msg:send socket handler). Both were correct as of this writing — both use
// a Postgres advisory lock keyed to the (min, max) user-id pair so two
// near-simultaneous first-messages between the same two people can't create
// two separate chat rows, and both correctly find-and-reactivate an
// existing/soft-deleted chat before ever creating a new one. But two
// separate copies of the same lock-and-resolve logic is exactly the kind of
// drift that has already caused real bugs in this codebase before (see the
// FIX-DUPLICATE-CHAT-RACE comment history) — a future fix applied to one
// copy and not the other silently reopens the same class of bug. This
// module is the single canonical implementation; both callers now delegate
// to it instead of maintaining their own copy.
//
// Kept deliberately free of any caller-specific side effects (like emitting
// a 'chat:created' socket event) — that stays the responsibility of each
// caller, since messageDeliveryService.js's callers don't want/need it and
// chats.js's callers need it shaped with request-specific data (the
// requesting user's own display info) that doesn't belong in a shared
// resolver.
// =============================================================================

async function resolveOrCreateDirectChat({ userId, otherUserId, otherUser = null }) {
  const db = require('../models');
  const sequelize = db.sequelize;
  const { Chat, ChatParticipant, User } = db;

  const _uidNum = parseInt(userId, 10);
  const _otherNum = parseInt(otherUserId, 10);
  if (!_uidNum) throw new Error('Invalid userId');
  if (!_otherNum) throw new Error('Invalid otherUserId');
  if (_uidNum === _otherNum) throw new Error('Cannot message yourself');

  // FIX (ENFORCE-BLOCK-ON-CONVERSATION-CREATION): traced the actual blocking
  // enforcement in this codebase (per the no-guessing rule — don't trust the
  // "no friend-status gate... see _canSeeEncryptionKey for the one remaining
  // restriction" comment in routes/chats.js at face value). It only denies
  // E2E public-key visibility between blocked users; it does NOT stop this
  // resolver from creating/reactivating a direct chat, nor does it stop
  // messageDeliveryService.sendMessage() from inserting a plaintext message
  // into that chat. Net effect, verified end to end: a blocked user could
  // still open a conversation with the user who blocked them and send them
  // messages. This is the single chokepoint both live "open/create a direct
  // chat" callers (messageDeliveryService.resolveOrCreateDirectChat and, via
  // the routes/chats.js consolidation below, POST /start and POST
  // /bootstrap) go through, so the check belongs here rather than
  // duplicated per caller.
  const { isBlocked } = require('./friendService');
  if (await isBlocked(_uidNum, _otherNum)) {
    const blockedErr = new Error('Messaging is not available between these users');
    blockedErr.code = 'USER_BLOCKED';
    throw blockedErr;
  }

  // Some callers (messageDeliveryService.js) only ever had a bare
  // receiverId, never the full user record — resolve it here so both
  // callers get a validated "receiver actually exists" check and, when
  // needed, the display fields for a chat:created payload.
  let _otherUserRecord = otherUser;
  if (!_otherUserRecord) {
    _otherUserRecord = await User.findByPk(_otherNum, {
      attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status']
    });
    if (!_otherUserRecord) throw new Error('Receiver not found');
  }

  const _lockA = Math.min(_uidNum, _otherNum);
  const _lockB = Math.max(_uidNum, _otherNum);

  const t = await sequelize.transaction();
  try {
    await sequelize.query(
      'SELECT pg_advisory_xact_lock(:a, :b)',
      { replacements: { a: _lockA, b: _lockB }, transaction: t }
    );

    // Re-check now that we hold the lock — a concurrent request for this
    // exact pair may have committed its own chat while we were waiting.
    const existingParticipant1 = await ChatParticipant.findAll({
      where: { userId: _uidNum }, attributes: ['chatId'], transaction: t
    });
    const existingParticipant2 = await ChatParticipant.findAll({
      where: { userId: _otherNum }, attributes: ['chatId'], transaction: t
    });

    const userChatIds = new Set(existingParticipant1.map(p => p.chatId));
    const otherChatIds = new Set(existingParticipant2.map(p => p.chatId));

    // Sorted so the pick is deterministic if more than one shared chat
    // somehow exists (legacy data, etc.) — always the same one, every call.
    const commonChatIds = [...userChatIds]
      .filter(id => otherChatIds.has(id))
      .sort((a, b) => a - b);

    if (commonChatIds.length > 0) {
      for (const chatId of commonChatIds) {
        const chat = await Chat.findByPk(chatId, { transaction: t });
        if (chat && chat.type === 'direct') {
          if (chat.isActive === false) {
            await chat.update({ isActive: true, deletedAt: null, deletedBy: null }, { transaction: t });
          }
          await t.commit();
          return { chat, isNew: false, otherUser: _otherUserRecord };
        }
      }
    }

    const newChat = await Chat.create({
      type: 'direct',
      createdBy: _uidNum,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }, { transaction: t });

    await ChatParticipant.bulkCreate([
      { chatId: newChat.id, userId: _uidNum, joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { chatId: newChat.id, userId: _otherNum, joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() }
    ], { transaction: t });

    await t.commit();
    return { chat: newChat, isNew: true, otherUser: _otherUserRecord };
  } catch (lockedSectionError) {
    try { await t.rollback(); } catch (_) {}
    throw lockedSectionError;
  }
}

/**
 * FIX (ENFORCE-BLOCK-ON-CONVERSATION-CREATION, part 2): the block check
 * inside resolveOrCreateDirectChat() only runs on the "resolve/create a
 * chat for this pair" path. It is NOT called by every place a message
 * actually gets inserted — verified by tracing all three live message-write
 * paths in this codebase: messageDeliveryService.sendMessage() (used by the
 * msg:send / legacy message:send socket handlers), and routes/messages.js's
 * POST '/' handler, which runs its own independent raw-SQL INSERT once a
 * chatId is already known (the common "reply in an existing conversation"
 * case) and never calls resolveOrCreateDirectChat() at all in that branch.
 * Rather than re-implement "look up the other participant of this direct
 * chat, then check isBlocked" a third time in routes/messages.js, that
 * check is extracted here once and both real write paths call it.
 * No-op (returns without throwing) for group chats — blocking there is a
 * membership/moderation concern (see GroupMembers.isBlocked), not this
 * direct-message block relationship.
 */
async function assertDirectChatNotBlocked(senderId, chatId) {
  const db = require('../models');
  const sequelize = db.sequelize;
  const { isBlocked } = require('./friendService');

  const senderIdInt = parseInt(senderId, 10);
  const chatIdInt = parseInt(chatId, 10);

  const [chatRow] = await sequelize.query(
    `SELECT type FROM chats WHERE id = :chatId LIMIT 1`,
    { replacements: { chatId: chatIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  if (!chatRow || chatRow.type !== 'direct') return;

  const [otherParticipant] = await sequelize.query(
    `SELECT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId LIMIT 1`,
    { replacements: { chatId: chatIdInt, senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
  ).catch(() => [null]);
  if (!otherParticipant) return;

  if (await isBlocked(senderIdInt, otherParticipant.userId)) {
    const blockedErr = new Error('Messaging is not available between these users');
    blockedErr.code = 'USER_BLOCKED';
    throw blockedErr;
  }
}

module.exports = { resolveOrCreateDirectChat, assertDirectChatNotBlocked };
