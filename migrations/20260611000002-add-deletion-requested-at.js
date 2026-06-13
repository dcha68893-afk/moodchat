'use strict';

// P2 FIX (Forensic Audit): "Implement account deletion (right to erasure)"
// deletionRequestedAt marks when a user requested deletion; a scheduled job
// should permanently purge accounts where this is >30 days in the past.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'deletionRequestedAt', {
      type: Sequelize.DATE,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'deletionRequestedAt');
  }
};
