'use strict';

/**
 * Ringing calls do not have a call start time until the callee answers.
 * The original Calls table incorrectly made startedAt NOT NULL, while the
 * call service intentionally creates ringing rows with startedAt = null.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "Calls" ALTER COLUMN "startedAt" DROP NOT NULL;'
    ).catch(() => {});
  },

  async down(queryInterface) {
    // Existing ringing rows may legitimately contain NULL, so restoring NOT
    // NULL would be destructive. Keep this migration irreversible by design.
    console.warn('[Calls migration] down() intentionally leaves startedAt nullable.');
  },
};