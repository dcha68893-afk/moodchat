'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('marketplace_orders');
    if (!table.invoice_number) {
      await queryInterface.addColumn('marketplace_orders', 'invoice_number', { type: Sequelize.STRING(40), allowNull: true });
    }
    if (!table.invoice_token) {
      await queryInterface.addColumn('marketplace_orders', 'invoice_token', { type: Sequelize.STRING(64), allowNull: true });
    }
    if (!table.invoice_issued_at) {
      await queryInterface.addColumn('marketplace_orders', 'invoice_issued_at', { type: Sequelize.DATE, allowNull: true });
    }
    try { await queryInterface.addIndex('marketplace_orders', ['invoice_number'], { unique: true, name: 'marketplace_orders_invoice_number_uq' }); } catch (_) {}
    try { await queryInterface.addIndex('marketplace_orders', ['invoice_token'], { unique: true, name: 'marketplace_orders_invoice_token_uq' }); } catch (_) {}
  },

  async down(queryInterface) {
    try { await queryInterface.removeIndex('marketplace_orders', 'marketplace_orders_invoice_number_uq'); } catch (_) {}
    try { await queryInterface.removeIndex('marketplace_orders', 'marketplace_orders_invoice_token_uq'); } catch (_) {}
    const table = await queryInterface.describeTable('marketplace_orders');
    if (table.invoice_issued_at) await queryInterface.removeColumn('marketplace_orders', 'invoice_issued_at');
    if (table.invoice_token) await queryInterface.removeColumn('marketplace_orders', 'invoice_token');
    if (table.invoice_number) await queryInterface.removeColumn('marketplace_orders', 'invoice_number');
  },
};
