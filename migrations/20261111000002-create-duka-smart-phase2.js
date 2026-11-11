'use strict';
/**
 * NECPRA DUKA SMART — Phase 2: customers, sales (POS), sale items, sale payments, receipt counters.
 *
 * Additive and idempotent (CREATE ... IF NOT EXISTS only). Never alters or drops an existing table.
 *
 * Accounting model encoded here:
 *   total        = subtotal - discount_amount                (revenue earned on the sale)
 *   amount_paid  = sum(duka_sale_payments.amount)            (money actually received)
 *   balance_due  = total - amount_paid                       (customer credit, NOT cash, NOT yet collected)
 *   cogs         = sum(item qty * unit_cost snapshot)        (cost of goods sold)
 *   gross profit = total - cogs                              (accrual basis)
 * Sale items snapshot name/unit/price/cost so later product edits never rewrite history.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS duka_customers (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id    UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        name       VARCHAR(120) NOT NULL,
        phone      VARCHAR(20),
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_customers_shop_idx ON duka_customers (shop_id, is_active);

      CREATE TABLE IF NOT EXISTS duka_receipt_counters (
        shop_id UUID PRIMARY KEY REFERENCES duka_shops(id) ON DELETE RESTRICT,
        last_no INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS duka_sales (
        id              UUID PRIMARY KEY,
        shop_id         UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        receipt_no      INTEGER NOT NULL,
        customer_id     UUID REFERENCES duka_customers(id) ON DELETE RESTRICT,
        customer_name   VARCHAR(120),
        subtotal        NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),
        discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
        total           NUMERIC(14,2) NOT NULL CHECK (total > 0),
        amount_paid     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
        balance_due     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
        cogs            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cogs >= 0),
        payment_status  VARCHAR(10) NOT NULL CHECK (payment_status IN ('paid','partial','credit')),
        status          VARCHAR(10) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
        note            VARCHAR(240),
        sold_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by      INTEGER NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT duka_sales_balance_ck CHECK (amount_paid + balance_due = total)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_sales_receipt_uq ON duka_sales (shop_id, receipt_no);
      CREATE INDEX IF NOT EXISTS duka_sales_shop_date_idx ON duka_sales (shop_id, sold_at DESC);
      CREATE INDEX IF NOT EXISTS duka_sales_customer_idx ON duka_sales (customer_id) WHERE customer_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS duka_sale_items (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sale_id      UUID NOT NULL REFERENCES duka_sales(id) ON DELETE RESTRICT,
        shop_id      UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        product_id   UUID NOT NULL REFERENCES duka_products(id) ON DELETE RESTRICT,
        product_name VARCHAR(160) NOT NULL,
        unit         VARCHAR(20) NOT NULL,
        qty          NUMERIC(14,3) NOT NULL CHECK (qty > 0),
        unit_price   NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
        unit_cost    NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
        line_total   NUMERIC(14,2) NOT NULL CHECK (line_total >= 0)
      );
      CREATE INDEX IF NOT EXISTS duka_sale_items_sale_idx ON duka_sale_items (sale_id);
      CREATE INDEX IF NOT EXISTS duka_sale_items_product_idx ON duka_sale_items (product_id);

      CREATE TABLE IF NOT EXISTS duka_sale_payments (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sale_id      UUID NOT NULL REFERENCES duka_sales(id) ON DELETE RESTRICT,
        shop_id      UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        method       VARCHAR(10) NOT NULL CHECK (method IN ('cash','mpesa')),
        amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        mpesa_receipt VARCHAR(20),
        payer_phone  VARCHAR(20),
        -- cash: 'none'. mpesa: 'receipt_recorded' = shopkeeper supplied a receipt code;
        -- 'verified' = the code matched a paid NECPRA STK transaction for at least this amount.
        verification VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (verification IN ('none','receipt_recorded','verified')),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT duka_sale_payments_mpesa_ck CHECK (method <> 'mpesa' OR mpesa_receipt IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS duka_sale_payments_sale_idx ON duka_sale_payments (sale_id);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_sale_payments_receipt_uq
        ON duka_sale_payments (shop_id, mpesa_receipt) WHERE mpesa_receipt IS NOT NULL;
    `);
  },
  // Intentionally non-destructive: rolling back must never drop business records.
  async down() {}
};
