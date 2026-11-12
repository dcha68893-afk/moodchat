'use strict';
/**
 * NECPRA DUKA SMART — Device financing + Chama-linked group buying (additive, idempotent).
 * No FK to "Users" / money_circles so account or circle deletion never cascades into financial records.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS duka_fin_plans (
        id            UUID PRIMARY KEY,
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        user_id       INTEGER NOT NULL,
        device_model  VARCHAR(80) NOT NULL DEFAULT 'NECPRA Smart Scale',
        device_id     UUID REFERENCES duka_devices(id) ON DELETE SET NULL,
        device_price  NUMERIC(14,2) CHECK (device_price IS NULL OR device_price > 0),
        deposit       NUMERIC(14,2) CHECK (deposit IS NULL OR deposit >= 0),
        weekly_amount NUMERIC(14,2) CHECK (weekly_amount IS NULL OR weekly_amount > 0),
        weeks         INTEGER CHECK (weeks IS NULL OR weeks > 0),
        status        VARCHAR(12) NOT NULL DEFAULT 'applied'
                      CHECK (status IN ('applied','approved','active','completed','rejected','cancelled')),
        ownership     VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (ownership IN ('pending','financed','owned')),
        start_date    DATE,
        warranty_until DATE,
        consent_at    TIMESTAMPTZ NOT NULL,
        eligibility   JSONB,
        note          VARCHAR(300),
        reject_reason VARCHAR(240),
        decided_by    INTEGER,
        decided_at    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_fin_plans_shop_idx ON duka_fin_plans (shop_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_fin_plans_one_open_uq ON duka_fin_plans (shop_id) WHERE status IN ('applied','approved','active');

      CREATE TABLE IF NOT EXISTS duka_fin_payments (
        id            UUID PRIMARY KEY,
        plan_id       UUID NOT NULL REFERENCES duka_fin_plans(id) ON DELETE RESTRICT,
        amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        mpesa_receipt VARCHAR(20) NOT NULL,
        recorded_by   INTEGER NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_fin_payments_receipt_uq ON duka_fin_payments (mpesa_receipt);
      CREATE INDEX IF NOT EXISTS duka_fin_payments_plan_idx ON duka_fin_payments (plan_id, created_at);

      CREATE TABLE IF NOT EXISTS duka_fin_repairs (
        id          UUID PRIMARY KEY,
        plan_id     UUID NOT NULL REFERENCES duka_fin_plans(id) ON DELETE RESTRICT,
        kind        VARCHAR(10) NOT NULL CHECK (kind IN ('warranty','repair')),
        details     VARCHAR(400) NOT NULL,
        status      VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_repair','resolved','rejected')),
        resolution  VARCHAR(300),
        created_by  INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS duka_chama_links (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id   UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        circle_id  UUID NOT NULL,
        linked_by  INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (order_id, circle_id)
      );
      CREATE INDEX IF NOT EXISTS duka_chama_links_circle_idx ON duka_chama_links (circle_id);

      CREATE TABLE IF NOT EXISTS duka_chama_funding (
        id             UUID PRIMARY KEY,
        order_id       UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        participant_id UUID NOT NULL REFERENCES duka_gb_participants(id) ON DELETE RESTRICT,
        circle_id      UUID NOT NULL,
        requested_by   INTEGER NOT NULL,
        amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        status         VARCHAR(12) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','settled','cancelled')),
        settled_by     INTEGER,
        payout_ref     VARCHAR(60),
        settle_note    VARCHAR(240),
        settled_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_chama_funding_open_uq ON duka_chama_funding (participant_id, circle_id) WHERE status IN ('requested','approved');
      CREATE INDEX IF NOT EXISTS duka_chama_funding_circle_idx ON duka_chama_funding (circle_id, status);

      CREATE TABLE IF NOT EXISTS duka_chama_votes (
        funding_id UUID NOT NULL REFERENCES duka_chama_funding(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL,
        vote       VARCHAR(7) NOT NULL CHECK (vote IN ('approve','reject')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (funding_id, user_id)
      );
    `);
  },
  async down() {}
};
