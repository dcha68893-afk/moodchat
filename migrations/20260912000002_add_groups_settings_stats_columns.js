'use strict';
/**
 * Migration: Add missing Groups.settings / Groups.stats columns
 *
 * The Group model (src/models/Group.js) has declared both of these JSONB
 * columns from the start, and groupService.js's getUserGroups() selects
 * both on every "list my groups" request — but neither was ever part of a
 * versioned migration, so on any install where the self-healing schema
 * pass (src/utils/ensureSchema.js) also missed them (fixed alongside this
 * migration), the columns simply don't exist. That's the source of the
 * live "column userGroup.settings does not exist" 500 on every group list
 * fetch.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "settings" JSONB NOT NULL DEFAULT '{
        "allowMedia": true,
        "allowCalls": true,
        "allowReactions": true,
        "allowReplies": true,
        "allowEditing": true,
        "allowDeleting": true,
        "slowMode": 0,
        "requireAdminApproval": false,
        "allowInvites": true,
        "onlyAdminsCanPost": false,
        "disappearingMessages": false,
        "archived": false
      }'::jsonb;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "stats" JSONB NOT NULL DEFAULT '{
        "totalMessages": 0,
        "totalMembers": 0,
        "dailyActiveUsers": 0,
        "weeklyActiveUsers": 0
      }'::jsonb;
    `);

    console.log('✅ Groups.settings / Groups.stats ensured');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "Groups" DROP COLUMN IF EXISTS "settings";`);
    await queryInterface.sequelize.query(`ALTER TABLE "Groups" DROP COLUMN IF EXISTS "stats";`);
  }
};
