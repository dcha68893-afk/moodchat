'use strict';
/**
 * NECPRA DUKA SMART — instalment reminder settings + delivery log (additive, idempotent).
 * The UNIQUE key on the log is what stops a reminder going out twice, even with several cluster workers running the job.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS duka_fin_reminder_settings (
        shop_id        UUID PRIMARY KEY REFERENCES duka_shops(id) ON DELETE CASCADE,
        push_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
        sms_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
        sms_phone      VARCHAR(20),
        sms_consent_at TIMESTAMPTZ,
        language       VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','sw')),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS duka_fin_reminder_log (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id    UUID NOT NULL REFERENCES duka_fin_plans(id) ON DELETE CASCADE,
        kind       VARCHAR(10) NOT NULL CHECK (kind IN ('deposit','upcoming','overdue')),
        period_key VARCHAR(20) NOT NULL,
        channel    VARCHAR(5)  NOT NULL CHECK (channel IN ('push','sms')),
        status     VARCHAR(8)  NOT NULL CHECK (status IN ('sending','sent','failed','skipped')),
        attempts   INTEGER NOT NULL DEFAULT 1,
        detail     VARCHAR(200),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duka_fin_reminder_log_uq ON duka_fin_reminder_log (plan_id, kind, period_key, channel);
      CREATE INDEX IF NOT EXISTS duka_fin_reminder_log_recent_idx ON duka_fin_reminder_log (plan_id, created_at DESC);
    `);
  },
  async down(q) {
    await q.sequelize.query('DROP TABLE IF EXISTS duka_fin_reminder_log; DROP TABLE IF EXISTS duka_fin_reminder_settings;');
  }
};
