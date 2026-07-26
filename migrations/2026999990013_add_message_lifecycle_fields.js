'use strict';
/**
 * MESSAGE LIFECYCLE REBUILD (messages-only scope)
 * ------------------------------------------------
 * Adds the columns the new canonical message pipeline needs to implement
 * the Signal-style lifecycle (PENDING -> SENT -> DELIVERED -> READ) with
 * true idempotency, so a client retry/resend can never create a duplicate
 * row server-side.
 *
 *  - clientMessageId: the ID the sender generated locally, before the
 *    message ever reached the server. Unique per (senderId, clientMessageId).
 *    This is what lets a client safely re-send the same message after a
 *    dropped connection without the server ever creating a duplicate.
 *  - status: explicit lifecycle state, instead of inferring it from
 *    deliveredAt/isRead (which was ambiguous — see messageService.js
 *    FIX-DELIVERY-GUARANTEE comment for the history of that ambiguity).
 *  - deliveryAttempts: how many times the server has tried to push this
 *    message to the recipient's socket, for observability/backoff.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Messages');

    if (!table.clientMessageId) {
      await queryInterface.addColumn('Messages', 'clientMessageId', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    if (!table.status) {
      await queryInterface.addColumn('Messages', 'status', {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'sent',
        // sent | delivered | read | failed
        // ("pending" is a client-only, pre-server state and never stored here)
      });
    }

    if (!table.deliveryAttempts) {
      await queryInterface.addColumn('Messages', 'deliveryAttempts', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }

    // Idempotency guard: the same sender can never persist the same
    // clientMessageId twice. Partial index so historical NULL rows
    // (messages created before this migration) don't collide.
    const indexes = await queryInterface.showIndex('Messages').catch(() => []);
    const hasIdx = indexes.some(i => i.name === 'uniq_messages_sender_clientid');
    if (!hasIdx) {
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_sender_clientid
        ON "Messages" ("senderId", "clientMessageId")
        WHERE "clientMessageId" IS NOT NULL
      `);
    }

    // Backfill status for existing rows from the old deliveredAt/isRead fields
    // so nothing that already shipped shows as un-sent.
    await queryInterface.sequelize.query(`
      UPDATE "Messages" SET status = CASE
        WHEN "isRead" = true THEN 'read'
        WHEN "deliveredAt" IS NOT NULL THEN 'delivered'
        ELSE 'sent'
      END
      WHERE status = 'sent'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS uniq_messages_sender_clientid`).catch(() => {});
    await queryInterface.removeColumn('Messages', 'deliveryAttempts').catch(() => {});
    await queryInterface.removeColumn('Messages', 'status').catch(() => {});
    await queryInterface.removeColumn('Messages', 'clientMessageId').catch(() => {});
  },
};
