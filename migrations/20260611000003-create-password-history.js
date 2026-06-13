'use strict';

// P3 FIX (Forensic Audit): "Implement password history (last 5)"
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('password_history', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      password_hash: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('password_history', ['user_id']);
    await queryInterface.addIndex('password_history', ['created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('password_history');
  }
};
