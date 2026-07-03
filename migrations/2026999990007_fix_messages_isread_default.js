'use strict';

/**
 * BUG-012 FIX: Messages.isRead has no DB-level DEFAULT.
 *
 * Root cause: The Sequelize model defines isRead with defaultValue: false,
 * but raw SQL INSERTs in src/routes/messages.js omit the isRead column entirely.
 * Postgres stores NULL. GET /chats counts unread messages with WHERE isRead = false —
 * NULL != false — so unread counts are always 0 even for genuinely unread messages.
 *
 * Fix: Add DB-level DEFAULT false and NOT NULL, backfill existing NULLs.
 * The allowNull: false constraint in the model is already correct; this migration
 * makes the DB schema match the model definition.
 */
module.exports = {
  async up(queryInterface) {
    // Backfill NULLs first (required before adding NOT NULL constraint)
    await queryInterface.sequelize.query(
      `UPDATE "Messages" SET "isRead" = false WHERE "isRead" IS NULL;`
    ).catch(e => console.warn('[migration] isRead backfill:', e.message));

    // Add DB-level DEFAULT
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isRead" SET DEFAULT false;`
    ).catch(e => console.warn('[migration] isRead DEFAULT:', e.message));

    // Make NOT NULL (matches allowNull: false in the Sequelize model)
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isRead" SET NOT NULL;`
    ).catch(e => console.warn('[migration] isRead NOT NULL (may already be set):', e.message));

    // Also fix isDeleted which has same pattern
    await queryInterface.sequelize.query(
      `UPDATE "Messages" SET "isDeleted" = false WHERE "isDeleted" IS NULL;`
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isDeleted" SET DEFAULT false;`
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isDeleted" SET NOT NULL;`
    ).catch(() => {});

    // Also fix isEdited
    await queryInterface.sequelize.query(
      `UPDATE "Messages" SET "isEdited" = false WHERE "isEdited" IS NULL;`
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isEdited" SET DEFAULT false;`
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isEdited" SET NOT NULL;`
    ).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isRead" DROP DEFAULT;`
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isDeleted" DROP DEFAULT;`
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE "Messages" ALTER COLUMN "isEdited" DROP DEFAULT;`
    ).catch(() => {});
  }
};
