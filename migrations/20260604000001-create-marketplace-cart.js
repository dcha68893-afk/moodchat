'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create marketplace_carts table
    await queryInterface.createTable('marketplace_carts', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      // FIX (MARKETPLACE-CART-TYPE-MISMATCH / MIGRATION-BATCH-BLOCKER):
      // this was declared Sequelize.UUID, but Users.id is a plain
      // auto-increment INTEGER (see 20260118080000createusers.js), so
      // Postgres refused to create the FK constraint:
      //   foreign key constraint "marketplace_carts_user_id_fkey" cannot be
      //   implemented — Key columns "user_id" and "id" are of incompatible
      //   types: uuid and integer.
      // That's a hard failure on a genuinely fresh database, and because
      // the production entrypoint (`npm run start:render` ->
      // `db:migrate:render && npm run prod`) does NOT swallow a failed
      // migration the way plain `npm start` does, every migration below
      // this one in the run order — including group/message schema
      // catch-ups and the chats/chat_participants migration — never ran.
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,  // One cart per user
        references: {
          model: 'Users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      items: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: '[]',
        comment: 'Array of cart items [{product_id,seller_id,title,price,quantity,image,variant}]',
      },
      currency: {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'KES',
      },
      coupon_code: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      discount_amount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Auto-expires 30 days after last access',
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: '{}',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    // FIX-ROOT-CAUSE-MIGRATION-INDEX-ALREADY-EXISTS: queryInterface.addIndex()
    // generates a plain `CREATE [UNIQUE] INDEX "name" ON ...` with no
    // `IF NOT EXISTS` guard, and Sequelize CLI migrations are NOT swallowed
    // by the production entrypoint (see the FIX comment above on `up()`) —
    // a failure here throws and aborts `db:migrate:render` entirely, which
    // per that same comment means every migration listed AFTER this file
    // never runs on that deploy. This index (and the table it's on) can
    // already exist without Sequelize's own migration-tracking table
    // (SequelizeMeta) recording this migration as applied — e.g. if the
    // table was ever created out-of-band by Cart.js's own model sync
    // (models/index.js's "Creating N missing tables via sync" step, which
    // runs BEFORE these tracked migrations) — so a subsequent, genuinely
    // first attempt to run this migration hits "relation already exists"
    // and takes down the whole migration run. Raw SQL with
    // IF NOT EXISTS is unconditionally safe to re-run.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_user_unique ON marketplace_carts (user_id);`
    );

    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_cart_expires ON marketplace_carts (expires_at);`
    );

    console.log('[Migration] ✅ marketplace_carts table created');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('marketplace_carts');
    console.log('[Migration] ✅ marketplace_carts table dropped');
  },
};
