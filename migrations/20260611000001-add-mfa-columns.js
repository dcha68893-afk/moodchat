'use strict';

// P2 FIX (Forensic Audit): adds Two-Factor Authentication (TOTP) support.
// mfaSecret  - base32 TOTP secret (encrypted at rest is recommended; stored
//              plain here consistent with current model conventions, but
//              should be encrypted via app-level field encryption in a
//              follow-up if/when a KMS is available)
// mfaEnabled - whether the user has completed 2FA setup and enabled it
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'mfaSecret', {
      type: Sequelize.STRING,
      allowNull: true
    });

    await queryInterface.addColumn('Users', 'mfaEnabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'mfaSecret');
    await queryInterface.removeColumn('Users', 'mfaEnabled');
  }
};
