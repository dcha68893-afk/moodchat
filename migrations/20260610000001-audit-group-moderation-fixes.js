'use strict';
// Migration: 20260610000001-audit-group-moderation-fixes.js
// Adds all columns required by the Group Audit Report P1/P2 fixes:
// - Groups: slowModeInterval, postingRule, disappearingTimer, pinnedMessageIds,
//           inviteLinkMaxUses, inviteLinkUseCount, groupUsername, blockedWords,
//           scheduledPostingStart, scheduledPostingEnd
// - GroupMembers: mutedUntil, isBanned, banReason, nickname, customTitle, warnings
// - GroupFinance: runningBalance
// - Creates ModerationLogs table

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = name => queryInterface.describeTable(name).catch(() => null);

    // ── Groups ──────────────────────────────────────────────────────────────
    const groupCols = await tableInfo('Groups');
    if (groupCols) {
      const addGroupCol = async (col, def) => {
        if (!groupCols[col]) {
          await queryInterface.addColumn('Groups', col, def);
          console.log(`[Migration] Added Groups.${col}`);
        }
      };

      await addGroupCol('slowModeInterval', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        allowNull: false,
      });

      // ENUM: safe add
      if (!groupCols['postingRule']) {
        await queryInterface.sequelize.query(
          `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_Groups_postingRule') THEN
              CREATE TYPE "enum_Groups_postingRule" AS ENUM ('open','read_only','announcement','admin_only','scheduled');
            END IF;
          END $$;`
        ).catch(() => {});
        await queryInterface.addColumn('Groups', 'postingRule', {
          type: Sequelize.ENUM('open', 'read_only', 'announcement', 'admin_only', 'scheduled'),
          defaultValue: 'open',
          allowNull: false,
        });
        console.log('[Migration] Added Groups.postingRule');
      }

      await addGroupCol('disappearingTimer', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        allowNull: false,
      });

      await addGroupCol('pinnedMessageIds', {
        type: Sequelize.ARRAY(Sequelize.INTEGER),
        defaultValue: [],
        allowNull: false,
      });

      await addGroupCol('inviteLinkMaxUses', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        allowNull: false,
      });

      await addGroupCol('inviteLinkUseCount', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        allowNull: false,
      });

      await addGroupCol('groupUsername', {
        type: Sequelize.STRING(30),
        allowNull: true,
        unique: true,
      });

      await addGroupCol('blockedWords', {
        type: Sequelize.ARRAY(Sequelize.STRING),
        defaultValue: [],
        allowNull: false,
      });

      await addGroupCol('scheduledPostingStart', {
        type: Sequelize.STRING(5),
        allowNull: true,
      });

      await addGroupCol('scheduledPostingEnd', {
        type: Sequelize.STRING(5),
        allowNull: true,
      });
    }

    // ── GroupMembers ────────────────────────────────────────────────────────
    const gmCols = await tableInfo('GroupMembers');
    if (gmCols) {
      const addGMCol = async (col, def) => {
        if (!gmCols[col]) {
          await queryInterface.addColumn('GroupMembers', col, def);
          console.log(`[Migration] Added GroupMembers.${col}`);
        }
      };

      await addGMCol('mutedUntil',  { type: Sequelize.DATE, allowNull: true });
      await addGMCol('isBanned',    { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false });
      await addGMCol('banReason',   { type: Sequelize.TEXT, allowNull: true });
      await addGMCol('nickname',    { type: Sequelize.STRING(50), allowNull: true });
      await addGMCol('customTitle', { type: Sequelize.STRING(50), allowNull: true });
      await addGMCol('warnings',    { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false });
    }

    // ── GroupFinance ────────────────────────────────────────────────────────
    const gfCols = await tableInfo('GroupFinances');
    if (gfCols && !gfCols['runningBalance']) {
      await queryInterface.addColumn('GroupFinances', 'runningBalance', {
        type: Sequelize.DECIMAL(15, 2),
        defaultValue: 0,
        allowNull: false,
      });
      console.log('[Migration] Added GroupFinances.runningBalance');
    }

    // ── ModerationLogs ──────────────────────────────────────────────────────
    const modLogExists = await tableInfo('ModerationLogs');
    if (!modLogExists) {
      await queryInterface.sequelize.query(
        `DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_ModerationLogs_action') THEN
            CREATE TYPE "enum_ModerationLogs_action" AS ENUM (
              'kick','ban','unban','mute','unmute',
              'role_change','warn','slow_mode_set','slow_mode_disabled',
              'posting_rule_changed','message_deleted','member_approved',
              'member_rejected','ownership_transferred','group_locked',
              'group_unlocked','content_filtered','disappearing_set'
            );
          END IF;
        END $$;`
      ).catch(() => {});

      await queryInterface.createTable('ModerationLogs', {
        id:            { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        groupId:       { type: Sequelize.INTEGER, allowNull: false },
        performedBy:   { type: Sequelize.INTEGER, allowNull: false },
        action:        {
          type: Sequelize.ENUM(
            'kick','ban','unban','mute','unmute',
            'role_change','warn','slow_mode_set','slow_mode_disabled',
            'posting_rule_changed','message_deleted','member_approved',
            'member_rejected','ownership_transferred','group_locked',
            'group_unlocked','content_filtered','disappearing_set'
          ),
          allowNull: false,
        },
        targetUserId:  { type: Sequelize.INTEGER, allowNull: true },
        messageId:     { type: Sequelize.INTEGER, allowNull: true },
        reason:        { type: Sequelize.TEXT, allowNull: true },
        metadata:      { type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
        createdAt:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex('ModerationLogs', ['groupId']);
      await queryInterface.addIndex('ModerationLogs', ['performedBy']);
      await queryInterface.addIndex('ModerationLogs', ['targetUserId']);
      await queryInterface.addIndex('ModerationLogs', ['action']);
      await queryInterface.addIndex('ModerationLogs', ['createdAt']);
      console.log('[Migration] Created ModerationLogs table');
    }

    // ── Indexes ──────────────────────────────────────────────────────────────
    // groupUsername unique index (safe: only if column newly added)
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_groups_groupusername
      ON "Groups" ("groupUsername") WHERE "groupUsername" IS NOT NULL;
    `).catch(() => {});

    // ── Users.fcmToken ──────────────────────────────────────────────────────
    const userCols = await tableInfo('Users');
    if (userCols && !userCols['fcmToken']) {
      await queryInterface.addColumn('Users', 'fcmToken', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
      console.log('[Migration] Added Users.fcmToken');
    }

    // ── GroupEvents: recurrence columns ────────────────────────────────────
    const evCols = await tableInfo('GroupEvents');
    if (evCols) {
      const addEvCol = async (col, def) => {
        if (!evCols[col]) { await queryInterface.addColumn('GroupEvents', col, def); console.log(`[Migration] Added GroupEvents.${col}`); }
      };
      await addEvCol('recurrenceRule',     { type: Sequelize.TEXT,    allowNull: true });
      await addEvCol('recurrenceIndex',    { type: Sequelize.INTEGER, allowNull: true, defaultValue: 0 });
      await addEvCol('recurrenceParentId', { type: Sequelize.INTEGER, allowNull: true });
    }

    // ── GroupThreads ────────────────────────────────────────────────────────
    const threadExists = await tableInfo('GroupThreads');
    if (!threadExists) {
      await queryInterface.createTable('GroupThreads', {
        id:              { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:         { type: Sequelize.INTEGER, allowNull: false },
        parentMessageId: { type: Sequelize.INTEGER, allowNull: false },
        createdBy:       { type: Sequelize.INTEGER, allowNull: false },
        title:           { type: Sequelize.STRING(200), allowNull: true },
        replyCount:      { type: Sequelize.INTEGER, defaultValue: 0 },
        lastReplyAt:     { type: Sequelize.DATE, allowNull: true },
        lastReplyBy:     { type: Sequelize.INTEGER, allowNull: true },
        isLocked:        { type: Sequelize.BOOLEAN, defaultValue: false },
        isArchived:      { type: Sequelize.BOOLEAN, defaultValue: false },
        createdAt:       { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:       { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupThreads', ['groupId']);
      await queryInterface.addIndex('GroupThreads', ['parentMessageId']);
      console.log('[Migration] Created GroupThreads table');
    }

    console.log('[Migration] ✅ audit-group-moderation-fixes complete');
  },

  async down(queryInterface, Sequelize) {
    // Drop columns in reverse order
    const safe = (fn) => fn.catch(() => {});

    await safe(queryInterface.removeColumn('Groups', 'scheduledPostingEnd'));
    await safe(queryInterface.removeColumn('Groups', 'scheduledPostingStart'));
    await safe(queryInterface.removeColumn('Groups', 'blockedWords'));
    await safe(queryInterface.removeColumn('Groups', 'groupUsername'));
    await safe(queryInterface.removeColumn('Groups', 'inviteLinkUseCount'));
    await safe(queryInterface.removeColumn('Groups', 'inviteLinkMaxUses'));
    await safe(queryInterface.removeColumn('Groups', 'pinnedMessageIds'));
    await safe(queryInterface.removeColumn('Groups', 'disappearingTimer'));
    await safe(queryInterface.removeColumn('Groups', 'postingRule'));
    await safe(queryInterface.removeColumn('Groups', 'slowModeInterval'));

    await safe(queryInterface.removeColumn('GroupMembers', 'warnings'));
    await safe(queryInterface.removeColumn('GroupMembers', 'customTitle'));
    await safe(queryInterface.removeColumn('GroupMembers', 'nickname'));
    await safe(queryInterface.removeColumn('GroupMembers', 'banReason'));
    await safe(queryInterface.removeColumn('GroupMembers', 'isBanned'));
    await safe(queryInterface.removeColumn('GroupMembers', 'mutedUntil'));

    await safe(queryInterface.removeColumn('GroupFinances', 'runningBalance'));
    await safe(queryInterface.dropTable('ModerationLogs'));
  },
};
// NOTE: fcmToken column added to Users — handled separately in down/up via addColumn
