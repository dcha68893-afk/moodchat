'use strict';

/**
 * NEW FEATURE: Polls (chat-scoped)
 *
 * The repo already had GroupPoll/GroupPollOption/GroupPollVote models, but
 * they were hardwired to `groupId` (group chats only) and had zero working
 * API routes anywhere in the codebase — just orphaned model definitions.
 *
 * This migration creates a parallel, chat-scoped poll schema that works for
 * BOTH 1:1 and group chats, matching how WhatsApp/Telegram render a poll as
 * a message bubble inside the normal chat timeline. A poll is delivered as
 * a Messages row with type='poll' whose metadata.pollId points here, so it
 * sorts, paginates, and gets read-receipts exactly like any other message.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const pollsExists = await queryInterface.tableExists('ChatPolls');
    if (!pollsExists) {
      await queryInterface.createTable('ChatPolls', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        chatId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'chats', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        messageId: {
          // Links back to the Messages row (type='poll') that carries this poll
          // in the chat timeline. Nullable until the message insert completes.
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'Messages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        createdBy: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        question: { type: Sequelize.STRING(500), allowNull: false },
        allowMultipleAnswers: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        isAnonymous: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        closesAt: { type: Sequelize.DATE, allowNull: true },
        isClosed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        closedAt: { type: Sequelize.DATE, allowNull: true },
        closedBy: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('ChatPolls', ['chatId'], { name: 'idx_chatpolls_chat' });
      await queryInterface.addIndex('ChatPolls', ['messageId'], { name: 'idx_chatpolls_message' });
    }

    const optionsExists = await queryInterface.tableExists('ChatPollOptions');
    if (!optionsExists) {
      await queryInterface.createTable('ChatPollOptions', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        pollId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'ChatPolls', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        text: { type: Sequelize.STRING(255), allowNull: false },
        position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('ChatPollOptions', ['pollId'], { name: 'idx_chatpolloptions_poll' });
    }

    const votesExists = await queryInterface.tableExists('ChatPollVotes');
    if (!votesExists) {
      await queryInterface.createTable('ChatPollVotes', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        pollId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'ChatPolls', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        optionId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'ChatPollOptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        userId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      // One vote per user per option — prevents double-voting the same option,
      // while still allowing multiple rows per user when allowMultipleAnswers=true
      // (one row per option they picked).
      await queryInterface.addIndex('ChatPollVotes', ['optionId', 'userId'], {
        name: 'uniq_chatpollvotes_option_user', unique: true,
      });
      await queryInterface.addIndex('ChatPollVotes', ['pollId', 'userId'], {
        name: 'idx_chatpollvotes_poll_user',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ChatPollVotes').catch(() => {});
    await queryInterface.dropTable('ChatPollOptions').catch(() => {});
    await queryInterface.dropTable('ChatPolls').catch(() => {});
  },
};
