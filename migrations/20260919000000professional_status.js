'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async name => {
      const tables = await queryInterface.showAllTables();
      return tables.some(t => String(t).toLowerCase() === name.toLowerCase());
    };
    const add = async (table, column, definition) => {
      const desc = await queryInterface.describeTable(table);
      if (!desc[column]) await queryInterface.addColumn(table, column, definition);
    };

    if (!(await tableExists('Status'))) {
      await queryInterface.createTable('Status', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        userId: { type: Sequelize.INTEGER, allowNull: false },
        content: { type: Sequelize.TEXT, allowNull: true },
        type: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'text' },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
    }

    const columns = {
      mediaUrl: { type: Sequelize.TEXT, allowNull: true },
      mediaPublicId: { type: Sequelize.STRING(500), allowNull: true },
      mediaMime: { type: Sequelize.STRING(120), allowNull: true },
      thumbnailUrl: { type: Sequelize.TEXT, allowNull: true },
      caption: { type: Sequelize.TEXT, allowNull: true },
      background: { type: Sequelize.STRING(120), allowNull: true },
      font: { type: Sequelize.STRING(80), allowNull: true },
      musicUrl: { type: Sequelize.TEXT, allowNull: true },
      linkUrl: { type: Sequelize.TEXT, allowNull: true },
      mentions: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      stickers: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      topics: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      moodType: { type: Sequelize.STRING(60), allowNull: true },
      category: { type: Sequelize.STRING(60), allowNull: true },
      intent: { type: Sequelize.STRING(60), allowNull: true },
      privacy: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'all_contacts' },
      privacyList: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      durationSeconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 7 },
      allowReplies: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      allowReactions: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      allowSharing: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isPublic: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      expiresAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP + INTERVAL '24 hours'") },
      viewCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reactionCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      replyCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      shareCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      highlight: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      pollOptions: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
    };
    for (const [column, definition] of Object.entries(columns)) await add('Status', column, definition);

    for (const spec of [
      { name: 'StatusViews', columns: { id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true }, statusId: { type: Sequelize.INTEGER, allowNull: false }, viewerId: { type: Sequelize.INTEGER, allowNull: false }, viewedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }, createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }, updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW } }, unique: ['statusId', 'viewerId'] },
      { name: 'StatusReactions', columns: { id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true }, statusId: { type: Sequelize.INTEGER, allowNull: false }, userId: { type: Sequelize.INTEGER, allowNull: false }, emoji: { type: Sequelize.STRING(16), allowNull: false, defaultValue: '❤️' }, createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }, updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW } }, unique: ['statusId', 'userId'] },
      { name: 'StatusReplies', columns: { id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true }, statusId: { type: Sequelize.INTEGER, allowNull: false }, userId: { type: Sequelize.INTEGER, allowNull: false }, text: { type: Sequelize.TEXT, allowNull: false }, createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }, updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW } }, unique: null },
      { name: 'StatusReports', columns: { id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true }, statusId: { type: Sequelize.INTEGER, allowNull: false }, reporterId: { type: Sequelize.INTEGER, allowNull: false }, reason: { type: Sequelize.STRING(80), allowNull: false }, details: { type: Sequelize.TEXT, allowNull: true }, createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }, updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW } }, unique: null },
    ]) {
      if (!(await tableExists(spec.name))) await queryInterface.createTable(spec.name, spec.columns);
      if (spec.unique) {
        try { await queryInterface.addIndex(spec.name, spec.unique, { unique: true, name: spec.name + '_status_user_unique' }); } catch (_) {}
      }
    }
  },
  async down(queryInterface) {
    for (const table of ['StatusReports', 'StatusReplies', 'StatusReactions', 'StatusViews']) {
      try { await queryInterface.dropTable(table); } catch (_) {}
    }
  },
};