'use strict';
/**
 * NECPRA DUKA SMART — sale cancellation (void) columns + product description.
 *
 * Additive and idempotent: ADD COLUMN IF NOT EXISTS only. duka_sales.status already allows 'voided'
 * (phase-2 migration); these columns record why, when and by whom. Nothing is dropped or rewritten.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      ALTER TABLE duka_sales ADD COLUMN IF NOT EXISTS void_reason VARCHAR(240);
      ALTER TABLE duka_sales ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
      ALTER TABLE duka_sales ADD COLUMN IF NOT EXISTS voided_by   INTEGER;
      ALTER TABLE duka_products ADD COLUMN IF NOT EXISTS description VARCHAR(500);
    `);
  },
  // Intentionally non-destructive: rolling back must never drop business records.
  async down() {}
};
