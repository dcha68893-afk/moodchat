'use strict';
// Repairs a money_requests table that already existed (created by sequelize.sync
// or an older version) before migration 2026999990027 ran. That migration skips
// tables that exist, so columns the MoneyRequest model uses were never added and
// /api/money/overview, /requests and /requests/incoming failed with:
//   column "recipient_user_id" does not exist
//   column "expires_at" does not exist
// Fully idempotent: safe to run more than once.
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS "money_requests"
      ADD COLUMN IF NOT EXISTS "requester_id" INTEGER,
      ADD COLUMN IF NOT EXISTS "recipient_user_id" INTEGER,
      ADD COLUMN IF NOT EXISTS "recipient_phone" VARCHAR(30),
      ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) DEFAULT 'KES',
      ADD COLUMN IF NOT EXISTS "purpose" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS "payment_ref" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(120)`);
    await q(`CREATE INDEX IF NOT EXISTS "money_requests_recipient_user_id_idx" ON "money_requests" ("recipient_user_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "money_requests_requester_id_idx" ON "money_requests" ("requester_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "money_requests_expires_at_idx" ON "money_requests" ("expires_at")`);
  },
  async down() { /* additive repair only — nothing to undo */ }
};
