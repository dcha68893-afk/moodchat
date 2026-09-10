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
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        seller_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        title: { type: Sequelize.STRING(255), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: true },
        price: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
        category: { type: Sequelize.STRING(100), allowNull: false, defaultValue: 'other' },
        type: { type: Sequelize.ENUM('service', 'digital', 'premium', 'physical'), allowNull: false, defaultValue: 'physical' },
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
        status: { type: Sequelize.ENUM('active', 'inactive', 'sold', 'deleted'), defaultValue: 'active', allowNull: false },
        currency: { type: Sequelize.STRING(10), defaultValue: 'USD' },
        stock: { type: Sequelize.INTEGER, allowNull: true },
        metadata: { type: Sequelize.JSONB, defaultValue: {} },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      const indexes = [
        ['idx_tools_seller_id', 'seller_id'],
        ['idx_tools_status', 'status'],
        ['idx_tools_category', 'category'],
        ['idx_tools_available', 'available'],
        ['idx_tools_is_featured', 'is_featured'],
        ['idx_tools_created_at', 'createdAt'],
      ];

      // PostgreSQL index names are schema-wide. A failed historical run can
      // leave one of these names attached to Tools_legacy (or another table).
      // In that case IF NOT EXISTS would silently skip creating the required
      // index on Tools. Move the stale index out of the way first.
      for (const [name, column] of indexes) {
        const [rows] = await queryInterface.sequelize.query(
          `SELECT tablename FROM pg_indexes WHERE schemaname = current_schema() AND indexname = :name LIMIT 1`,
          { replacements: { name }, transaction }
        );

        if (rows.length && rows[0].tablename !== 'Tools') {
          const legacyName = `${name}_legacy`;
          const [legacyRows] = await queryInterface.sequelize.query(
            `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = :name LIMIT 1`,
            { replacements: { name: legacyName }, transaction }
          );
          if (!legacyRows.length) {
            await queryInterface.sequelize.query(
              `ALTER INDEX "${name}" RENAME TO "${legacyName}"`,
              { transaction }
            );
          } else {
            await queryInterface.sequelize.query(`DROP INDEX "${name}"`, { transaction });
          }
        }

        await queryInterface.sequelize.query(
          `CREATE INDEX IF NOT EXISTS "${name}" ON "Tools" ("${column}")`,
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
      if (hasLegacy) await queryInterface.renameTable('Tools_legacy', 'Tools', { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
