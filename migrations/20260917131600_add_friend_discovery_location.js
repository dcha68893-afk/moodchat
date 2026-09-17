const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const table = await queryInterface.describeTable('Users');
    if (!table.latitude) await queryInterface.addColumn('Users', 'latitude', { type: DataTypes.DECIMAL(10, 7), allowNull: true });
    if (!table.longitude) await queryInterface.addColumn('Users', 'longitude', { type: DataTypes.DECIMAL(10, 7), allowNull: true });
    if (!table.locationUpdatedAt) await queryInterface.addColumn('Users', 'locationUpdatedAt', { type: DataTypes.DATE, allowNull: true });
  },
  async down(queryInterface) {
    const table = await queryInterface.describeTable('Users');
    if (table.locationUpdatedAt) await queryInterface.removeColumn('Users', 'locationUpdatedAt');
    if (table.longitude) await queryInterface.removeColumn('Users', 'longitude');
    if (table.latitude) await queryInterface.removeColumn('Users', 'latitude');
  }
};
