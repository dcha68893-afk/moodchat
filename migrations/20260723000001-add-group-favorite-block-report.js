'use strict';
// Migration: 20260723000001-add-group-favorite-block-report.js
//
// Backs the group module's favoriteGroup(), blockGroup(), and reportGroup()
// features, which previously had no backend at all (frontend functions were
// empty stubs). notificationsMuted already existed on GroupMembers from an
// earlier migration and is reused as-is for muteGroup().
module.exports = {
  async up(queryInterface, Sequelize) {
    const gmCols = await queryInterface.describeTable('GroupMembers').catch(() => null);
    if (gmCols) {
      if (!gmCols.isFavorite) {
        await queryInterface.addColumn('GroupMembers', 'isFavorite', {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
          allowNull: false,
        });
        console.log('[Migration] Added GroupMembers.isFavorite');
      }
      if (!gmCols.isBlocked) {
        await queryInterface.addColumn('GroupMembers', 'isBlocked', {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
          allowNull: false,
          comment: 'User has blocked this group: hidden from active lists, notifications suppressed. Distinct from leaving or being banned.',
        });
        console.log('[Migration] Added GroupMembers.isBlocked');
      }
    }

    const tables = await queryInterface.showAllTables().catch(() => []);
    if (!tables.includes('GroupReports')) {
      await queryInterface.createTable('GroupReports', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId: { type: Sequelize.INTEGER, allowNull: false },
        reporterId: { type: Sequelize.INTEGER, allowNull: false },
        reason: {
          type: Sequelize.ENUM('spam', 'harassment', 'hate_speech', 'violence', 'sexual_content', 'misinformation', 'other'),
          allowNull: false,
        },
        details: { type: Sequelize.TEXT, allowNull: true },
        status: {
          type: Sequelize.ENUM('pending', 'reviewed', 'actioned', 'dismissed'),
          defaultValue: 'pending',
          allowNull: false,
        },
        reviewedBy: { type: Sequelize.INTEGER, allowNull: true },
        reviewedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await queryInterface.addIndex('GroupReports', ['groupId']);
      await queryInterface.addIndex('GroupReports', ['status']);
      await queryInterface.addIndex('GroupReports', ['reporterId', 'groupId'], { unique: true, name: 'group_reports_reporter_group_unique' });
      console.log('[Migration] Created GroupReports table');
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('GroupReports').catch(() => {});
    await queryInterface.removeColumn('GroupMembers', 'isFavorite').catch(() => {});
    await queryInterface.removeColumn('GroupMembers', 'isBlocked').catch(() => {});
  },
};
