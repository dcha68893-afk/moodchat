'use strict';
// Savings goals: money the user has set aside (and removed from spendable balance) for a purpose.
// Idempotent: skips if the table already exists.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = (await queryInterface.showAllTables()).map(t => (typeof t === 'string' ? t : t.tableName));
    if (existing.includes('wallet_savings_goals')) return;
    const T = Sequelize;
    await queryInterface.createTable('wallet_savings_goals', {
      id: { type: T.UUID, defaultValue: T.UUIDV4, primaryKey: true, allowNull: false },
      user_id: { type: T.STRING(64), allowNull: false },
      name: { type: T.STRING(80), allowNull: false },
      category: { type: T.STRING(24), allowNull: false, defaultValue: 'personal' }, // school_fees|rent|shopping|emergency|personal
      target_amount: { type: T.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      saved_amount: { type: T.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
      due_date: { type: T.DATEONLY, allowNull: true },
      status: { type: T.STRING(16), allowNull: false, defaultValue: 'active' },      // active|completed|closed
      createdAt: { type: T.DATE, allowNull: false, defaultValue: T.fn('NOW') },
      updatedAt: { type: T.DATE, allowNull: false, defaultValue: T.fn('NOW') },
    });
    await queryInterface.addIndex('wallet_savings_goals', ['user_id'], { name: 'wallet_savings_goals_user_idx' });
    await queryInterface.sequelize.query(`ALTER TABLE "wallet_savings_goals" ADD CONSTRAINT wsg_saved_nonneg CHECK ("saved_amount" >= 0)`);
  },
  async down(queryInterface) { await queryInterface.dropTable('wallet_savings_goals').catch(() => {}); },
};
