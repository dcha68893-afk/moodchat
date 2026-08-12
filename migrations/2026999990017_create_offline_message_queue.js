'use strict';
/**
 * Migration: create offline_message_queue table
 *
 * FIX (item 7 — backend offline queue durability):
 * webSocketService.js's _offlineQueue used to be a plain in-memory Map
 * (userId -> array of { event, payload, queuedAt }). If the Node process
 * restarted (deploy, crash, autoscale cycle on Render) while a recipient
 * was offline, every queued message for them was silently lost — nothing
 * in Postgres recorded that a delivery was still owed. This table gives
 * enqueueOfflineMessage()/flushOfflineMessages() a durable backing store:
 * a row is written before it's ever "in flight" only in memory, and rows
 * are only deleted after a confirmed successful sendToUser() delivery.
 *
 * Idempotent (checks describeTable first) so it's safe to run on every boot,
 * matching the pattern used by every other migration in this project.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 * ROLLBACK:   npx sequelize-cli db:migrate:undo
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface.describeTable('offline_message_queue').catch(() => null);
    if (tableExists) {
      console.log('offline_message_queue already exists — skipping create');
      return;
    }

    await queryInterface.createTable('offline_message_queue', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      event: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      payload: {
        type: Sequelize.JSONB,
        allowNull: false,
      },
      queuedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      deliveredAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    // Fast lookup for "everything still owed to this user", which is the
    // only query pattern this table serves (flushOfflineMessages runs it
    // on every reconnect).
    await queryInterface.addIndex('offline_message_queue', ['userId', 'deliveredAt'], {
      name: 'idx_offline_queue_user_undelivered',
    });

    console.log('✅ offline_message_queue table created');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('offline_message_queue');
  },
};
