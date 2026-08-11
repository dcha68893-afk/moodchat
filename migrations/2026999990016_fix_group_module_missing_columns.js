'use strict';
// Migration: 2026999990016_fix_group_module_missing_columns.js
//
// Root-cause fix for the Group module 500 storm (updateGroup, updateGroupSettings,
// and effectively every other Groups query):
//
// - Groups.enabledModules was declared on the Sequelize model (src/models/Group.js)
//   and read/written by smartGroupService.ModuleService, but the migration that was
//   supposed to add the physical column was never actually created — so Sequelize
//   included "enabledModules" in every generated SQL statement against the Groups
//   table and Postgres rejected all of them with:
//     column "enabledModules" does not exist
//
// - GroupTasks.metadata is used by TaskService.addComment/getComments
//   (src/services/smartGroupService.js) to store the comments thread for a task,
//   but no column or model attribute for it ever existed, causing:
//     column "metadata" does not exist
//
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = name => queryInterface.describeTable(name).catch(() => null);

    // ── Groups.enabledModules ──────────────────────────────────────────────
    const groupCols = await tableInfo('Groups');
    if (groupCols && !groupCols['enabledModules']) {
      await queryInterface.addColumn('Groups', 'enabledModules', {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: false,
        defaultValue: ['tasks', 'events', 'polls', 'notes', 'files'],
      });
      console.log('[Migration] Added Groups.enabledModules');
    }

    // ── GroupTasks.metadata ─────────────────────────────────────────────────
    const taskCols = await tableInfo('GroupTasks');
    if (taskCols && !taskCols['metadata']) {
      await queryInterface.addColumn('GroupTasks', 'metadata', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      });
      console.log('[Migration] Added GroupTasks.metadata');
    }
  },

  async down(queryInterface) {
    const tableInfo = name => queryInterface.describeTable(name).catch(() => null);

    const groupCols = await tableInfo('Groups');
    if (groupCols && groupCols['enabledModules']) {
      await queryInterface.removeColumn('Groups', 'enabledModules');
    }

    const taskCols = await tableInfo('GroupTasks');
    if (taskCols && taskCols['metadata']) {
      await queryInterface.removeColumn('GroupTasks', 'metadata');
    }
  },
};
