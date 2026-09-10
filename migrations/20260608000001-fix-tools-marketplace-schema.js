'use strict';
/**
 * Migration: fix-tools-marketplace-schema
 *
 * Repairs the legacy Tools table without assuming that a previous/partial
 * deployment left the database in a pristine state. In particular, index
 * names are schema-wide in PostgreSQL, so blindly calling addIndex() can fail
 * with "relation ... already exists" when an earlier attempt created an index
 * but did not record this migration in SequelizeMeta.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tableDesc = await queryInterface.describeTable('Tools').catch(() => null);
      if (tableDesc && tableDesc.seller_id) {
        await transaction.commit();
        return;
      }

      const hasLegacy = await queryInterface.describeTable('Tools_legacy').catch(() => null);
      if (!hasLegacy && tableDesc) {
        await queryInterface.renameTable('Tools', 'Tools_legacy', { transaction });
      } else if (tableDesc) {
        await queryInterface.dropTable('Tools', { transaction });
      }

      await queryInterface.createTable('Tools', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        seller_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        title: { type: Sequelize.STRING(255), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: true },
        price: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        category: { type: Sequelize.STRING(100), allowNull: false, defaultValue: 'other' },
        type: {
          type: Sequelize.ENUM('service', 'digital', 'premium', 'physical'),
          allowNull: false,
          defaultValue: 'physical',
        },
        images: { type: Sequelize.ARRAY(Sequelize.TEXT), defaultValue: [] },
        tags: { type: Sequelize.ARRAY(Sequelize.STRING), defaultValue: [] },
        available: { type: Sequelize.BOOLEAN, defaultValue: true },
        is_premium: { type: Sequelize.BOOLEAN, defaultValue: false },
        is_spotlight: { type: Sequelize.BOOLEAN, defaultValue: false },
        is_featured: { type: Sequelize.BOOLEAN, defaultValue: false },
        is_boosted: { type: Sequelize.BOOLEAN, defaultValue: false },
        boost_expires_at: { type: Sequelize.DATE, allowNull: true },
        views: { type: Sequelize.INTEGER, defaultValue: 0 },
        saved_by: { type: Sequelize.ARRAY(Sequelize.INTEGER), defaultValue: [] },
        purchased_by: { type: Sequelize.ARRAY(Sequelize.INTEGER), defaultValue: [] },
        rating: { type: Sequelize.DECIMAL(3, 2), defaultValue: 0 },
        rating_count: { type: Sequelize.INTEGER, defaultValue: 0 },
        status: {
          type: Sequelize.ENUM('active', 'inactive', 'sold', 'deleted'),
          defaultValue: 'active',
          allowNull: false,
        },
        currency: { type: Sequelize.STRING(10), defaultValue: 'USD' },
        stock: { type: Sequelize.INTEGER, allowNull: true },
        metadata: { type: Sequelize.JSONB, defaultValue: {} },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      // PostgreSQL index names are schema-wide. Use CREATE INDEX IF NOT EXISTS
      // so a partially-applied historical deployment cannot block the whole
      // migration chain merely because the named index already exists.
      const indexes = [
        ['idx_tools_seller_id', 'seller_id'],
        ['idx_tools_status', 'status'],
        ['idx_tools_category', 'category'],
        ['idx_tools_available', 'available'],
        ['idx_tools_is_featured', 'is_featured'],
        ['idx_tools_created_at', 'createdAt'],
      ];

      for (const [name, column] of indexes) {
        const quotedTable = queryInterface.sequelize.getQueryInterface()
          ? queryInterface.sequelize.getQueryInterface().quoteIdentifier('Tools')
          : '"Tools"';
        const quotedColumn = queryInterface.sequelize.getQueryInterface()
          ? queryInterface.sequelize.getQueryInterface().quoteIdentifier(column)
          : `"${column}"`;
        const quotedName = queryInterface.sequelize.getQueryInterface()
          ? queryInterface.sequelize.getQueryInterface().quoteIdentifier(name)
          : `"${name}"`;

        await queryInterface.sequelize.query(
          `CREATE INDEX IF NOT EXISTS ${quotedName} ON ${quotedTable} (${quotedColumn})`,
          { transaction }
        );
      }

      await transaction.commit();
      console.log('[Migration] ✅ Tools marketplace schema applied successfully');
    } catch (err) {
      await transaction.rollback();
      console.error('[Migration] ❌ Tools marketplace schema failed:', err.message);
      throw err;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('Tools', { transaction });
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
