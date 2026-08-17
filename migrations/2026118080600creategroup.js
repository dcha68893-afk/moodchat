'use strict';
// PATCHED — this file is a duplicate of 20260118080600creategroup.js
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
    const __exists = __tables.some(t => String(t).toLowerCase() === 'groups');
    if (__exists) {
      console.log('[Migration] Skipping duplicate migration — Groups table already exists (created by the correctly-named 20260118... migration).');
      return;
    }
    await queryInterface.createTable('Groups', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
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

    // FIX (MIGRATION-ORDER-GROUPS): matches the constraint added in
    // 20260118080600creategroup.js — see that file for the full explanation.
    // Only reached if this duplicate is the one that actually creates
    // Groups (the __exists guard above skips it otherwise), so guard against
    // the constraint already existing too.
    const __constraints = await queryInterface.showConstraint
      ? await queryInterface.showConstraint('Messages', 'Messages_groupId_fkey').catch(() => null)
      : null;
    if (!__constraints) {
      await queryInterface.addConstraint('Messages', {
        fields: ['groupId'],
        type: 'foreign key',
        name: 'Messages_groupId_fkey',
        references: {
          table: 'Groups',
          field: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      }).catch(() => {});
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('Messages', 'Messages_groupId_fkey').catch(() => {});
    await queryInterface.dropTable('Groups');
  }
};