'use strict';

/**
 * Migration: Add new Settings JSONB columns + Users MFA/deletedAt columns
 * All operations are idempotent — safe to run multiple times.
 */
module.exports = {
  async up(queryInterface, Sequelize) {

    // ── Settings table new columns ───────────────────────────────────────────
    const settingsInfo = await queryInterface.describeTable('settings').catch(() => null);
    if (settingsInfo) {
      const newCols = {
        mood_settings:     { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
        call_settings:     { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
        friend_settings:   { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
        group_settings:    { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
        status_settings:   { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
        backup_settings:   { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
        advanced_settings: { type: Sequelize.JSONB, allowNull: true, defaultValue: null },
      };
      for (const [col, def] of Object.entries(newCols)) {
        if (!settingsInfo[col]) {
          await queryInterface.addColumn('settings', col, def);
          console.log(`[Migration] ✅ Added settings.${col}`);
        }
      }
    }

    // ── Users table new columns ──────────────────────────────────────────────
    const usersInfo = await queryInterface.describeTable('Users').catch(() => null);
    if (usersInfo) {
      const newUserCols = {
        mfa_enabled:      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        mfa_secret:       { type: Sequelize.STRING,  allowNull: true },
        mfa_backup_codes: { type: Sequelize.JSONB,   allowNull: true },
        deletedAt:        { type: Sequelize.DATE,    allowNull: true },
      };
      for (const [col, def] of Object.entries(newUserCols)) {
        if (!usersInfo[col]) {
          await queryInterface.addColumn('Users', col, def);
          console.log(`[Migration] ✅ Added Users.${col}`);
        }
      }
    }
  },

  async down(queryInterface) {
    const settingsCols = ['mood_settings','call_settings','friend_settings','group_settings','status_settings','backup_settings','advanced_settings'];
    for (const col of settingsCols) {
      await queryInterface.removeColumn('settings', col).catch(() => {});
    }
    const userCols = ['mfa_enabled','mfa_secret','mfa_backup_codes','deletedAt'];
    for (const col of userCols) {
      await queryInterface.removeColumn('Users', col).catch(() => {});
    }
  }
};
