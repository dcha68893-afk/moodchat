'use strict';
/**
 * NECPRA Financial Intelligence: risk-event audit trail. Idempotent (safe to run twice).
 * One row per scored payment attempt: score, level, machine-readable reasons, and how the user resolved it.
 * Privacy: no phone numbers, no message text, no raw IP; counterparty is an internal id ("u:123") or a hash, device/ip are hashed.
 * Intentionally non-destructive on rollback: this is an audit trail, so `down` never drops it.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize || queryInterface;     // sequelize-cli passes a queryInterface; the DUKA test harness passes { sequelize }
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS ai_risk_events (
        id            UUID PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        kind          VARCHAR(24) NOT NULL,
        amount        NUMERIC(15,2) NOT NULL DEFAULT 0,
        counterparty  VARCHAR(64),
        score         SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
        level         VARCHAR(8) NOT NULL CHECK (level IN ('low','medium','high')),
        action        VARCHAR(8) NOT NULL CHECK (action IN ('allow','warn','review')),
        reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
        device_hash   VARCHAR(32),
        ip_hash       VARCHAR(32),
        mode          VARCHAR(8) NOT NULL DEFAULT 'observe',
        status        VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','user_confirmed_ok','user_reported')),
        resolved_at   TIMESTAMPTZ,
        resolved_note VARCHAR(200),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ai_risk_events_user_time_idx ON ai_risk_events (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ai_risk_events_open_high_idx ON ai_risk_events (created_at DESC) WHERE status = 'open' AND level = 'high';
    `);
  },
  async down() { /* audit trail: never dropped by a rollback */ }
};
