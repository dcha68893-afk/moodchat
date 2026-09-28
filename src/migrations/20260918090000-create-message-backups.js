'use strict';

/**
 * FIX (Backup & Restore, architecture audit item #13): src/routes/devices.js
 * has fully-implemented POST/GET/DELETE /api/devices/backup endpoints, and
 * js/backup-manager.js on the frontend already has a complete, working
 * client-side flow (collect -> AES-256-GCM encrypt -> upload/download ->
 * decrypt -> restore) that calls them. Neither side was actually broken —
 * but the "message_backups" table those routes' raw SQL queries and INSERT
 * statements assume, never had a migration — the table simply didn't exist,
 * so every call to any of these endpoints failed at the database with
 * "relation message_backups does not exist" the moment they were first
 * used. This migration creates it. Separately, POST /backup's original
 * INSERT ... ON CONFLICT DO NOTHING also had its own bug: backupKey is a
 * fresh random value on every call, so nothing about that INSERT could ever
 * conflict in the first place, meaning a person's second, third, etc. backup
 * just kept accumulating new rows forever instead of ever replacing the
 * old one — fixed alongside this migration with a real per-user upsert
 * (see the unique constraint below and the matching fix in devices.js).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('message_backups', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // One backup row per user — re-running "Create Cloud Backup" replaces
      // it (see the upsert fix in devices.js) rather than accumulating rows
      // forever or silently no-opping.
      backupKey: { type: Sequelize.STRING(64), allowNull: false },
      encryptedData: { type: Sequelize.TEXT, allowNull: false },
      messageCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      sizeBytes: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'completed' },
      completedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addConstraint('message_backups', {
      fields: ['userId'],
      type: 'unique',
      name: 'message_backups_user_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('message_backups');
  },
};
