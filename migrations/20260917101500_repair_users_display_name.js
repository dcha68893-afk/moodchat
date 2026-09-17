'use strict';

/**
 * Compatibility repair for the Users search route.
 *
 * The route historically selected Users.displayName, while the live Users
 * table in some deployments only contains firstName/lastName/username.
 * Keep displayName as a nullable compatibility column and backfill it from
 * the existing profile fields. This makes /api/users/search work without
 * changing or exposing passwords/settings.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const [columns] = await sequelize.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Users'
    `);

    const names = new Set(columns.map(c => c.column_name));
    if (!names.has('displayName')) {
      await queryInterface.addColumn('Users', 'displayName', {
        type: Sequelize.STRING(160),
        allowNull: true,
      });
    }

    // Populate only empty values; never overwrite a custom display name.
    await sequelize.query(`
      UPDATE "Users"
      SET "displayName" = NULLIF(TRIM(CONCAT_WS(' ', "firstName", "lastName")), '')
      WHERE "displayName" IS NULL
    `);
  },

  async down(queryInterface) {
    const [columns] = await queryInterface.sequelize.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Users'
        AND column_name = 'displayName'
    `);
    if (columns.length) await queryInterface.removeColumn('Users', 'displayName');
  }
};
