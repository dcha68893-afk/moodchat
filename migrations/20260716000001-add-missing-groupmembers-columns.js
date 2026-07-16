'use strict';
// Migration: 20260716000001-add-missing-groupmembers-columns.js
//
// ROOT CAUSE FIX — "My Groups / Joined / Admin / All Groups always show 0
// even though the user has created and joined groups":
//
// src/models/GroupMembers.js defines `leftAt`, `notificationsMuted`, and
// `customSettings` columns, and groupService.getUserGroups() (and several
// other queries) filter with `where: { userId, leftAt: null }`. No
// migration ever created these three columns at the database level, so
// every getUserGroups() query throws "column leftAt does not exist", which
// is caught internally and silently returns an empty group list — this is
// why the Groups screen (All Groups/My Groups/Joined/Invites/Admin) always
// rendered 0 and "No groups created yet", even though groups the user
// created/joined show up fine in Discover (which queries public groups a
// different way that never touches `leftAt`). There is no hardcoded/
// placeholder "0" in the frontend — group.html and group-core.js both
// render whatever count the API actually returns; the API was returning an
// empty array because of this missing-column error.
module.exports = {
  async up(queryInterface, Sequelize) {
    const gmCols = await queryInterface.describeTable('GroupMembers').catch(() => null);
    if (!gmCols) return;

    if (!gmCols.leftAt) {
      await queryInterface.addColumn('GroupMembers', 'leftAt', {
        type: Sequelize.DATE,
        allowNull: true,
      });
      console.log('[Migration] Added GroupMembers.leftAt');
    }

    if (!gmCols.notificationsMuted) {
      await queryInterface.addColumn('GroupMembers', 'notificationsMuted', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      });
      console.log('[Migration] Added GroupMembers.notificationsMuted');
    }

    if (!gmCols.customSettings) {
      await queryInterface.addColumn('GroupMembers', 'customSettings', {
        type: Sequelize.JSONB,
        defaultValue: { bannedAt: null, banReason: null, banExpiry: null },
        allowNull: false,
      });
      console.log('[Migration] Added GroupMembers.customSettings');
    }

    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_groupmembers_userid_leftat ON "GroupMembers" ("userId", "leftAt");'
    ).catch(() => {});
  },

  async down(queryInterface) {
    const safe = (fn) => fn.catch(() => {});
    await safe(queryInterface.removeColumn('GroupMembers', 'customSettings'));
    await safe(queryInterface.removeColumn('GroupMembers', 'notificationsMuted'));
    await safe(queryInterface.removeColumn('GroupMembers', 'leftAt'));
  },
};
