// 20260120000700-createuserstatus.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const __tables = await queryInterface.showAllTables();
    const __exists = __tables.some(t => String(t).toLowerCase() === 'userstatus');
    if (__exists) {
      console.log('[Migration] Skipping duplicate migration — UserStatus table already exists (created by the correctly-named 20260118... migration).');
      return;
    }
    await queryInterface.createTable('UserStatus', {
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
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'offline'
      },
      lastActive: {
        type: Sequelize.DATE,
        allowNull: true
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

    // Add unique index for user status (one status per user)
    await queryInterface.addIndex('UserStatus', ['userId'], {
      unique: true,
      name: 'user_status_user_id_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('UserStatus');
  }
};