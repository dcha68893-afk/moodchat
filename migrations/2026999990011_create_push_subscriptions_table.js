'use strict';
/**
 * Migration: create push_subscriptions table
 *
 * Same class of bug as 2026999990010_create_starred_messages_table.js:
 * src/models/PushSubscription.js defines this table (Web Push endpoint +
 * keys per user, plus game-reminder opt-in columns) and src/routes/push.js's
 * POST /subscribe writes to it directly, but no migration anywhere ever
 * creates it — the cause of the 500 on POST /api/push/subscribe.
 *
 * Idempotent (checks describeTable first) so it's safe to run on every boot.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 * ROLLBACK:   npx sequelize-cli db:migrate:undo
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface.describeTable('push_subscriptions').catch(() => null);
    if (tableExists) {
      console.log('push_subscriptions already exists — skipping create');
      return;
    }

    await queryInterface.createTable('push_subscriptions', {
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
      endpoint: {
        type: Sequelize.TEXT,
        allowNull: false,
        unique: true,
      },
      p256dh: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      auth: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      userAgent: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      lastUsedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      gameRemindersEnabled: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      lastDailyReminderSentAt: {
        type: Sequelize.DATE,
        allowNull: true,
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

    await queryInterface.addIndex('push_subscriptions', ['userId']);

    console.log('✅ push_subscriptions table created');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('push_subscriptions');
  },
};
