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
      user_id: {
        type: Sequelize.UUID,
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

    // Indexes
    await queryInterface.addIndex('marketplace_carts', ['user_id'], {
      unique: true,
      name: 'idx_cart_user_unique',
    });

    await queryInterface.addIndex('marketplace_carts', ['expires_at'], {
      name: 'idx_cart_expires',
    });

    console.log('[Migration] ✅ marketplace_carts table created');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('marketplace_carts');
    console.log('[Migration] ✅ marketplace_carts table dropped');
  },
};
