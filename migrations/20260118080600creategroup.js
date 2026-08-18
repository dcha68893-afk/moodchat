'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const tables = await queryInterface.showAllTables();
    const hasTable = (name) => tables.some((t) => String(t).toLowerCase() === name.toLowerCase());

    if (!hasTable('Groups')) {
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
    }

    // FIX (MIGRATION-ORDER-GROUPS / PROD-SCHEMA-DRIFT): originally this just
    // assumed 20260118080400createmessages.js had already added a plain
    // `groupId` column to Messages and jumped straight to addConstraint.
    // That's true on a fresh database, but on a database with real deploy
    // history, `db:migrate` skips any migration filename it already has
    // recorded in SequelizeMeta — regardless of what its CONTENT says now —
    // so a fix to createmessages.js's content never re-runs there, and a
    // production Messages table that predates the groupId column (or whose
    // original run failed/no-opped) is left without it entirely. Then this
    // addConstraint call failed with:
    //   column "groupId" referenced in foreign key constraint does not exist
    // Reproduced against a real deploy. Now this migration checks and adds
    // the column itself if missing, and only adds the constraint if it
    // isn't already there — so it's correct regardless of whether
    // createmessages.js ever actually ran on this specific database.
    const messagesCols = await queryInterface.describeTable('Messages').catch(() => null);
    if (messagesCols && !messagesCols.groupId) {
      await queryInterface.addColumn('Messages', 'groupId', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    if (messagesCols) {
      const [existingConstraint] = await sequelize.query(
        `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Messages_groupId_fkey'`
      );
      if (!existingConstraint.length) {
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
        }).catch((e) => {
          console.warn('[creategroup] could not add Messages_groupId_fkey (non-fatal):', e.message);
        });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('Messages', 'Messages_groupId_fkey').catch(() => {});
    await queryInterface.dropTable('Groups');
  }
};