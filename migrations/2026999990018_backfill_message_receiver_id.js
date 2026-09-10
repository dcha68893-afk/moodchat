'use strict';
/**
 * Migration: backfill Messages.receiverId for existing direct-chat rows
 *
 * ROOT-CAUSE FIX (SENT-MESSAGE-UNDECRYPTABLE-AFTER-RELOAD — data backfill):
 * src/services/messageDeliveryService.js's sendMessage() — the single INSERT
 * path for every message in this app — never included receiverId in its
 * INSERT column list, so every message row ever created for an ongoing
 * (already-existing) direct conversation was persisted with receiverId =
 * NULL (see the FIX comment added alongside this migration in that file for
 * the full trace). That INSERT is now fixed for every message sent from
 * this point forward, but this migration is what fixes it for every message
 * already sitting in the database — without it, every conversation that
 * existed before this fix ships would keep showing "Unable to decrypt this
 * message" on the sender's own historical messages forever, since the
 * client-side decrypt path (js/message-e2e-core.js's peerFor()) needs
 * receiverId (or a live in-memory fallback that isn't always available) to
 * know which key pair to re-derive the shared secret with.
 *
 * Direct chats only have two participants, so "the receiver of a message is
 * the OTHER participant in that message's chat" is unambiguous and safe to
 * backfill in bulk with a single set-based UPDATE. Group chats are left
 * untouched — receiverId legitimately has no single value there.
 *
 * Idempotent: only ever touches rows where receiverId IS NULL, so running
 * this more than once (or after the INSERT fix is already live) is a no-op
 * on anything it already fixed.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 * ROLLBACK:   not reversible (the original NULL values carried no
 *             information worth restoring) — down() is a no-op.
 */

module.exports = {
  async up(queryInterface) {
    const [result] = await queryInterface.sequelize.query(`
      UPDATE "Messages" m
         SET "receiverId" = cp."userId"
        FROM chat_participants cp
        JOIN chats c ON c.id = cp."chatId"
       WHERE c.type = 'direct'
         AND cp."chatId" = m."chatId"
         AND cp."userId" != m."senderId"
         AND m."receiverId" IS NULL
    `).catch((err) => {
      console.error('[migration backfill_message_receiver_id] failed:', err.message);
      return [null];
    });
    console.log('[migration backfill_message_receiver_id] backfilled rows:', result && result.rowCount);
  },

  async down() {
    // Not reversible — see header comment. Leaving the backfilled values in
    // place on rollback is strictly safer than re-nulling working data.
  },
};
