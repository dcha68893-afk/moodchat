'use strict';
/**
 * NECPRA Personal Assistant: remember when a reminder's push notification was attempted, so each reminder is pushed at most once.
 * Idempotent (safe to run twice). Never dropped on rollback (user data).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize || queryInterface;
    await sequelize.query(`
      ALTER TABLE ai_reminders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
      ALTER TABLE ai_reminders ADD COLUMN IF NOT EXISTS push_count SMALLINT NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS ai_reminders_due_unnotified_idx ON ai_reminders (due_at) WHERE status = 'pending' AND notified_at IS NULL;
    `);
  },
  async down() { /* user data: never dropped by a rollback */ }
};
