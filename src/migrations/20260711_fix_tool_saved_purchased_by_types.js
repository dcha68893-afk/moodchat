'use strict';
/**
 * Migration: Fix tools.saved_by / tools.purchased_by column types
 *
 * Same class of bug as 20260626_fix_marketplace_fk_types.js: these two array
 * columns were declared UUID[] while Users.id is INTEGER. Any push of a real
 * userId into either array (or Tool.getSavedListings()'s
 * `savedBy: { [Op.contains]: [userId] }` query) fails with
 * "invalid input syntax for type uuid" — the cause of the 500 on
 * GET /api/tools/marketplace/wishlist.
 *
 * Because a uuid[] column can never have accepted a plain integer userId,
 * these columns should only ever contain '{}' (empty) in production — so
 * there's no real data to preserve, just a type to correct.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 */

module.exports = {
  async up(queryInterface) {
    const changeArrayCol = async (table, column) => {
      try {
        await queryInterface.sequelize.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE INTEGER[] USING ARRAY[]::INTEGER[];`
        );
        console.log(`✅ ${table}.${column} → INTEGER[]`);
      } catch (e) {
        console.warn(`⚠️  Could not alter ${table}.${column}: ${e.message}`);
      }
    };

    await changeArrayCol('tools', 'saved_by');
    await changeArrayCol('tools', 'purchased_by');
  },

  async down() {
    console.warn('⚠️  down() is a no-op: reverting INTEGER[]→UUID[] would destroy data.');
  }
};
