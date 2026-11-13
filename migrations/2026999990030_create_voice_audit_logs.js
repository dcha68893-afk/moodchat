'use strict';
// Voice audit trail: metadata only (no audio, no transcript text). Idempotent.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = (await queryInterface.showAllTables()).map(t => (typeof t === 'string' ? t : t.tableName));
    if (existing.includes('voice_audit_logs')) return;
    const T = Sequelize;
    await queryInterface.createTable('voice_audit_logs', {
      id: { type: T.UUID, defaultValue: T.UUIDV4, primaryKey: true, allowNull: false },
      user_id: { type: T.STRING(64), allowNull: false },
      action: { type: T.STRING(48), allowNull: false },
      module: { type: T.STRING(32), allowNull: true },
      outcome: { type: T.STRING(16), allowNull: true },
      lang: { type: T.STRING(16), allowNull: true },
      duration_ms: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
      char_count: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
      request_id: { type: T.STRING(64), allowNull: true },
      ip_hash: { type: T.STRING(32), allowNull: true },
      createdAt: { type: T.DATE, allowNull: false, defaultValue: T.fn('NOW') },
    });
    await queryInterface.addIndex('voice_audit_logs', ['user_id', 'createdAt'], { name: 'voice_audit_user_time_idx' });
  },
  async down(queryInterface) { await queryInterface.dropTable('voice_audit_logs').catch(() => {}); },
};
