'use strict';

// FIX (2FA audit): mfaBackupCodes was referenced by routes/settings.js
// (/2fa/setup, /2fa/disable) but was never added as a real column via
// migration — Sequelize silently dropped it on every user.update() since
// it wasn't a defined model attribute either, so backup codes were shown
// to the user once and then permanently lost. This migration adds the
// column; src/models/Users.js now also declares it as a model attribute.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'mfaBackupCodes', {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'mfaBackupCodes');
  },
};
