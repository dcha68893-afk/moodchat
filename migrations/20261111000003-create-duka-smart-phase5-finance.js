'use strict';
/**
 * NECPRA DUKA SMART — Phase 5: shop financial records.
 * Additive and idempotent (CREATE ... IF NOT EXISTS only). Never alters or drops an existing table.
 *
 *   duka_expenses          daily running costs (rent, transport, wages...). Reduce profit. Voided, never deleted.
 *   duka_suppliers         who the shop buys stock from.
 *   duka_supplier_entries  ledger per supplier: 'bill' (stock bought on credit: we owe more) and
 *                          'payment' (we paid: we owe less). owed = SUM(bill) - SUM(payment).
 *                          Bills/payments are NOT expenses: the cost of stock reaches profit through COGS on sale.
 *   duka_debt_payments     money collected from a customer who owes (customer credit). Cash received, NOT revenue.
 *   duka_debt_allocations  which unpaid sales each collection settled (oldest first).
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS duka_expenses (
        id           UUID PRIMARY KEY,
        shop_id      UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        category     VARCHAR(40) NOT NULL DEFAULT 'other',
        description  VARCHAR(200),
        amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        method       VARCHAR(10) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','mpesa','other')),
        expense_date DATE NOT NULL,
        status       VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
        void_reason  VARCHAR(200),
        voided_at    TIMESTAMPTZ,
        created_by   INTEGER NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_expenses_shop_date_idx ON duka_expenses (shop_id, expense_date DESC);

      CREATE TABLE IF NOT EXISTS duka_suppliers (
        id         UUID PRIMARY KEY,
        shop_id    UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        name       VARCHAR(120) NOT NULL,
        phone      VARCHAR(20),
        notes      VARCHAR(240),
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_suppliers_shop_name_uq ON duka_suppliers (shop_id, lower(name));

      CREATE TABLE IF NOT EXISTS duka_supplier_entries (
        id          UUID PRIMARY KEY,
        shop_id     UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        supplier_id UUID NOT NULL REFERENCES duka_suppliers(id) ON DELETE RESTRICT,
        type        VARCHAR(10) NOT NULL CHECK (type IN ('bill','payment')),
        amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        method      VARCHAR(10) CHECK (method IN ('cash','mpesa','other')),
        reference   VARCHAR(40),
        note        VARCHAR(240),
        entry_date  DATE NOT NULL,
        due_date    DATE,
        created_by  INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_supplier_entries_sup_idx ON duka_supplier_entries (supplier_id, entry_date, created_at);
      CREATE INDEX IF NOT EXISTS duka_supplier_entries_shop_idx ON duka_supplier_entries (shop_id, entry_date);

      CREATE TABLE IF NOT EXISTS duka_debt_payments (
        id            UUID PRIMARY KEY,
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        customer_id   UUID NOT NULL REFERENCES duka_customers(id) ON DELETE RESTRICT,
        amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        method        VARCHAR(10) NOT NULL CHECK (method IN ('cash','mpesa')),
        mpesa_receipt VARCHAR(20),
        verification  VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (verification IN ('none','receipt_recorded','verified')),
        note          VARCHAR(240),
        received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by    INTEGER NOT NULL,
        CONSTRAINT duka_debt_payments_mpesa_ck CHECK (method <> 'mpesa' OR mpesa_receipt IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS duka_debt_payments_shop_idx ON duka_debt_payments (shop_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS duka_debt_payments_cust_idx ON duka_debt_payments (customer_id);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_debt_payments_receipt_uq
        ON duka_debt_payments (shop_id, mpesa_receipt) WHERE mpesa_receipt IS NOT NULL;

      CREATE TABLE IF NOT EXISTS duka_debt_allocations (
        payment_id UUID NOT NULL REFERENCES duka_debt_payments(id) ON DELETE RESTRICT,
        sale_id    UUID NOT NULL REFERENCES duka_sales(id) ON DELETE RESTRICT,
        amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        PRIMARY KEY (payment_id, sale_id)
      );
    `);
  },
  // Intentionally non-destructive: rolling back must never drop business records.
  async down() {}
};
