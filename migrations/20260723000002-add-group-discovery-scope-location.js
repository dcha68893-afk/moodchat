'use strict';
// Migration: 20260723000002-add-group-discovery-scope-location.js
//
// The Group model declares discoveryScope (community/region/county/world)
// and location columns, and groupService.js already filters/searches on
// discoveryScope, but no migration ever actually created these columns —
// every query touching them would fail against the real database. This
// also backs the new optional "Discoverable By" field on group creation.
module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('Groups').catch(() => null);
    if (!cols) return;

    if (!cols.discoveryScope) {
      await queryInterface.addColumn('Groups', 'discoveryScope', {
        type: Sequelize.ENUM('community', 'region', 'county', 'world'),
        defaultValue: 'world',
        allowNull: false,
      });
      console.log('[Migration] Added Groups.discoveryScope');
    }

    if (!cols.location) {
      await queryInterface.addColumn('Groups', 'location', {
        type: Sequelize.STRING(100),
        allowNull: true,
      });
      console.log('[Migration] Added Groups.location');
    }

    await queryInterface.addIndex('Groups', ['discoveryScope']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Groups', 'discoveryScope').catch(() => {});
    await queryInterface.removeColumn('Groups', 'location').catch(() => {});
  },
};
