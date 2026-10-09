'use strict';
// Wallet withdrawals table + ledger safety indexes. Idempotent.
module.exports = {
  async up(queryInterface) {
    const q = sql => queryInterface.sequelize.query(sql);
    // user_id must match wallets.user_id (integer in some deployments, uuid in others)
    const [col] = await q(`SELECT data_type FROM information_schema.columns WHERE table_name='wallets' AND column_name='user_id' LIMIT 1`);
    const uidType = col && col[0] && col[0].data_type === 'uuid' ? 'UUID' : 'INTEGER';

    await q(`CREATE TABLE IF NOT EXISTS "wallet_withdrawals" (
      "id" UUID PRIMARY KEY,
      "user_id" ${uidType} NOT NULL,
      "wallet_id" UUID NOT NULL,
      "amount" DECIMAL(15,2) NOT NULL CHECK ("amount" > 0),
      "fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
      "currency" VARCHAR(10) NOT NULL DEFAULT 'KES',
      "phone" VARCHAR(20) NOT NULL,
      "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
      "originator_conversation_id" VARCHAR(100) UNIQUE,
      "conversation_id" VARCHAR(100),
      "mpesa_receipt" VARCHAR(50),
      "result_code" VARCHAR(20),
      "failure_reason" TEXT,
      "reversed" BOOLEAN NOT NULL DEFAULT false,
      "idempotency_key" VARCHAR(100),
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "completed_at" TIMESTAMPTZ,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE INDEX IF NOT EXISTS idx_wallet_wd_user ON "wallet_withdrawals" ("user_id","created_at" DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_wallet_wd_conv ON "wallet_withdrawals" ("conversation_id")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_wd_idem ON "wallet_withdrawals" ("user_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL`);

    // A ledger reference for these kinds can only ever be written once per wallet+direction (replay protection).
    try {
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_ref_kind ON "wallet_transactions" ("wallet_id","type","reference")
               WHERE "reference" IS NOT NULL AND "metadata"->>'kind' IN ('transfer_out','transfer_in','withdrawal','withdrawal_reversal','refund')`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_transfer_idem ON "wallet_transactions" ("user_id",("metadata"->>'idempotency_key'))
               WHERE "metadata"->>'kind' = 'transfer_out' AND "metadata"->>'idempotency_key' IS NOT NULL`);
    } catch (e) { console.warn('[migration] wallet ledger indexes skipped:', e.message); }
    // Balance can never be negative, even if application code is bypassed.
    try { await q(`ALTER TABLE "wallets" ADD CONSTRAINT wallets_balance_non_negative CHECK ("balance" >= 0)`); } catch (_) { /* already present */ }
    await q(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_kind ON "wallet_transactions" ("user_id",("metadata"->>'kind'),"createdAt" DESC)`);
  },
  async down(queryInterface) { await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "wallet_withdrawals"`); },
};
