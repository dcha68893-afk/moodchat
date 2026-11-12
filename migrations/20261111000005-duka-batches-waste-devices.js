'use strict';
/**
 * NECPRA DUKA SMART — perishable batches, spoilage/waste records, Smart Scale devices.
 * Additive + idempotent (IF NOT EXISTS). Never drops or rewrites existing data.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      ALTER TABLE duka_products ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE duka_products ADD COLUMN IF NOT EXISTS shelf_life_days NUMERIC(6,1) CHECK (shelf_life_days IS NULL OR shelf_life_days > 0);
      ALTER TABLE duka_products ADD COLUMN IF NOT EXISTS storage_note VARCHAR(160);
      ALTER TABLE duka_products ADD COLUMN IF NOT EXISTS pack_unit VARCHAR(20);
      ALTER TABLE duka_products ADD COLUMN IF NOT EXISTS pack_size NUMERIC(14,3) CHECK (pack_size IS NULL OR pack_size > 0);

      -- One row per delivery/purchase of a product. Remaining quantity is derived (FIFO) from
      -- duka_products.stock_qty so sales never need to touch this table.
      CREATE TABLE IF NOT EXISTS duka_stock_batches (
        id            UUID PRIMARY KEY,
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        product_id    UUID NOT NULL REFERENCES duka_products(id) ON DELETE RESTRICT,
        batch_ref     VARCHAR(60),
        qty_received  NUMERIC(14,3) NOT NULL CHECK (qty_received > 0),
        unit_cost     NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
        supplier_id   UUID,
        source        VARCHAR(20) NOT NULL DEFAULT 'purchase' CHECK (source IN ('purchase','group_buy','opening')),
        source_ref    UUID,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        shelf_life_days NUMERIC(6,1) CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
        expected_spoil_at TIMESTAMPTZ,
        condition_note VARCHAR(160),
        created_by    INTEGER NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_batches_product_idx ON duka_stock_batches (product_id, received_at);
      CREATE UNIQUE INDEX IF NOT EXISTS duka_batches_source_uq ON duka_stock_batches (shop_id, product_id, source, source_ref) WHERE source_ref IS NOT NULL;

      -- Confirmed spoilage / damage. A loss is NOT a sale: it is an inventory loss at cost.
      CREATE TABLE IF NOT EXISTS duka_stock_losses (
        id            UUID PRIMARY KEY,
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        product_id    UUID NOT NULL REFERENCES duka_products(id) ON DELETE RESTRICT,
        batch_id      UUID REFERENCES duka_stock_batches(id),
        qty           NUMERIC(14,3) NOT NULL CHECK (qty > 0),
        unit_cost     NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
        loss_value    NUMERIC(14,2) NOT NULL CHECK (loss_value >= 0),
        reason        VARCHAR(20) NOT NULL CHECK (reason IN ('spoiled','damaged','expired','theft','other')),
        handling      VARCHAR(20) NOT NULL DEFAULT 'disposed' CHECK (handling IN ('disposed','returned','discounted','other')),
        condition_note VARCHAR(200),
        photo_url     VARCHAR(500),
        detected_on   DATE NOT NULL DEFAULT CURRENT_DATE,
        movement_id   UUID,
        created_by    INTEGER NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS duka_losses_shop_idx ON duka_stock_losses (shop_id, detected_on DESC);

      CREATE TABLE IF NOT EXISTS duka_devices (
        id            UUID PRIMARY KEY,
        shop_id       UUID NOT NULL REFERENCES duka_shops(id) ON DELETE RESTRICT,
        serial_no     VARCHAR(60) NOT NULL,
        device_type   VARCHAR(20) NOT NULL DEFAULT 'smart_scale' CHECK (device_type IN ('smart_scale','bt_scale','simulator')),
        label         VARCHAR(80),
        key_hash      CHAR(64) NOT NULL,
        capacity_kg   NUMERIC(6,2) NOT NULL DEFAULT 30,
        firmware      VARCHAR(30),
        battery_pct   SMALLINT,
        charging      BOOLEAN,
        calibration_status VARCHAR(20),
        status        VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        last_seen_at  TIMESTAMPTZ,
        last_sync_at  TIMESTAMPTZ,
        created_by    INTEGER NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_devices_serial_uq ON duka_devices (serial_no);

      -- Offline readings/line-items sent by a scale. Idempotent per (device, op_id).
      CREATE TABLE IF NOT EXISTS duka_device_readings (
        id            BIGSERIAL PRIMARY KEY,
        device_id     UUID NOT NULL REFERENCES duka_devices(id) ON DELETE RESTRICT,
        shop_id       UUID NOT NULL,
        op_id         UUID NOT NULL,
        product_id    UUID,
        weight_g      INTEGER NOT NULL CHECK (weight_g >= 0),
        tare_g        INTEGER NOT NULL DEFAULT 0,
        stable        BOOLEAN NOT NULL DEFAULT TRUE,
        overload      BOOLEAN NOT NULL DEFAULT FALSE,
        unit_price    NUMERIC(14,2),
        line_total    NUMERIC(14,2),
        measured_at   TIMESTAMPTZ NOT NULL,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (device_id, op_id)
      );
    `);
  },
  async down() {}
};
