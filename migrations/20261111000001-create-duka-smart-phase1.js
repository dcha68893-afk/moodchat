'use strict';
/**
 * NECPRA DUKA SMART — Phase 1: shops, products, stock ledger, audit trail.
 *
 * Additive and idempotent: only CREATE TABLE/INDEX IF NOT EXISTS. It never
 * alters or drops any existing table (Users, Tools, orders, wallets, STK ...).
 * No hard FK to "Users" on purpose: account-deletion flows must not be blocked
 * or cascade into financial records. Ownership is enforced server-side.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS duka_shops (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id      INTEGER NOT NULL,
        name          VARCHAR(120) NOT NULL,
        business_type VARCHAR(60),
        phone         VARCHAR(20),
        location      VARCHAR(160),
        kra_pin       VARCHAR(20),
        currency      VARCHAR(3) NOT NULL DEFAULT 'KES',
        receipt_footer VARCHAR(200),
        status        VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_shops_owner_idx ON duka_shops (owner_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_shops_owner_name_uq
        ON duka_shops (owner_id, lower(name)) WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS duka_products (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        name          VARCHAR(160) NOT NULL,
        barcode       VARCHAR(64),
        category      VARCHAR(80),
        unit          VARCHAR(20) NOT NULL DEFAULT 'piece',
        buying_price  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (buying_price >= 0),
        selling_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
        stock_qty     NUMERIC(14,3) NOT NULL DEFAULT 0,
        min_stock     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_products_shop_idx ON duka_products (shop_id, is_active);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_products_shop_name_uq
        ON duka_products (shop_id, lower(name)) WHERE is_active;
      CREATE UNIQUE INDEX IF NOT EXISTS duka_products_shop_barcode_uq
        ON duka_products (shop_id, barcode) WHERE barcode IS NOT NULL AND is_active;

      CREATE TABLE IF NOT EXISTS duka_stock_movements (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        product_id    UUID NOT NULL REFERENCES duka_products(id) ON DELETE RESTRICT,
        type          VARCHAR(20) NOT NULL
                      CHECK (type IN ('opening','adjustment','sale','purchase','return','damage')),
        qty_change    NUMERIC(14,3) NOT NULL,
        balance_after NUMERIC(14,3) NOT NULL,
        unit_cost     NUMERIC(14,2),
        reference_type VARCHAR(30),
        reference_id  UUID,
        note          VARCHAR(240),
        created_by    INTEGER NOT NULL,
        client_op_id  UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_stock_mv_product_idx ON duka_stock_movements (product_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_stock_mv_op_uq
        ON duka_stock_movements (shop_id, client_op_id) WHERE client_op_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS duka_audit_log (
        id          BIGSERIAL PRIMARY KEY,
        shop_id     UUID,
        user_id     INTEGER NOT NULL,
        action      VARCHAR(40) NOT NULL,
        entity      VARCHAR(30) NOT NULL,
        entity_id   UUID,
        before_data JSONB,
        after_data  JSONB,
        ip          VARCHAR(64),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_audit_shop_idx ON duka_audit_log (shop_id, created_at DESC);
    `);
  },
  // Intentionally non-destructive: rolling back must never drop business records.
  async down() {}
};
