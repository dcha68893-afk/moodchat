'use strict';

/**
 * Migration: New Settings JSONB columns + Users MFA columns
 * Idempotent — safe to run multiple times.
 */
module.exports = {
  async up(queryInterface, Sequelize) {

    // ── Settings ────────────────────────────────────────────────────────────
    const sInfo = await queryInterface.describeTable('settings').catch(() => null);
    if (sInfo) {
      const sCols = {
        mood_settings:     Sequelize.JSONB,
        call_settings:     Sequelize.JSONB,
        friend_settings:   Sequelize.JSONB,
        group_settings:    Sequelize.JSONB,
        status_settings:   Sequelize.JSONB,
        backup_settings:   Sequelize.JSONB,
        advanced_settings: Sequelize.JSONB,
      };
      for (const [col, type] of Object.entries(sCols)) {
        if (!sInfo[col]) {
          await queryInterface.addColumn('settings', col, { type, allowNull: true });
          console.log('[Migration] Added settings.' + col);
        }
      }
    }

    // ── Users ────────────────────────────────────────────────────────────────
    const uInfo = await queryInterface.describeTable('Users').catch(() => null);
    if (uInfo) {
      const uCols = {
        mfa_enabled:      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        mfa_secret:       { type: Sequelize.STRING,  allowNull: true },
        mfa_backup_codes: { type: Sequelize.JSONB,   allowNull: true },
        deletedAt:        { type: Sequelize.DATE,    allowNull: true },
      };
      for (const [col, def] of Object.entries(uCols)) {
        if (!uInfo[col]) {
          await queryInterface.addColumn('Users', col, def);
          console.log('[Migration] Added Users.' + col);
        }
      }
    }
  },

  async down(queryInterface) {
    for (const col of ['mood_settings','call_settings','friend_settings','group_settings','status_settings','backup_settings','advanced_settings'])
      await queryInterface.removeColumn('settings', col).catch(() => {});
    for (const col of ['mfa_enabled','mfa_secret','mfa_backup_codes','deletedAt'])
      await queryInterface.removeColumn('Users', col).catch(() => {});
  }
};
