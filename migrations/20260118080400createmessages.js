'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Messages', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      senderId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      receiverId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      // FIX (MIGRATION-ORDER-GROUPS): groupId used to declare an inline FK
      // `references: { model: 'Groups' }` right here, but this migration
      // (20260118080400) runs before 20260118080600creategroup.js creates
      // the Groups table — Postgres has no forward references, so a genuinely
      // fresh `db:migrate` run aborted immediately with
      // `relation "Groups" does not exist`, and because `npm start` runs
      // migrations as `(npm run db:migrate || true)`, that fatal failure was
      // silently swallowed and every migration after this one in the batch
      // never ran. Reproduced locally against a clean Postgres 16 database.
      // The column is created here as a plain nullable INTEGER; the actual
      // FK constraint is added by 20260118080600creategroup.js once Groups
      // exists, so referential integrity is still enforced end-to-end.
      groupId: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      type: {
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
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Messages');
  }
};