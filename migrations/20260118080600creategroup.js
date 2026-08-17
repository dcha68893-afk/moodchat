'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
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

    // FIX (MIGRATION-ORDER-GROUPS): Messages.groupId is created as a plain
    // nullable column by 20260118080400createmessages.js (which necessarily
    // runs before this migration — see the comment there for why). Now that
    // Groups exists, add the FK constraint here so referential integrity is
    // still enforced, just deferred to the point where it's actually
    // possible to create it.
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
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('Messages', 'Messages_groupId_fkey').catch(() => {});
    await queryInterface.dropTable('Groups');
  }
};