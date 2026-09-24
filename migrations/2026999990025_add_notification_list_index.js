'use strict';

// GET /api/notifications lists `WHERE user_id = ? ORDER BY created_at DESC LIMIT/OFFSET`.
// The existing single-column (user_id) index forces a sort of all of a user's rows on every
// page; this composite serves the filter and the ordering together. Idempotent.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC)'
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS idx_notifications_user_created');
  },
};
