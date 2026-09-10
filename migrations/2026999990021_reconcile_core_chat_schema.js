'use strict';

/**
 * Production schema reconciliation for the core chat path.
 *
 * Why this exists:
 * - The app has both versioned migrations and a best-effort runtime sync path.
 * - Older deployments can have a migration recorded as executed while the
 *   physical database is still missing a column (for example after a partial
 *  /failed deployment or manual schema repair).
 * - This migration is intentionally idempotent and only adds missing schema;
 *   it never drops or rewrites existing data.
 *
 * The normal migrations remain the source of truth. This is a defensive
 * convergence pass for the tables that are required for direct chat/listing.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;

    const addIfMissing = async (table, column, definition) => {
      const tables = await queryInterface.showAllTables();
      const actualTable = tables.find((name) => String(name).toLowerCase() === table.toLowerCase());
      if (!actualTable) return false;

      const columns = await queryInterface.describeTable(actualTable);
      if (columns[column]) return false;

      await queryInterface.addColumn(actualTable, column, definition);
      console.log(`[SchemaRepair] Added ${actualTable}.${column}`);
      return true;
    };

    // chat_participants: per-user delete/clear state.
    await addIfMissing('chat_participants', 'hiddenAt', {
      type: Sequelize.DATE,
      allowNull: true,
      comment: 'Per-user chat visibility timestamp for delete-chat.',
    });
    await addIfMissing('chat_participants', 'clearedAt', {
      type: Sequelize.DATE,
      allowNull: true,
      comment: 'Per-user message-history clear timestamp.',
    });

    // Core Chats columns used by the current chat list/resolver implementation.
    const chatColumns = [
      ['name', { type: Sequelize.STRING(100), allowNull: true }],
      ['type', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'direct' }],
      ['createdBy', { type: Sequelize.INTEGER, allowNull: true }],
      ['description', { type: Sequelize.TEXT, allowNull: true }],
      ['avatar', { type: Sequelize.STRING(255), allowNull: true }],
      ['isActive', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true }],
      ['isArchived', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
      ['archivedBy', { type: Sequelize.INTEGER, allowNull: true }],
      ['archivedAt', { type: Sequelize.DATE, allowNull: true }],
      ['deletedAt', { type: Sequelize.DATE, allowNull: true }],
      ['deletedBy', { type: Sequelize.INTEGER, allowNull: true }],
      ['lastMessageId', { type: Sequelize.INTEGER, allowNull: true }],
      ['lastMessageAt', { type: Sequelize.DATE, allowNull: true }],
      ['settings', { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }],
      ['metadata', { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }],
    ];
    for (const [column, definition] of chatColumns) {
      await addIfMissing('chats', column, definition);
    }

    // Core Messages columns used by chat history, delivery and E2EE metadata.
    const messageColumns = [
      ['chatId', { type: Sequelize.INTEGER, allowNull: true }],
      ['senderId', { type: Sequelize.INTEGER, allowNull: true }],
      ['receiverId', { type: Sequelize.INTEGER, allowNull: true }],
      ['content', { type: Sequelize.TEXT, allowNull: true }],
      ['type', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'text' }],
      ['replyToId', { type: Sequelize.INTEGER, allowNull: true }],
      ['isEdited', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
      ['editedAt', { type: Sequelize.DATE, allowNull: true }],
      ['isDeleted', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
      ['deletedAt', { type: Sequelize.DATE, allowNull: true }],
      ['deletedBy', { type: Sequelize.INTEGER, allowNull: true }],
      ['isRead', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
      ['readAt', { type: Sequelize.DATE, allowNull: true }],
      ['reactions', { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }],
      ['metadata', { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }],
      ['encryptionKey', { type: Sequelize.STRING(100), allowNull: true }],
      ['sentAt', { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }],
      ['deliveredAt', { type: Sequelize.DATE, allowNull: true }],
      ['clientMessageId', { type: Sequelize.STRING(64), allowNull: true }],
      ['status', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'sent' }],
      ['deliveryAttempts', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }],
      ['expiresAt', { type: Sequelize.DATE, allowNull: true }],
    ];
    for (const [column, definition] of messageColumns) {
      await addIfMissing('Messages', column, definition);
    }

    // Keep the per-user visibility query indexed.
    try {
      const tables = await queryInterface.showAllTables();
      const participantTable = tables.find((name) => String(name).toLowerCase() === 'chat_participants');
      if (participantTable) {
        const indexes = await queryInterface.showIndex(participantTable).catch(() => []);
        if (!indexes.some((index) => index.name === 'idx_chat_participants_hidden_at')) {
          await queryInterface.addIndex(participantTable, ['userId', 'hiddenAt'], {
            name: 'idx_chat_participants_hidden_at',
          }).catch(() => {});
        }
      }
    } catch (indexError) {
      console.warn('[SchemaRepair] Visibility index check skipped:', indexError.message);
    }

    // Final diagnostic: report any core tables that are unexpectedly absent.
    const finalTables = await queryInterface.showAllTables();
    const required = ['chats', 'chat_participants', 'Messages'];
    const missing = required.filter((requiredName) =>
      !finalTables.some((name) => String(name).toLowerCase() === requiredName.toLowerCase())
    );
    if (missing.length) {
      throw new Error(`[SchemaRepair] Required core tables are missing: ${missing.join(', ')}`);
    }

    console.log('[SchemaRepair] Core chat schema reconciliation complete');
  },

  async down() {
    // Intentionally empty: this is a forward-only safety reconciliation.
  },
};
