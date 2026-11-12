'use strict';
/**
 * NECPRA DUKA SMART — Group Buying (additive, idempotent; no FK to "Users" so account deletion never cascades into financial records).
 * Trader money is only ever marked 'paid' from a verified NECPRA STK payment (see service).
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS duka_gb_suppliers (
        id          UUID PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        business_name VARCHAR(140) NOT NULL,
        phone       VARCHAR(20) NOT NULL,
        location    VARCHAR(160),
        products    VARCHAR(300),
        status      VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended')),
        verified_by INTEGER,
        verified_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_gb_suppliers_user_uq ON duka_gb_suppliers (user_id);

      CREATE TABLE IF NOT EXISTS duka_gb_orders (
        id            UUID PRIMARY KEY,
        organiser_id  INTEGER NOT NULL,
        organiser_shop_id UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        product_name  VARCHAR(160) NOT NULL,
        category      VARCHAR(80),
        unit          VARCHAR(20) NOT NULL,
        market        VARCHAR(160) NOT NULL,
        target_price  NUMERIC(14,2) CHECK (target_price IS NULL OR target_price >= 0),
        min_qty       NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
        max_qty       NUMERIC(14,3) CHECK (max_qty IS NULL OR max_qty > 0),
        closes_at     TIMESTAMPTZ NOT NULL,
        payment_deadline TIMESTAMPTZ,
        expected_delivery DATE,
        delivery_mode VARCHAR(20) NOT NULL DEFAULT 'collection' CHECK (delivery_mode IN ('collection','delivery')),
        fee_split     VARCHAR(12) NOT NULL DEFAULT 'proportional' CHECK (fee_split IN ('proportional','equal')),
        status        VARCHAR(12) NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','locked','confirmed','delivered','completed','cancelled','disputed')),
        chosen_quote_id UUID,
        cancel_reason VARCHAR(240),
        received_qty  NUMERIC(14,3),
        delivery_note VARCHAR(300),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_gb_orders_status_idx ON duka_gb_orders (status, market);

      CREATE TABLE IF NOT EXISTS duka_gb_quotes (
        id          UUID PRIMARY KEY,
        order_id    UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        supplier_id UUID NOT NULL REFERENCES duka_gb_suppliers(id) ON DELETE RESTRICT,
        unit_price  NUMERIC(14,2) NOT NULL CHECK (unit_price > 0),
        available_qty NUMERIC(14,3) NOT NULL CHECK (available_qty > 0),
        min_order_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
        transport_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (transport_fee >= 0),
        terms       VARCHAR(300),
        valid_until TIMESTAMPTZ,
        status      VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','chosen','withdrawn','rejected','changed')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_gb_quotes_active_uq ON duka_gb_quotes (order_id, supplier_id) WHERE status IN ('active','chosen');

      CREATE TABLE IF NOT EXISTS duka_gb_participants (
        id          UUID PRIMARY KEY,
        order_id    UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        user_id     INTEGER NOT NULL,
        shop_id     UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        qty         NUMERIC(14,3) NOT NULL CHECK (qty > 0),
        reference_price NUMERIC(14,2) CHECK (reference_price IS NULL OR reference_price >= 0),
        status      VARCHAR(12) NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','confirmed','paid','withdrawn','removed','received','refund_due')),
        qty_due     NUMERIC(14,3),
        amount_due  NUMERIC(14,2),
        goods_cost  NUMERIC(14,2),
        fee_share   NUMERIC(14,2),
        allocated_qty NUMERIC(14,3),
        allocated_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_gb_part_active_uq ON duka_gb_participants (order_id, user_id) WHERE status NOT IN ('withdrawn','removed');

      CREATE TABLE IF NOT EXISTS duka_gb_payments (
        id          UUID PRIMARY KEY,
        order_id    UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        participant_id UUID NOT NULL REFERENCES duka_gb_participants(id) ON DELETE RESTRICT,
        amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        mpesa_receipt VARCHAR(20) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_gb_payments_receipt_uq ON duka_gb_payments (mpesa_receipt);

      CREATE TABLE IF NOT EXISTS duka_gb_refunds (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id    UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        participant_id UUID NOT NULL REFERENCES duka_gb_participants(id) ON DELETE RESTRICT,
        amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        reason      VARCHAR(240) NOT NULL,
        status      VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid_out')),
        payout_ref  VARCHAR(40),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS duka_gb_disputes (
        id          UUID PRIMARY KEY,
        order_id    UUID NOT NULL REFERENCES duka_gb_orders(id) ON DELETE RESTRICT,
        raised_by   INTEGER NOT NULL,
        kind        VARCHAR(20) NOT NULL CHECK (kind IN ('shortage','damaged','quality','late','other')),
        details     VARCHAR(400) NOT NULL,
        status      VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS duka_gb_audit (
        id BIGSERIAL PRIMARY KEY, order_id UUID, user_id INTEGER NOT NULL, action VARCHAR(40) NOT NULL,
        data JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_gb_audit_order_idx ON duka_gb_audit (order_id, id);
    `);
  },
  async down() {}
};
