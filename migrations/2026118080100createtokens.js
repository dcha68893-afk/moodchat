'use strict';
// PATCHED — this file is a duplicate of 20260118080100createtokens.js
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
    const __exists = __tables.some(t => String(t).toLowerCase() === 'tokens');
    if (__exists) {
      console.log('[Migration] Skipping duplicate migration — Tokens table already exists (created by the correctly-named 20260118... migration).');
      return;
    }
    // Check if table already exists
    const tableExists = await queryInterface.tableExists('Tokens');
    
    if (!tableExists) {
      await queryInterface.createTable('Tokens', {
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
        token: {
          type: Sequelize.TEXT,
          allowNull: false
        },
        type: {
          type: Sequelize.STRING,
          allowNull: false,
          defaultValue: 'refresh'
        },
        isRevoked: {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
          allowNull: false
        },
        expiresAt: {
          type: Sequelize.DATE,
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

      // Add indexes with explicit names
      await queryInterface.addIndex('Tokens', ['token'], {
        name: 'tokens_token_idx'
      });
      
      await queryInterface.addIndex('Tokens', ['userId'], {
        name: 'tokens_user_id_idx'
      });
      
      await queryInterface.addIndex('Tokens', ['expiresAt'], {
        name: 'tokens_expires_at_idx'
      });
    } else {
      console.log('Tokens table already exists, skipping creation.');
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Tokens');
  }
};