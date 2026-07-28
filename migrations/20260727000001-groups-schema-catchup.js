'use strict';
// Migration: 20260727000001-groups-schema-catchup.js
//
// ROOT CAUSE this closes out:
// Several earlier group-related migrations (20260610, 20260716, 20260721,
// 20260723000001, 20260723000002) use a defensive
// `describeTable(X).catch(() => null); if (!cols) return;` guard so they
// don't hard-crash if a table doesn't exist yet. That's safe for a table
// that legitimately never needed touching, but it also means: if any ONE
// migration anywhere earlier in the sort order throws for real (for
// example 20260621000001-create-group-sender-key-distributions.js, which
// had a stale lowercase `references: { model: 'groups' }` — every other
// migration in this codebase correctly uses the capitalized 'Groups' the
// table was actually created with — was fixed alongside this migration),
// `sequelize-cli db:migrate` aborts the WHOLE batch at that point and
// never even reaches these later files. Because `npm start` runs
// migrations as `(npm run db:migrate || true)`, that failure is swallowed
// and the server boots anyway — silently, permanently missing whatever
// columns/tables the un-run migrations were supposed to add. That is the
// direct cause of groupService.getUserGroups() throwing on the missing
// GroupMembers.leftAt column (caught internally, returns an empty list —
// the All/Joined/Admin/Invited tabs showing nothing) and of
// group_sender_key_distributions / group_sender_key_generations not
// existing (the "encryption failed" + 500s on message send/receive).
//
// This migration re-asserts every piece of group-related schema those
// earlier migrations were meant to add, each behind a real existence
// check (not a swallow-and-return), so it's safe to run regardless of
// which of the earlier ones actually completed — and unlike several of
// them, genuine failures here are NOT caught-and-ignored, so if something
// really is wrong it will show up loudly in the deploy logs instead of
// silently vanishing again.
module.exports = {
  async up(queryInterface, Sequelize) {
    const describe = (name) => queryInterface.describeTable(name).catch(() => null);
    const tables = await queryInterface.showAllTables();
    const hasTable = (name) => tables.some((t) => String(t).toLowerCase() === name.toLowerCase());

    // ── GroupMembers columns ──────────────────────────────────────────────
    const gmCols = await describe('GroupMembers');
    if (!gmCols) {
      throw new Error('[groups-schema-catchup] GroupMembers table does not exist — base migrations have not run. Fix that first.');
    }
    const addGmCol = async (col, def) => {
      if (!gmCols[col]) {
        await queryInterface.addColumn('GroupMembers', col, def);
        console.log(`[groups-schema-catchup] Added GroupMembers.${col}`);
      }
    };
    // From 20260716 — required by groupService.getUserGroups()'s
    // `where: { userId, leftAt: null }` filter (root cause of empty tabs).
    await addGmCol('leftAt', { type: Sequelize.DATE, allowNull: true });
    await addGmCol('notificationsMuted', { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false });
    await addGmCol('customSettings', {
      type: Sequelize.JSONB,
      defaultValue: { bannedAt: null, banReason: null, banExpiry: null },
      allowNull: false,
    });
    // From 20260610
    await addGmCol('mutedUntil', { type: Sequelize.DATE, allowNull: true });
    await addGmCol('isBanned', { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false });
    await addGmCol('banReason', { type: Sequelize.TEXT, allowNull: true });
    await addGmCol('nickname', { type: Sequelize.STRING(50), allowNull: true });
    await addGmCol('customTitle', { type: Sequelize.STRING(50), allowNull: true });
    await addGmCol('warnings', { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false });
    // From 20260723000001
    await addGmCol('isFavorite', { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false });
    await addGmCol('isBlocked', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
      comment: 'User has blocked this group: hidden from active lists, notifications suppressed.',
    });

    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_groupmembers_userid_leftat ON "GroupMembers" ("userId", "leftAt");'
    );

    // ── Groups columns ──────────────────────────────────────────────────
    const groupCols = await describe('Groups');
    if (!groupCols) {
      throw new Error('[groups-schema-catchup] Groups table does not exist — base migrations have not run. Fix that first.');
    }
    // From 20260723000002
    if (!groupCols.discoveryScope) {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_Groups_discoveryScope') THEN
            CREATE TYPE "enum_Groups_discoveryScope" AS ENUM ('community', 'region', 'county', 'world');
          END IF;
        END $$;
      `);
      await queryInterface.addColumn('Groups', 'discoveryScope', {
        type: Sequelize.ENUM('community', 'region', 'county', 'world'),
        defaultValue: 'world',
        allowNull: false,
      });
      console.log('[groups-schema-catchup] Added Groups.discoveryScope');
    }
    if (!groupCols.location) {
      await queryInterface.addColumn('Groups', 'location', { type: Sequelize.STRING(100), allowNull: true });
      console.log('[groups-schema-catchup] Added Groups.location');
    }
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_groups_discoveryscope ON "Groups" ("discoveryScope");'
    );

    // ── GroupReports table (from 20260723000001) ────────────────────────
    if (!hasTable('GroupReports')) {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_GroupReports_reason') THEN
            CREATE TYPE "enum_GroupReports_reason" AS ENUM ('spam','harassment','hate_speech','violence','sexual_content','misinformation','other');
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_GroupReports_status') THEN
            CREATE TYPE "enum_GroupReports_status" AS ENUM ('pending','reviewed','actioned','dismissed');
          END IF;
        END $$;
      `);
      await queryInterface.createTable('GroupReports', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId: { type: Sequelize.INTEGER, allowNull: false },
        reporterId: { type: Sequelize.INTEGER, allowNull: false },
        reason: { type: Sequelize.ENUM('spam', 'harassment', 'hate_speech', 'violence', 'sexual_content', 'misinformation', 'other'), allowNull: false },
        details: { type: Sequelize.TEXT, allowNull: true },
        status: { type: Sequelize.ENUM('pending', 'reviewed', 'actioned', 'dismissed'), defaultValue: 'pending', allowNull: false },
        reviewedBy: { type: Sequelize.INTEGER, allowNull: true },
        reviewedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await queryInterface.addIndex('GroupReports', ['groupId']);
      await queryInterface.addIndex('GroupReports', ['status']);
      await queryInterface.addIndex('GroupReports', ['reporterId', 'groupId'], { unique: true, name: 'group_reports_reporter_group_unique' });
      console.log('[groups-schema-catchup] Created GroupReports table');
    }

    // ── ModerationLogs table (from 20260610) ─────────────────────────────
    if (!hasTable('ModerationLogs')) {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_ModerationLogs_action') THEN
            CREATE TYPE "enum_ModerationLogs_action" AS ENUM (
              'kick','ban','unban','mute','unmute','role_change','warn','slow_mode_set',
              'slow_mode_disabled','posting_rule_changed','message_deleted','member_approved',
              'member_rejected','ownership_transferred','group_locked','group_unlocked',
              'content_filtered','disappearing_set'
            );
          END IF;
        END $$;
      `);
      await queryInterface.createTable('ModerationLogs', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        groupId: { type: Sequelize.INTEGER, allowNull: false },
        performedBy: { type: Sequelize.INTEGER, allowNull: false },
        action: {
          type: Sequelize.ENUM(
            'kick', 'ban', 'unban', 'mute', 'unmute', 'role_change', 'warn', 'slow_mode_set',
            'slow_mode_disabled', 'posting_rule_changed', 'message_deleted', 'member_approved',
            'member_rejected', 'ownership_transferred', 'group_locked', 'group_unlocked',
            'content_filtered', 'disappearing_set'
          ),
          allowNull: false,
        },
        targetUserId: { type: Sequelize.INTEGER, allowNull: true },
        messageId: { type: Sequelize.INTEGER, allowNull: true },
        reason: { type: Sequelize.TEXT, allowNull: true },
        metadata: { type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('ModerationLogs', ['groupId']);
      await queryInterface.addIndex('ModerationLogs', ['performedBy']);
      await queryInterface.addIndex('ModerationLogs', ['targetUserId']);
      await queryInterface.addIndex('ModerationLogs', ['action']);
      await queryInterface.addIndex('ModerationLogs', ['createdAt']);
      console.log('[groups-schema-catchup] Created ModerationLogs table');
    }

    // ── group_sender_key_distributions (from 20260621, FK typo fixed) ────
    if (!hasTable('group_sender_key_distributions')) {
      await queryInterface.createTable('group_sender_key_distributions', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        groupId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        ownerUserId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        recipientUserId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        keyGeneration: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        encryptedSenderKey: { type: Sequelize.TEXT, allowNull: false },
        isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addConstraint('group_sender_key_distributions', {
        fields: ['groupId', 'ownerUserId', 'recipientUserId', 'keyGeneration'],
        type: 'unique',
        name: 'group_sender_key_dist_unique',
      });
      await queryInterface.addIndex('group_sender_key_distributions', ['groupId', 'recipientUserId', 'isActive'], { name: 'group_sender_key_dist_recipient_idx' });
      await queryInterface.addIndex('group_sender_key_distributions', ['groupId', 'ownerUserId', 'isActive'], { name: 'group_sender_key_dist_owner_idx' });
      console.log('[groups-schema-catchup] Created group_sender_key_distributions table');
    }

    // ── group_sender_key_generations (from 20260721) ─────────────────────
    if (!hasTable('group_sender_key_generations')) {
      await queryInterface.createTable('group_sender_key_generations', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId: { type: Sequelize.INTEGER, allowNull: false, field: 'group_id' },
        ownerUserId: { type: Sequelize.INTEGER, allowNull: false, field: 'owner_user_id' },
        currentGeneration: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0, field: 'current_generation' },
        createdAt: { type: Sequelize.DATE, allowNull: false, field: 'created_at', defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, field: 'updated_at', defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('group_sender_key_generations', ['group_id', 'owner_user_id'], {
        unique: true,
        name: 'uq_group_sender_key_generations_group_owner',
      });
      console.log('[groups-schema-catchup] Created group_sender_key_generations table');

      // Backfill from any existing distributions so an owner who already
      // has keys out there doesn't get handed a colliding/lower number.
      if (hasTable('group_sender_key_distributions')) {
        await queryInterface.sequelize.query(`
          INSERT INTO group_sender_key_generations (group_id, owner_user_id, current_generation, created_at, updated_at)
          SELECT "groupId", "ownerUserId", MAX("keyGeneration"), NOW(), NOW()
          FROM group_sender_key_distributions
          GROUP BY "groupId", "ownerUserId"
          ON CONFLICT (group_id, owner_user_id) DO NOTHING;
        `);
      }
    }

    // ── Sealed-group tables (from 20260627) ──────────────────────────────
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS group_commitments (
        id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL,
        commitment TEXT NOT NULL, "memberCount" INTEGER NOT NULL DEFAULT 0,
        "publishedBy" INTEGER NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_gc_group_ts ON group_commitments("groupId","createdAt" DESC);'
    );
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS group_delivery_tokens (
        id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE("groupId","userId")
      );
    `);
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS group_sealed_invites (
        id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE, "encryptedInvite" TEXT NOT NULL,
        "createdBy" INTEGER NOT NULL, "expiresAt" TIMESTAMPTZ,
        "useCount" INTEGER NOT NULL DEFAULT 0, "maxUses" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log('[groups-schema-catchup] ✅ All group-related tables/columns verified present');
  },

  async down() {
    // Intentionally a no-op: this migration only ever creates things that
    // other migrations' `down()` already know how to drop, and re-deriving
    // "did I create this or was it already there" isn't worth the risk.
  },
};
