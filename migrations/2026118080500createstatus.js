'use strict';
// PATCHED — this file is a duplicate of 20260118080500createstatus.js
// (filename is missing a digit: "2026118..." instead of "20260118..."). Since both files
// have different names, sequelize-cli treats them as two separate migrations and runs both.
// The original (un-patched) version of this file re-ran `createTable(...)` on a table the
// other migration had already created, which threw "relation already exists" and aborted
// the ENTIRE migration batch at this point — silently, because `npm start` runs migrations
// as `(npm run db:migrate || true)`. Every migration below this one in the run order
// (including 2026999990016_fix_group_module_missing_columns.js, which adds
// Groups.enabledModules and GroupTasks.metadata) never actually executed.
// This guard makes the migration a safe no-op once the table already exists, so the
// batch can proceed to the migrations after it.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const __tables = await queryInterface.showAllTables();
    const __exists = __tables.some(t => String(t).toLowerCase() === 'status');
    if (__exists) {
      console.log('[Migration] Skipping duplicate migration — Status table already exists (created by the correctly-named 20260118... migration).');
      return;
    }
    await queryInterface.createTable('Status', {
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
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      type: {
        type: Sequelize.STRING,
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
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Status');
  }
};