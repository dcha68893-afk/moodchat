'use strict';
/**
 * Migration: fix-tools-marketplace-schema
 * ─────────────────────────────────────────────────────────────────────────
 * The original 2026118081500createtools.js migration only created 4 columns
 * (id, name, description, type, createdAt, updatedAt) with integer PK.
 * The Tool Sequelize model expects a full marketplace schema with UUID PK,
 * seller_id, title, price, category, images[], savedBy[], status enum, etc.
 *
 * Strategy:
 *  1. Rename the old minimal table to Tools_legacy (preserves any data)
 *  2. Create the correct marketplace Tools table
 *  3. Down: reverse the above
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // ── Check if the fix has already been applied ──
      const tableDesc = await queryInterface.describeTable('Tools').catch(() => null);
      if (tableDesc && tableDesc.seller_id) {
        // Already migrated — nothing to do
        await transaction.commit();
        return;
      }

      // ── 1. Rename old table so we don't lose data ──
      const hasLegacy = await queryInterface.describeTable('Tools_legacy').catch(() => null);
      if (!hasLegacy && tableDesc) {
        await queryInterface.renameTable('Tools', 'Tools_legacy', { transaction });
      } else if (tableDesc) {
        // legacy already exists — just drop the broken one
        await queryInterface.dropTable('Tools', { transaction });
      }

      // ── 2. Create the correct marketplace Tools table ──
      await queryInterface.createTable('Tools', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        seller_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        title: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        price: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0,
        },
        category: {
          type: Sequelize.STRING(100),
          allowNull: false,
          defaultValue: 'other',
        },
        type: {
          type: Sequelize.ENUM('service', 'digital', 'premium', 'physical'),
          allowNull: false,
          defaultValue: 'physical',
        },
        images: {
          type: Sequelize.ARRAY(Sequelize.TEXT),
          defaultValue: [],
        },
        tags: {
          type: Sequelize.ARRAY(Sequelize.STRING),
          defaultValue: [],
        },
        available: {
          type: Sequelize.BOOLEAN,
          defaultValue: true,
        },
        is_premium: {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
        },
        is_spotlight: {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
        },
        is_featured: {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
        },
        is_boosted: {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
        },
        boost_expires_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        views: {
          type: Sequelize.INTEGER,
          defaultValue: 0,
        },
        saved_by: {
          type: Sequelize.ARRAY(Sequelize.UUID),
          defaultValue: [],
        },
        purchased_by: {
          type: Sequelize.ARRAY(Sequelize.UUID),
          defaultValue: [],
        },
        rating: {
          type: Sequelize.DECIMAL(3, 2),
          defaultValue: 0,
        },
        rating_count: {
          type: Sequelize.INTEGER,
          defaultValue: 0,
        },
        status: {
          type: Sequelize.ENUM('active', 'inactive', 'sold', 'deleted'),
          defaultValue: 'active',
          allowNull: false,
        },
        currency: {
          type: Sequelize.STRING(10),
          defaultValue: 'USD',
        },
        stock: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        metadata: {
          type: Sequelize.JSONB,
          defaultValue: {},
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
      }, { transaction });

      // ── 3. Add indexes ──
      await queryInterface.addIndex('Tools', ['seller_id'],   { name: 'idx_tools_seller_id',   transaction });
      await queryInterface.addIndex('Tools', ['status'],      { name: 'idx_tools_status',       transaction });
      await queryInterface.addIndex('Tools', ['category'],    { name: 'idx_tools_category',     transaction });
      await queryInterface.addIndex('Tools', ['available'],   { name: 'idx_tools_available',    transaction });
      await queryInterface.addIndex('Tools', ['is_featured'], { name: 'idx_tools_is_featured',  transaction });
      await queryInterface.addIndex('Tools', ['createdAt'],   { name: 'idx_tools_created_at',   transaction });

      await transaction.commit();
      console.log('[Migration] ✅ Tools marketplace schema applied successfully');
    } catch (err) {
      await transaction.rollback();
      console.error('[Migration] ❌ Tools marketplace schema failed:', err.message);
      throw err;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('Tools', { transaction });
      // Restore legacy if it exists
      const hasLegacy = await queryInterface.describeTable('Tools_legacy').catch(() => null);
      if (hasLegacy) {
        await queryInterface.renameTable('Tools_legacy', 'Tools', { transaction });
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
