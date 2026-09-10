'use strict';

/**
 * Migration: add composite indexes to Calls table
 *
 * H-06 FIX: cleanup/history queries need composite indexes, and the
 * migration must be safe when the schema was partially repaired before
 * sequelize-cli reaches it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const callsCols = await queryInterface.describeTable('Calls').catch(() => null);
    if (!callsCols) return;

    if (!callsCols.participants) {
      await queryInterface.addColumn('Calls', 'participants', {
        type: Sequelize.ARRAY(Sequelize.INTEGER),
        allowNull: false,
        defaultValue: [],
      }).catch(() => {});
    }

    // Do not use CREATE INDEX CONCURRENTLY here: sequelize-cli may execute
    // migrations inside a transaction on some deployments, where CONCURRENTLY
    // is illegal. These indexes are idempotent and the migration is run once.
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS calls_status_created_idx
      ON "Calls" ("status", "createdAt");
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS calls_status_ended_idx
      ON "Calls" ("status", "endedAt");
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS calls_participants_gin
      ON "Calls" USING gin ("participants");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS calls_status_created_idx;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS calls_status_ended_idx;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS calls_participants_gin;`).catch(() => {});
  },
};
