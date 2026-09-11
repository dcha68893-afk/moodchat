"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const settingsTable = tables.find(t => String(t).toLowerCase() === 'settings');
    if (!settingsTable) return;

    const columns = await queryInterface.describeTable(settingsTable);
    if (!columns.security_settings) {
      await queryInterface.addColumn(settingsTable, 'security_settings', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {
          sessionTimeout: '8h'
        }
      });
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const settingsTable = tables.find(t => String(t).toLowerCase() === 'settings');
    if (!settingsTable) return;
    const columns = await queryInterface.describeTable(settingsTable);
    if (columns.security_settings) {
      await queryInterface.removeColumn(settingsTable, 'security_settings');
    }
  }
};
