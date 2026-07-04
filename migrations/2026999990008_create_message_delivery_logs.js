'use strict';
/**
 * Creates the message_delivery_logs table referenced in messages.js line 887.
 * The table was used in a raw INSERT but never created — causing silent DB errors
 * in every setImmediate delivery-logging block. Non-fatal due to try/catch, but
 * generates error noise and breaks delivery tracking.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const exists = await queryInterface.tableExists('message_delivery_logs');
    if (!exists) {
      await queryInterface.createTable('message_delivery_logs', {
        id:        { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        messageId: { type: Sequelize.INTEGER, allowNull: false },
        userId:    { type: Sequelize.INTEGER, allowNull: false },
        chatId:    { type: Sequelize.INTEGER, allowNull: false },
        event:     { type: Sequelize.STRING(50), allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('message_delivery_logs', ['messageId', 'userId', 'event'], {
        name: 'uniq_msg_delivery_log', unique: true,
      });
      await queryInterface.addIndex('message_delivery_logs', ['chatId'], { name: 'idx_msg_delivery_chatid' });
    }
  },
  async down(queryInterface) {
    await queryInterface.dropTable('message_delivery_logs').catch(() => {});
  }
};
