// 20260120000400-createmoods.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const __tables = await queryInterface.showAllTables();
    const __exists = __tables.some(t => String(t).toLowerCase() === 'moods');
    if (__exists) {
      console.log('[Migration] Skipping duplicate migration — Moods table already exists (created by the correctly-named 20260118... migration).');
      return;
    }
    await queryInterface.createTable('Moods', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',  // Foreign key to Users table
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      mood: {
        type: Sequelize.STRING,
        allowNull: false
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Add index for user-based mood queries
    await queryInterface.addIndex('Moods', ['userId'], {
      name: 'moods_user_id_index'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Moods');
  }
};