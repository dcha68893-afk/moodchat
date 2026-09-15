'use strict';

/**
 * FIX (CALLS-CHATID-MISSING): the original Calls table migration
 * (20260118081100createcalls.js) never created chatId, type, or duration
 * columns, even though src/models/Call.js has always defined them as real
 * attributes. Because Calls.findAll / findAndCountAll implicitly SELECT
 * every model attribute, every call to GET /history and GET /scheduled
 * failed in production with:
 *
 *   column "chatId" does not exist
 *
 * The model's runtime self-heal block (bottom of src/models/Call.js) adds
 * missing columns automatically, but its list never included these three,
 * and — being an async setImmediate() — it also races against early
 * request traffic right after a deploy. This migration is the durable,
 * deploy-time fix: it runs before the app accepts traffic and is safe to
 * re-run (idempotent, additive only).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const callsTable = tables.find((t) => String(t).toLowerCase() === 'calls');
    if (!callsTable) {
      console.log('[Migration] Calls table not found — skipping (will be created by createcalls migration).');
      return;
    }

    const columns = await queryInterface.describeTable(callsTable);

    if (!columns.chatId) {
      await queryInterface.addColumn(callsTable, 'chatId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Chats', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
      console.log(`[Migration] Added ${callsTable}.chatId`);
    }

    if (!columns.type) {
      await queryInterface.addColumn(callsTable, 'type', {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'audio',
      });
      console.log(`[Migration] Added ${callsTable}.type`);

      // Backfill from the legacy 'callType' column if it has data, so
      // existing rows don't silently default to 'audio'.
      if (columns.callType) {
        await queryInterface.sequelize.query(
          `UPDATE "${callsTable}" SET "type" = "callType" WHERE "callType" IS NOT NULL AND "callType" IN ('audio', 'video');`
        );
      }
    }

    if (!columns.duration) {
      await queryInterface.addColumn(callsTable, 'duration', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
      console.log(`[Migration] Added ${callsTable}.duration`);
    }

    // Backfill duration for completed calls that have both timestamps but
    // duration is still at the default 0, so history/analytics aren't blank.
    try {
      await queryInterface.sequelize.query(`
        UPDATE "${callsTable}"
        SET "duration" = GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt"))::INTEGER)
        WHERE "duration" = 0 AND "startedAt" IS NOT NULL AND "endedAt" IS NOT NULL;
      `);
    } catch (e) {
      console.warn('[Migration] duration backfill skipped (non-fatal):', e.message);
    }

    // Index for the chatId lookups used by findActiveCall / getActiveCalls.
    try {
      await queryInterface.addIndex(callsTable, ['chatId'], {
        name: 'calls_chatid_idx',
      });
    } catch (e) {
      // already exists — ignore
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const callsTable = tables.find((t) => String(t).toLowerCase() === 'calls');
    if (!callsTable) return;

    try { await queryInterface.removeIndex(callsTable, 'calls_chatid_idx'); } catch (e) {}
    try { await queryInterface.removeColumn(callsTable, 'chatId'); } catch (e) {}
    try { await queryInterface.removeColumn(callsTable, 'type'); } catch (e) {}
    try { await queryInterface.removeColumn(callsTable, 'duration'); } catch (e) {}
  },
};
