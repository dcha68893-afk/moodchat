'use strict';

/**
 * Live Location Expiry Sweep Job
 *
 * Runs every 60 seconds. Finds LiveLocationSessions that have passed their
 * expiresAt timestamp but are still marked isActive (e.g. the user's client
 * crashed or the stop call never made it through), marks them stopped, and
 * broadcasts a live-location:stopped event so all open chat windows update.
 *
 * This is a background job, not a cron — called from src/server.js or via
 * setInterval during app startup. Designed to be fault-tolerant: a single
 * sweep failure is logged and ignored, the next sweep picks up where it left off.
 */

let _sweepInterval = null;

async function sweepExpiredSessions(sequelize) {
  try {
    // FIX: LiveLocationSession was missing from the model whitelist (fixed
    // separately in models/index.js) so its table was never created —
    // ensure it directly here too.
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "LiveLocationSessions" (
          id              SERIAL PRIMARY KEY,
          "messageId"     INTEGER NOT NULL,
          "chatId"        INTEGER NOT NULL,
          "userId"        INTEGER NOT NULL,
          latitude        DECIMAL(10,7) NOT NULL,
          longitude       DECIMAL(10,7) NOT NULL,
          accuracy        FLOAT,
          heading         FLOAT,
          speed           FLOAT,
          "startedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "expiresAt"     TIMESTAMPTZ NOT NULL,
          "lastUpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "isActive"      BOOLEAN NOT NULL DEFAULT true,
          "stoppedAt"     TIMESTAMPTZ,
          "stoppedReason" VARCHAR(20),
          "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS live_location_sessions_active_idx ON "LiveLocationSessions" ("chatId", "isActive");`);
    } catch (tableErr) {
      console.warn('[liveLocationExpiry] Could not verify/create LiveLocationSessions table:', tableErr.message);
    }

    const expired = await sequelize.query(
      `UPDATE "LiveLocationSessions"
       SET "isActive" = false, "stoppedAt" = NOW(), "stoppedReason" = 'expired', "updatedAt" = NOW()
       WHERE "isActive" = true AND "expiresAt" <= NOW()
       RETURNING id, "chatId", "userId"`,
      { type: sequelize.QueryTypes.UPDATE }
    );

    const rows = Array.isArray(expired) ? (expired[0] || []) : [];
    if (rows.length > 0) {
      try {
        const wsService = require('../services/webSocketService');
        for (const row of rows) {
          wsService.broadcastToChat(row.chatId, 'live-location:stopped', {
            sessionId: row.id, chatId: row.chatId, userId: row.userId,
            stoppedAt: new Date().toISOString(), reason: 'expired',
          }, []);
        }
      } catch (_) {}
      console.log(`[liveLocationExpiry] Swept ${rows.length} expired session(s)`);
    }
  } catch (err) {
    console.warn('[liveLocationExpiry] Sweep error (non-fatal):', err.message);
  }
}

function startExpirySweep(sequelize, intervalMs = 60 * 1000) {
  if (_sweepInterval) return;
  _sweepInterval = setInterval(() => sweepExpiredSessions(sequelize), intervalMs);
  _sweepInterval.unref(); // don't keep the process alive if everything else exits
  console.log('[liveLocationExpiry] Expiry sweep started (interval:', intervalMs, 'ms)');
}

function stopExpirySweep() {
  if (_sweepInterval) { clearInterval(_sweepInterval); _sweepInterval = null; }
}

module.exports = { startExpirySweep, stopExpirySweep, sweepExpiredSessions };
