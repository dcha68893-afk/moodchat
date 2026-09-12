'use strict';

/**
 * Normalize the legacy Tokens table to the current Token model contract.
 * This migration is deliberately additive/rename-only: existing token rows
 * are preserved and no table is dropped.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Tokens');
    if (!table || Object.keys(table).length === 0) return;

    const has = name => Boolean(table[name]);

    // Legacy camelCase -> current snake_case names.
    const renames = [
      ['userId', 'user_id'],
      ['expiresAt', 'expires_at'],
      ['isRevoked', 'is_revoked'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
      ['userAgent', 'user_agent'],
      ['ipAddress', 'ip_address'],
      ['deviceInfo', 'device_info'],
      ['type', 'token_type'],
    ];

    for (const [from, to] of renames) {
      if (has(from) && !has(to)) {
        await queryInterface.renameColumn('Tokens', from, to);
        table[to] = table[from];
        delete table[from];
      }
    }

    const add = async (name, definition) => {
      if (!has(name)) {
        await queryInterface.addColumn('Tokens', name, definition);
        table[name] = definition;
      }
    };

    await add('created_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    });
    await add('updated_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    });
    await add('token_type', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'refresh',
    });
    await add('is_revoked', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Required optional metadata columns used by the model/service.
    await add('user_agent', { type: Sequelize.STRING, allowNull: true });
    await add('ip_address', { type: Sequelize.STRING(45), allowNull: true });
    await add('device_info', { type: Sequelize.STRING, allowNull: true });

    // Ensure the expected current indexes exist. Duplicate-index errors are
    // avoided by checking the existing index list first.
    const indexes = await queryInterface.showIndex('Tokens');
    const names = new Set(indexes.map(i => i.name));
    const ensureIndex = async (fields, name) => {
      if (!names.has(name)) {
        await queryInterface.addIndex('Tokens', fields, { name });
        names.add(name);
      }
    };

    await ensureIndex(['user_id'], 'tokens_user_id_idx');
    await ensureIndex(['token'], 'tokens_token_idx');
    await ensureIndex(['expires_at'], 'tokens_expires_at_idx');
    await ensureIndex(['user_id', 'is_revoked'], 'tokens_user_revoked_idx');
  },

  async down(queryInterface) {
    // Do not destructively reverse production compatibility changes.
    // Existing token data must remain usable during rollback.
    console.log('[Tokens migration] Down migration intentionally left non-destructive.');
  },
};
