'use strict';

/**
 * Final convergence pass for the direct-chat schema.
 *
 * This does not replace the normal migrations. It exists because this project
 * has historically had both Sequelize migrations and runtime schema repair,
 * so a migration can be recorded as complete while a partial/older database
 * is still missing one of the columns or indexes required by the live chat
 * code. The pass is additive only: it never drops or rewrites existing data.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const describe = (table) => queryInterface.describeTable(table).catch(() => null);

    const participants = await describe('chat_participants');
    if (participants) {
      if (!participants.hiddenAt) {
        await queryInterface.addColumn('chat_participants', 'hiddenAt', {
          type: Sequelize.DATE,
          allowNull: true,
        });
      }
      if (!participants.clearedAt) {
        await queryInterface.addColumn('chat_participants', 'clearedAt', {
          type: Sequelize.DATE,
          allowNull: true,
        });
      }
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_participants_hidden_at
        ON "chat_participants" ("userId", "hiddenAt");
      `);
    }

    const messages = await describe('Messages');
    const chats = await describe('chats');
    if (messages && chats && participants) {
      if (!messages.receiverId) {
        await queryInterface.addColumn('Messages', 'receiverId', {
          type: Sequelize.INTEGER,
          allowNull: true,
        });
      }

      // Existing direct-chat rows created before receiverId was persisted need
      // one deterministic backfill. A direct chat has exactly two participants,
      // so the participant whose userId differs from senderId is the receiver.
      await queryInterface.sequelize.query(`
        UPDATE "Messages" AS m
           SET "receiverId" = cp."userId"
          FROM "chat_participants" AS cp
          JOIN "chats" AS c ON c."id" = cp."chatId"
         WHERE m."receiverId" IS NULL
           AND m."chatId" = cp."chatId"
           AND c."type" = 'direct'
           AND cp."userId" <> m."senderId";
      `);
    }

    const refreshedMessages = await describe('Messages');
    if (refreshedMessages && refreshedMessages.chatId && refreshedMessages.isDeleted && refreshedMessages.createdAt) {
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_chat_deleted_created
        ON "Messages" ("chatId", "isDeleted", "createdAt" DESC);
      `);
    }

    if (refreshedMessages && refreshedMessages.senderId && refreshedMessages.clientMessageId) {
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_sender_clientid
        ON "Messages" ("senderId", "clientMessageId")
        WHERE "clientMessageId" IS NOT NULL;
      `);
    }

    const offlineQueue = await describe('offline_message_queue');
    if (offlineQueue && offlineQueue.userId && offlineQueue.deliveredAt) {
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_offline_queue_user_undelivered
        ON "offline_message_queue" ("userId", "deliveredAt");
      `);
    }

    const messageDeletions = await describe('message_deletions');
    if (messageDeletions && messageDeletions.messageId && messageDeletions.userId) {
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_message_deletions_message_user
        ON "message_deletions" ("messageId", "userId");
      `);
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_message_deletions_user
        ON "message_deletions" ("userId");
      `);
    }

    console.log('[SchemaRepair] Final chat schema reconciliation complete');
  },

  async down() {
    // Forward-only convergence migration. Existing production data is never
    // removed by a rollback of this pass.
  },
};
