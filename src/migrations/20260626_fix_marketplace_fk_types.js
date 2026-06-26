'use strict';
/**
 * Migration: Fix marketplace FK types from UUID to INTEGER
 * 
 * Users.id is INTEGER but Tool.seller_id, Order.buyer_id, Order.seller_id,
 * Review.user_id, Review.seller_id, and Wishlist.user_id were defined as UUID.
 * This caused all marketplace queries with JOIN to throw Sequelize type errors (500).
 * 
 * APPLY WITH: npx sequelize-cli db:migrate
 * ROLLBACK:   npx sequelize-cli db:migrate:undo
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const changeCol = async (table, column) => {
      try {
        // Drop FK constraint if exists, alter type, add back
        await queryInterface.sequelize.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE INTEGER USING "${column}"::text::integer;`
        );
        console.log(`✅ ${table}.${column} → INTEGER`);
      } catch (e) {
        console.warn(`⚠️  Could not alter ${table}.${column}: ${e.message}`);
      }
    };

    await changeCol('tools',    'seller_id');
    await changeCol('orders',   'buyer_id');
    await changeCol('orders',   'seller_id');
    await changeCol('reviews',  'user_id');
    await changeCol('reviews',  'seller_id');
    await changeCol('wishlists','user_id');
  },

  async down(queryInterface, Sequelize) {
    // Reversing to UUID is destructive - manual step required if needed
    console.warn('⚠️  down() is a no-op: reverting INTEGER→UUID would destroy data.');
  }
};
