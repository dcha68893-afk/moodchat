'use strict';

/**
 * NEW FEATURE: Pinned messages (chat-scoped, works for 1:1 and group chats).
 *
 * A `PinnedMessage` model already existed in src/models/PinnedMessage.js —
 * well-designed (chatId/messageId/pinnedBy, unique per chat+message) — but
 * had no migration behind it at all, so the `pinned_messages` table it
 * points at never existed, and no route in the app ever used it. Separately,
 * a `Groups.pinnedMessageIds` array column exists (added by an older
 * migration) but nothing reads or writes it either. Rather than resurrect
 * either dead path, this creates the table the existing PinnedMessage model
 * already expects, scoped to Chats/Messages (the tables the app's real
 * send/receive pipeline actually uses) so it works for both 1:1 and group
 * chats.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const exists = await queryInterface.tableExists('pinned_messages');
    if (!exists) {
      await queryInterface.createTable('pinned_messages', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        chatId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'chats', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        messageId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Messages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        pinnedBy: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        pinnedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('pinned_messages', ['chatId'], { name: 'idx_pinnedmessages_chat' });
      await queryInterface.addIndex('pinned_messages', ['messageId'], { name: 'idx_pinnedmessages_message' });
      await queryInterface.addIndex('pinned_messages', ['chatId', 'messageId'], { name: 'uniq_pinnedmessages_chat_message', unique: true });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('pinned_messages').catch(() => {});
  },
};
