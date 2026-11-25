'use strict';
/**
 * NECPRA Personal Assistant: reminders the user asked for by voice/text. Idempotent (safe to run twice).
 * Stores only what the user chose to be reminded about (short text + time). Scoped by user_id in every query.
 * Non-destructive on rollback (user data): `down` never drops it.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize || queryInterface;
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS ai_reminders (
        id           UUID PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        text         VARCHAR(140) NOT NULL,
        due_at       TIMESTAMPTZ NOT NULL,
        status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
        source       VARCHAR(10) NOT NULL DEFAULT 'voice',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ai_reminders_user_status_due_idx ON ai_reminders (user_id, status, due_at);
    `);
  },
  async down() { /* user data: never dropped by a rollback */ }
};
