'use strict';

// DELETE-CHAT / CLEAR-CHAT REBUILD
// -----------------------------------------------------------------------------
// Root cause being fixed: "Delete chat" (routes/chats.js DELETE /:chatId) used
// to flip the SHARED `chats.isActive` flag to false. Because that column
// lives on the conversation row itself, not on a per-participant row, one
// side deleting a direct chat made it disappear for BOTH sides, and even
// broadcast a 'chat:deleted' socket event to the other participant. There was
// also no "clear chat" (wipe my own history, keep the conversation) concept
// at all.
//
// Fix: store per-user chat state on chat_participants (same table that
// already holds isMuted/isPinned — this is that same established pattern),
// so a participant's own row can be flagged without touching the shared
// conversation row or the other participant's row.
//   - hiddenAt:  this user removed the chat from their own list ("Delete
//                chat"). NULL = visible. The chat automatically reappears in
//                their list once chats."lastMessageAt" moves past hiddenAt —
//                i.e. the other person sending a new message un-hides it,
//                same behavior WhatsApp/Signal describe.
//   - clearedAt: this user wiped their own message history ("Clear chat").
//                Messages created at/before clearedAt are hidden from this
//                user's message list only; the conversation itself stays in
//                their chat list.
module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('chat_participants');

    if (!cols.hiddenAt) {
      await queryInterface.addColumn('chat_participants', 'hiddenAt', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '"Delete chat" — set when this participant removes the conversation from their own chat list. Cleared automatically once a newer message arrives.',
      });
    }

    if (!cols.clearedAt) {
      await queryInterface.addColumn('chat_participants', 'clearedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '"Clear chat" — messages created at/before this timestamp are hidden from this participant only.',
      });
    }

    // Supports the getUserChats filter (WHERE hiddenAt IS NULL OR lastMessageAt > hiddenAt)
    const indexes = await queryInterface.showIndex('chat_participants').catch(() => []);
    const hasHiddenIdx = indexes.some((i) => i.name === 'idx_chat_participants_hidden_at');
    if (!hasHiddenIdx) {
      await queryInterface.addIndex('chat_participants', ['userId', 'hiddenAt'], {
        name: 'idx_chat_participants_hidden_at',
      }).catch(() => {});
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('chat_participants', 'idx_chat_participants_hidden_at').catch(() => {});
    await queryInterface.removeColumn('chat_participants', 'hiddenAt').catch(() => {});
    await queryInterface.removeColumn('chat_participants', 'clearedAt').catch(() => {});
  },
};
