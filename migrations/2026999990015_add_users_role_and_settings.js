'use strict';

/**
 * FIX (SCHEMA-DRIFT-USERS): src/models/Users.js defines `role` and `settings`
 * columns that no migration in this repo ever created. Running `db:migrate`
 * against a genuinely clean database (verified locally with Postgres 16)
 * fails downstream at registration with:
 *   "column \"role\" does not exist"
 *   "column \"settings\" does not exist"
 * because the app relies on these columns existing without ever declaring
 * them here. Any environment whose schema wasn't hand-patched or bootstrapped
 * via sequelize.sync() at some point will hit this. This migration makes the
 * migrations directory the source of truth for both columns, matching the
 * model defaults in src/models/Users.js.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Users');

    if (!table.role) {
      await queryInterface.addColumn('Users', 'role', {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'user',
      });
    }

    if (!table.settings) {
      await queryInterface.addColumn('Users', 'settings', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {
          notifications: {
            messages: true,
            friendRequests: true,
            mentions: true,
            calls: true,
          },
          privacy: {
            showOnline: true,
            showLastSeen: true,
            allowFriendRequests: true,
            allowMessages: 'friends',
          },
        },
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Users');
    if (table.settings) await queryInterface.removeColumn('Users', 'settings');
    if (table.role) await queryInterface.removeColumn('Users', 'role');
  },
};
