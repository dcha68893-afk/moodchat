'use strict';
/**
 * Migration: create starred_messages table
 *
 * Root cause: src/models/StarredMessage.js defines this table (userId,
 * messageId, chatId, starredAt, unique on [userId, messageId]) and
 * src/routes/devices.js's GET /sync and the messaging routes' starred
 * endpoints both query it directly — but no migration, in either the
 * sequelize-cli `migrations/` folder or the hand-rolled boot-time schema
 * flow in src/models/index.js, ever creates it. The relation has never
 * existed in the database, so every query against it 500s with
 * "relation \"starred_messages\" does not exist".
 *
 * Columns intentionally use default (camelCase) naming — StarredMessage.js
 * has no `field:` overrides, and the raw SQL in devices.js's /sync route
 * already queries "messageId"/"chatId"/"starredAt"/"userId" quoted exactly
 * like that.
 *
 * Idempotent (IF NOT EXISTS) so it's safe to run on every boot alongside
 * the other startup migration paths in this app.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 * ROLLBACK:   npx sequelize-cli db:migrate:undo
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface.describeTable('starred_messages').catch(() => null);
    if (tableExists) {
      console.log('starred_messages already exists — skipping create');
      return;
    }

    await queryInterface.createTable('starred_messages', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      messageId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      chatId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      starredAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex('starred_messages', ['userId']);
    await queryInterface.addIndex('starred_messages', ['messageId']);
    await queryInterface.addIndex('starred_messages', ['chatId']);
    await queryInterface.addIndex('starred_messages', ['userId', 'messageId'], {
      unique: true,
      name: 'starred_messages_user_id_message_id_unique',
    });

    console.log('✅ starred_messages table created');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('starred_messages');
  },
};
