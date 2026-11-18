'use strict';
/**
 * DUKA SMART: external M-PESA receipts are pending until the shop owner confirms
 * they checked the receiving Till, Paybill or phone account.
 */
module.exports = {
  async up({ sequelize }) {
    await sequelize.query(`
      ALTER TABLE duka_sales DROP CONSTRAINT IF EXISTS duka_sales_payment_status_check;
      ALTER TABLE duka_sales ADD CONSTRAINT duka_sales_payment_status_check
        CHECK (payment_status IN ('paid','partial','credit','pending'));

      ALTER TABLE duka_sale_payments DROP CONSTRAINT IF EXISTS duka_sale_payments_verification_check;
      ALTER TABLE duka_sale_payments ADD CONSTRAINT duka_sale_payments_verification_check
        CHECK (verification IN ('none','receipt_recorded','verified','pending_manual','manual_confirmed'));

      ALTER TABLE duka_sale_payments ADD COLUMN IF NOT EXISTS channel VARCHAR(12);
      ALTER TABLE duka_sale_payments ADD COLUMN IF NOT EXISTS recipient_phone VARCHAR(24);
      ALTER TABLE duka_sale_payments ADD COLUMN IF NOT EXISTS verified_by INTEGER;
      ALTER TABLE duka_sale_payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

      ALTER TABLE duka_sale_payments DROP CONSTRAINT IF EXISTS duka_sale_payments_channel_check;
      ALTER TABLE duka_sale_payments ADD CONSTRAINT duka_sale_payments_channel_check
        CHECK (channel IS NULL OR channel IN ('till','paybill','phone'));
      CREATE INDEX IF NOT EXISTS duka_sale_payments_pending_idx
        ON duka_sale_payments (shop_id, created_at) WHERE verification = 'pending_manual';
    `);
  },
  async down() {}
};
