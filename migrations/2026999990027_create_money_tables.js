'use strict';
// Creates the Money module tables (circles, members, contributions, requests).
// Idempotent: skips any table that already exists. Without these tables every
// /api/money/* call fails with HTTP 500.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = (await queryInterface.showAllTables()).map(t => (typeof t === 'string' ? t : t.tableName));
    const has = n => existing.includes(n);
    const T = Sequelize;
    const stamps = { createdAt: { type: T.DATE, allowNull: false, defaultValue: T.fn('NOW') }, updatedAt: { type: T.DATE, allowNull: false, defaultValue: T.fn('NOW') } };
    const uuid = { type: T.UUID, defaultValue: T.UUIDV4, primaryKey: true, allowNull: false };

    if (!has('money_circles')) {
      await queryInterface.createTable('money_circles', {
        id: uuid,
        owner_id: { type: T.INTEGER, allowNull: false },
        name: { type: T.STRING(120), allowNull: false },
        purpose: { type: T.STRING(255) },
        type: { type: T.ENUM('chama', 'family', 'trip', 'event', 'emergency', 'project', 'purchase', 'other'), defaultValue: 'other' },
        target_amount: { type: T.DECIMAL(15, 2), defaultValue: 0 },
        collected_amount: { type: T.DECIMAL(15, 2), defaultValue: 0 },
        currency: { type: T.STRING(10), defaultValue: 'KES' },
        status: { type: T.ENUM('active', 'completed', 'cancelled'), defaultValue: 'active' },
        settings: { type: T.JSONB, defaultValue: {} },
        ...stamps
      });
    }
    if (!has('money_circle_members')) {
      await queryInterface.createTable('money_circle_members', {
        id: uuid,
        circle_id: { type: T.UUID, allowNull: false },
        user_id: { type: T.INTEGER, allowNull: false },
        role: { type: T.ENUM('owner', 'member'), defaultValue: 'member' },
        status: { type: T.ENUM('active', 'invited', 'left'), defaultValue: 'active' },
        ...stamps
      });
      await queryInterface.addIndex('money_circle_members', ['circle_id', 'user_id'], { unique: true, name: 'money_circle_members_circle_user_uq' });
    }
    if (!has('money_contributions')) {
      await queryInterface.createTable('money_contributions', {
        id: uuid,
        circle_id: { type: T.UUID, allowNull: false },
        contributor_id: { type: T.INTEGER, allowNull: false },
        amount: { type: T.DECIMAL(15, 2), allowNull: false },
        currency: { type: T.STRING(10), defaultValue: 'KES' },
        method: { type: T.STRING(30), defaultValue: 'mpesa' },
        payment_ref: { type: T.STRING(255) },
        status: { type: T.ENUM('pending', 'paid', 'failed', 'refunded'), defaultValue: 'pending' },
        note: { type: T.STRING(255) },
        metadata: { type: T.JSONB, defaultValue: {} },
        ...stamps
      });
    }
    if (!has('money_requests')) {
      await queryInterface.createTable('money_requests', {
        id: uuid,
        requester_id: { type: T.INTEGER, allowNull: false },
        recipient_user_id: { type: T.INTEGER },
        recipient_phone: { type: T.STRING(30), allowNull: false },
        amount: { type: T.DECIMAL(15, 2), allowNull: false },
        currency: { type: T.STRING(10), defaultValue: 'KES' },
        purpose: { type: T.STRING(255) },
        status: { type: T.ENUM('requested', 'paid', 'cancelled', 'expired'), defaultValue: 'requested' },
        expires_at: { type: T.DATE },
        payment_ref: { type: T.STRING(255) },
        metadata: { type: T.JSONB, defaultValue: {} },
        idempotency_key: { type: T.STRING(120) },
        ...stamps
      });
    }
  },
  async down(queryInterface) {
    for (const t of ['money_requests', 'money_contributions', 'money_circle_members', 'money_circles']) {
      await queryInterface.dropTable(t).catch(() => {});
    }
  }
};
