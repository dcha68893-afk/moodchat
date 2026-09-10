'use strict';

// DELETE-FOR-ME REBUILD (multi-recipient safe)
// -----------------------------------------------------------------------------
// The live "delete for me" path (routes/messages.js DELETE /:messageId with
// deleteForEveryone=false) already worked correctly for direct chats by
// storing the requesting user's id in Messages.metadata.deletedFor (a JSON
// array) — that part is NOT being replaced here, it's kept as-is.
//
// This table is additive: a proper per-(message,user) row for two things the
// JSON-array approach can't do well —
//   1. Bulk "select multiple messages -> delete for me" without read-modify
//      -write races on a shared JSON column when done many-at-once.
//   2. A clean, indexed way for the message list query to exclude a user's
//      own deleted-for-me messages without a `metadata -> 'x' ? :id` operator
//      on every page load.
// Nothing reads or writes Messages.metadata.deletedFor differently — both
// mechanisms are consulted (see messageService additions).
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('message_deletions')) {
      await queryInterface.createTable('message_deletions', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
        },
        messageId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Messages', key: 'id' },
          onDelete: 'CASCADE',
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onDelete: 'CASCADE',
        },
        deletedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
      });

      await queryInterface.addIndex('message_deletions', ['messageId', 'userId'], {
        unique: true,
        name: 'uniq_message_deletions_message_user',
      });
      await queryInterface.addIndex('message_deletions', ['userId'], {
        name: 'idx_message_deletions_user',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('message_deletions').catch(() => {});
  },
};
