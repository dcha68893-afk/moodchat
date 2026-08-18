'use strict';

// P2 FIX (Forensic Audit): adds Two-Factor Authentication (TOTP) support.
// mfaSecret  - base32 TOTP secret (encrypted at rest is recommended; stored
//              plain here consistent with current model conventions, but
//              should be encrypted via app-level field encryption in a
//              follow-up if/when a KMS is available)
// mfaEnabled - whether the user has completed 2FA setup and enabled it
module.exports = {
  async up(queryInterface, Sequelize) {
    // FIX (PROD-SCHEMA-DRIFT): same class of bug as
    // 20260324075223-add-reset-token.js — this project's own in-app runtime
    // migration system may already have added these columns before
    // `db:migrate` runs, which made a bare addColumn fail with "column
    // already exists" and silently block every migration after it. Guard.
    const cols = await queryInterface.describeTable('Users');
    if (!cols.mfaSecret) {
      await queryInterface.addColumn('Users', 'mfaSecret', {
        type: Sequelize.STRING,
        allowNull: true
      });
    }
    if (!cols.mfaEnabled) {
      await queryInterface.addColumn('Users', 'mfaEnabled', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'mfaSecret').catch(() => {});
    await queryInterface.removeColumn('Users', 'mfaEnabled').catch(() => {});
  }
};
