'use strict';

/**
 * BUG-001 FIX: chats table isArchived / isActive columns have no DB-level DEFAULT.
 *
 * Root cause: Both columns are defined in the Sequelize model with defaultValue
 * but were added to Postgres without a column-level DEFAULT. Raw SQL INSERTs
 * (like the one in src/routes/messages.js that creates a chat when a non-friend
 * sends the first message) omit these columns entirely, leaving them NULL.
 *
 * Impact: GET /chats filters WHERE isArchived = false. NULL != false in SQL, so
 * newly created chats via the messages route are INVISIBLE in the sidebar —
 * making it appear that messaging a non-friend "doesn't work" even though the
 * message was stored correctly in the database.
 *
 * Fix: SET DB-level DEFAULT on both columns, and backfill any existing NULLs.
 */
module.exports = {
  async up(queryInterface) {
    // Set DB-level defaults so raw INSERTs omitting these columns get correct values
    await queryInterface.sequelize.query(`
      ALTER TABLE chats
        ALTER COLUMN "isActive"   SET DEFAULT true,
        ALTER COLUMN "isArchived" SET DEFAULT false;
    `).catch(e => console.warn('[migration] ALTER DEFAULT (non-fatal):', e.message));

    // Backfill any existing NULLs left by prior raw INSERTs
    await queryInterface.sequelize.query(`
      UPDATE chats SET "isActive" = true WHERE "isActive" IS NULL;
    `).catch(() => {});

    await queryInterface.sequelize.query(`
      UPDATE chats SET "isArchived" = false WHERE "isArchived" IS NULL;
    `).catch(() => {});

    // Now make them NOT NULL at DB level to match the Sequelize model
    await queryInterface.sequelize.query(`
      ALTER TABLE chats
        ALTER COLUMN "isActive"   SET NOT NULL,
        ALTER COLUMN "isArchived" SET NOT NULL;
    `).catch(e => console.warn('[migration] SET NOT NULL (non-fatal if already set):', e.message));
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE chats
        ALTER COLUMN "isActive"   DROP DEFAULT,
        ALTER COLUMN "isArchived" DROP DEFAULT;
    `).catch(() => {});
  }
};
