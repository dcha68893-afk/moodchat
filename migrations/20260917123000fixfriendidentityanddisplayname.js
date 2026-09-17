'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // The live Users table predates the current user-search route, which asks
    // PostgreSQL for Users.displayName. Add the column once, then backfill it
    // from the canonical first/last-name fields. This keeps the existing route
    // contract working without replacing the Users model or breaking older
    // clients that still expect displayName.
    const table = await queryInterface.describeTable('Users');

    if (!table.displayName) {
      await queryInterface.addColumn('Users', 'displayName', {
        type: Sequelize.STRING(255),
        allowNull: true,
      });
    }

    // Keep existing display names if a deployment already populated some of
    // them. Only fill missing/blank values from the real Users columns.
    await queryInterface.sequelize.query(`
      UPDATE "Users"
      SET "displayName" = NULLIF(BTRIM(CONCAT_WS(' ', "firstName", "lastName")), '')
      WHERE "displayName" IS NULL
         OR BTRIM("displayName") = ''
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Users"
      SET "displayName" = "username"
      WHERE ("displayName" IS NULL OR BTRIM("displayName") = '')
        AND "username" IS NOT NULL
    `);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Users');
    if (table.displayName) {
      await queryInterface.removeColumn('Users', 'displayName');
    }
  },
};
