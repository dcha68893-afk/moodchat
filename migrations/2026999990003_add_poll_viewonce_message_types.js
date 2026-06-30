'use strict';

/**
 * Adds 'poll' (this feature) and 'view_once' (upcoming feature) to the
 * Messages.type ENUM. Postgres requires ALTER TYPE ... ADD VALUE for enums;
 * this cannot run inside the same transaction as other DDL in some PG
 * versions, so it's isolated in its own migration.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    // ALTER TYPE ADD VALUE cannot run inside a transaction block in Postgres
    // < 12; queryInterface.sequelize.query runs outside the migration's
    // implicit transaction wrapper when no `transaction` option is passed.
    const addValueIfMissing = async (value) => {
      try {
        await queryInterface.sequelize.query(
          `ALTER TYPE "enum_Messages_type" ADD VALUE IF NOT EXISTS '${value}';`
        );
      } catch (err) {
        // IF NOT EXISTS is supported on PG 12+; older versions throw
        // duplicate_object which we can safely ignore.
        if (!/already exists/i.test(err.message)) {
          console.warn(`[migration] Could not add enum value '${value}':`, err.message);
        }
      }
    };
    await addValueIfMissing('poll');
    await addValueIfMissing('view_once');
  },

  async down() {
    // Postgres does not support removing enum values without recreating the
    // type and rewriting every row that references it. Treated as a
    // forward-only migration; down is intentionally a no-op.
  },
};
