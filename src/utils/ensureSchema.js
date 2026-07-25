'use strict';
/**
 * ensureSchema.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing schema enforcer.
 *
 * On every server boot it compares the live PostgreSQL table columns against
 * the full expected schema and adds any that are missing — no migration files,
 * no sequelize-cli, no manual SQL.
 *
 * Safe to run repeatedly: every ADD COLUMN uses IF NOT EXISTS (or a
 * describeTable pre-check for older Postgres), so it is fully idempotent.
 *
 * Usage (called from DatabaseService.syncSchema in server.js):
 *
 *   const ensureSchema = require('./utils/ensureSchema');
 *   await ensureSchema(sequelizeInstance);
 */

const { DataTypes, QueryTypes } = require('sequelize');

// ─── Master column registry ───────────────────────────────────────────────────
// Each entry: { table, column, definition }
// Only columns that are ADDED after the initial table creation need to be here.
// Order matters for ENUM types (create type before addColumn).
const REQUIRED_COLUMNS = [

  // ── Users ──────────────────────────────────────────────────────────────────
  {
    table: 'Users', column: 'resetToken',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "resetToken" TEXT`,
  },
  {
    table: 'Users', column: 'resetTokenExpiry',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "resetTokenExpiry" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Users', column: 'mfaSecret',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "mfaSecret" VARCHAR(255)`,
  },
  {
    table: 'Users', column: 'mfaEnabled',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'Users', column: 'mfaBackupCodes',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "mfaBackupCodes" JSONB`,
  },
  // P2 FIX (Forensic Audit): GDPR right to erasure
  {
    table: 'Users', column: 'deletionRequestedAt',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMP WITH TIME ZONE`,
  },
  // P3 FIX (Forensic Audit): privacy policy acceptance on registration
  {
    table: 'Users', column: 'acceptedPrivacyPolicyAt',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "acceptedPrivacyPolicyAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Users', column: 'fcmToken',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "fcmToken" TEXT`,
  },
  {
    table: 'Users', column: 'dateOfBirth',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "dateOfBirth" DATE`,
  },
  {
    // FIX (PROFILE-COVER-MISSING-COLUMN): profileService.uploadCoverPhoto()
    // has always set `user.coverPhoto = url` and called user.save(), but no
    // such column ever existed on Users — Sequelize silently drops unknown
    // instance properties on save(), so the cover photo upload API call
    // "succeeded" while never actually persisting anything. Same root cause
    // class as the resetToken/mfaSecret entries above.
    table: 'Users', column: 'coverPhoto',
    sql: `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "coverPhoto" TEXT`,
  },

  // ── Groups ────────────────────────────────────────────────────────────────
  {
    // NEW: group cover photo (banner) — Groups previously only had `avatar`.
    table: 'Groups', column: 'coverPhoto',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "coverPhoto" TEXT`,
  },
  {
    table: 'Groups', column: 'slowModeInterval',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "slowModeInterval" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: 'Groups', column: 'postingRule',
    // ENUM: create type first (DO block is safe to run multiple times)
    pre: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_Groups_postingRule') THEN
              CREATE TYPE "enum_Groups_postingRule" AS ENUM ('open','read_only','announcement','admin_only','scheduled');
            END IF;
          END $$`,
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "postingRule" "enum_Groups_postingRule" NOT NULL DEFAULT 'open'`,
  },
  {
    table: 'Groups', column: 'disappearingTimer',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "disappearingTimer" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: 'Groups', column: 'pinnedMessageIds',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "pinnedMessageIds" INTEGER[] NOT NULL DEFAULT '{}'`,
  },
  {
    table: 'Groups', column: 'inviteLinkMaxUses',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "inviteLinkMaxUses" INTEGER`,
  },
  {
    table: 'Groups', column: 'inviteLinkUseCount',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "inviteLinkUseCount" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: 'Groups', column: 'groupUsername',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "groupUsername" VARCHAR(50)`,
  },
  {
    // FEATURE: powers the Discover-by-scope filter (friends / community / region / county / world)
    table: 'Groups', column: 'discoveryScope',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "discoveryScope" VARCHAR(20) NOT NULL DEFAULT 'world'`,
  },
  {
    // FIX (GROUP-CREATE-500): migration 20260723000002 added Groups.location
    // alongside discoveryScope, but only discoveryScope was ever added to this
    // self-healing fallback list. If the sequelize-cli migration step fails or
    // is skipped on any given boot (server.js swallows that error and keeps
    // starting), Groups.location never gets created — and groupService.js
    // always writes a `location` value on every group creation, so every
    // single "create group" request throws a Postgres "column location does
    // not exist" error, surfaced to the client as a generic 500.
    table: 'Groups', column: 'location',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "location" VARCHAR(100)`,
  },
  {
    table: 'Groups', column: 'blockedWords',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "blockedWords" TEXT[] NOT NULL DEFAULT '{}'`,
  },
  {
    table: 'Groups', column: 'scheduledPostingStart',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "scheduledPostingStart" TIME`,
  },
  {
    table: 'Groups', column: 'scheduledPostingEnd',
    sql: `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "scheduledPostingEnd" TIME`,
  },

  // ── GroupMembers ──────────────────────────────────────────────────────────
  {
    table: 'GroupMembers', column: 'mutedUntil',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "mutedUntil" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'GroupMembers', column: 'isBanned',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "isBanned" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'GroupMembers', column: 'banReason',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "banReason" TEXT`,
  },
  {
    table: 'GroupMembers', column: 'nickname',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "nickname" VARCHAR(100)`,
  },
  {
    table: 'GroupMembers', column: 'customTitle',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "customTitle" VARCHAR(100)`,
  },
  {
    table: 'GroupMembers', column: 'warnings',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "warnings" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // FIX (GROUPS-ALWAYS-0): migration 20260716000001 adds this column, but
    // it was never mirrored into this fallback list. groupService.getUserGroups()
    // filters `WHERE userId AND leftAt IS NULL`; when the column doesn't
    // exist that query throws "column leftAt does not exist", which is
    // caught and silently returns an empty array — every one of My
    // Groups/Joined/Admin/All Groups renders 0 groups and "No groups created
    // yet", even for users who created and joined groups successfully.
    table: 'GroupMembers', column: 'leftAt',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "leftAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'GroupMembers', column: 'notificationsMuted',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "notificationsMuted" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'GroupMembers', column: 'customSettings',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "customSettings" JSONB NOT NULL DEFAULT '{"bannedAt":null,"banReason":null,"banExpiry":null}'::jsonb`,
  },
  {
    // FIX: same class of bug as Groups.location above — migration
    // 20260723000001 added these two columns but they were never mirrored
    // into this fallback list, so favoriteGroup()/blockGroup() 500 if the
    // migration step didn't run on a given boot.
    table: 'GroupMembers', column: 'isFavorite',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "isFavorite" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'GroupMembers', column: 'isBlocked',
    sql: `ALTER TABLE "GroupMembers" ADD COLUMN IF NOT EXISTS "isBlocked" BOOLEAN NOT NULL DEFAULT false`,
  },

  // ── Messages ──────────────────────────────────────────────────────────────
  // FIX (2026-07-13): src/models/Message.js has accumulated columns over several
  // feature sessions (view-once, pin, disappearing timer, read receipts, replies,
  // soft-delete) that were never added here. Since DB_SYNC_ALTER is off by default,
  // sequelize.sync() never ALTERs an existing table, so every one of these was
  // silently missing in production — causing `column "X" does not exist` on
  // every Message.create()/update() that touches them (e.g. viewOnceViewedAt).
  {
    table: 'Messages', column: 'replyToId',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "replyToId" INTEGER`,
  },
  {
    table: 'Messages', column: 'replyToStatusId',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "replyToStatusId" INTEGER`,
  },
  {
    table: 'Messages', column: 'statusPreview',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "statusPreview" TEXT`,
  },
  {
    table: 'Messages', column: 'isEdited',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "isEdited" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'Messages', column: 'editedAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'isDeleted',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'Messages', column: 'deletedAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'deletedBy',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "deletedBy" INTEGER`,
  },
  {
    table: 'Messages', column: 'isRead',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "isRead" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'Messages', column: 'readAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'reactions',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "reactions" JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    table: 'Messages', column: 'metadata',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    table: 'Messages', column: 'encryptionKey',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "encryptionKey" VARCHAR(100)`,
  },
  {
    table: 'Messages', column: 'sentAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`,
  },
  {
    table: 'Messages', column: 'deliveredAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'expiresAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'disappearingTimer',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "disappearingTimer" INTEGER`,
  },
  {
    // THE reported bug: "column viewOnceViewedAt does not exist"
    table: 'Messages', column: 'viewOnceViewedAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "viewOnceViewedAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'viewOnceViewedBy',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "viewOnceViewedBy" INTEGER`,
  },
  {
    table: 'Messages', column: 'isPinned',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "isPinned" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'Messages', column: 'pinnedAt',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'Messages', column: 'pinnedBy',
    sql: `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "pinnedBy" INTEGER`,
  },
  // ─── FIX (MARKETPLACE-500s): Tool model fields with no matching migration ───
  {
    table: 'tools', column: 'approval_status',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "approval_status" VARCHAR(20) NOT NULL DEFAULT 'pending_review'`,
  },
  {
    table: 'tools', column: 'approved_at',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'tools', column: 'rejection_reason',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT`,
  },
  {
    table: 'tools', column: 'is_flash_sale',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "is_flash_sale" BOOLEAN NOT NULL DEFAULT false`,
  },
  {
    table: 'tools', column: 'flash_sale_price',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "flash_sale_price" DECIMAL(10,2)`,
  },
  {
    table: 'tools', column: 'flash_sale_end',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "flash_sale_end" TIMESTAMP WITH TIME ZONE`,
  },
  {
    table: 'tools', column: 'condition',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "condition" VARCHAR(20) DEFAULT 'new'`,
  },
  {
    table: 'tools', column: 'brand',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "brand" VARCHAR(100)`,
  },
  {
    table: 'tools', column: 'sku',
    sql: `ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "sku" VARCHAR(100)`,
  },
  {
    table: 'push_subscriptions', column: 'userAgent',
    sql: `ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "userAgent" VARCHAR(500)`,
  },
  {
    table: 'push_subscriptions', column: 'lastUsedAt',
    sql: `ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP WITH TIME ZONE`,
  },
];

// ─── Tables that must exist (created if missing) ──────────────────────────────
const REQUIRED_TABLES = [
  {
    name: 'ModerationLogs',
    sql: `CREATE TABLE IF NOT EXISTS "ModerationLogs" (
      "id"          SERIAL PRIMARY KEY,
      "groupId"     INTEGER,
      "actorId"     INTEGER,
      "targetId"    INTEGER,
      "action"      VARCHAR(100) NOT NULL,
      "reason"      TEXT,
      "metadata"    JSONB,
      "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'Carts',
    sql: `CREATE TABLE IF NOT EXISTS "Carts" (
      "id"          SERIAL PRIMARY KEY,
      "userId"      INTEGER NOT NULL,
      "items"       JSONB NOT NULL DEFAULT '[]',
      "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  // P3 FIX (Forensic Audit): "Implement password history (last 5)"
  {
    name: 'password_history',
    sql: `CREATE TABLE IF NOT EXISTS "password_history" (
      "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id"        INTEGER NOT NULL,
      "password_hash"  VARCHAR(255) NOT NULL,
      "created_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  // FIX: same class of bug as Groups.location — migration 20260723000001
  // creates this table, but it was never mirrored into this fallback list.
  {
    name: 'GroupReports',
    sql: `CREATE TABLE IF NOT EXISTS "GroupReports" (
      "id"          SERIAL PRIMARY KEY,
      "groupId"     INTEGER NOT NULL,
      "reporterId"  INTEGER NOT NULL,
      "reason"      VARCHAR(50) NOT NULL,
      "details"     TEXT,
      "status"      VARCHAR(20) NOT NULL DEFAULT 'pending',
      "reviewedBy"  INTEGER,
      "reviewedAt"  TIMESTAMP WITH TIME ZONE,
      "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },

  // ── AUDIT (2026-07-25): "many features failing with internal server
  // errors" — traced to ~22 tables whose migration files exist in
  // migrations/ (each with its own comment documenting the exact 500 it
  // causes) but were never actually applied, because the Docker deploy
  // command runs `node src/server.js` directly and never invokes
  // `sequelize-cli db:migrate`. This ensureSchema.js pass is the only thing
  // that has ever actually touched the live production schema. Every table
  // below is mirrored verbatim (columns/types/defaults) from its migration
  // so it self-heals on the next boot regardless of whether migrations ever
  // run. No FK constraints (this file's existing entries above don't use
  // them either — keeps table-creation order-independent) and VARCHAR in
  // place of native Postgres ENUM (avoids a CREATE TYPE pass per column;
  // Sequelize validates ENUM values at the application layer regardless of
  // the underlying column type, so this is a strictly safer fallback, not
  // a looser one).

  // group_sender_key_distributions — group E2E encryption (20260621000001)
  {
    name: 'group_sender_key_distributions',
    sql: `CREATE TABLE IF NOT EXISTS "group_sender_key_distributions" (
      "id"                  SERIAL PRIMARY KEY,
      "groupId"             INTEGER NOT NULL,
      "ownerUserId"         INTEGER NOT NULL,
      "recipientUserId"     INTEGER NOT NULL,
      "keyGeneration"       INTEGER NOT NULL DEFAULT 1,
      "encryptedSenderKey"  TEXT NOT NULL,
      "isActive"            BOOLEAN NOT NULL DEFAULT true,
      "createdAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "group_sender_key_dist_unique" UNIQUE ("groupId","ownerUserId","recipientUserId","keyGeneration")
    )`,
  },
  // group_sender_key_generations — atomic per-owner key counter (20260721)
  {
    name: 'group_sender_key_generations',
    sql: `CREATE TABLE IF NOT EXISTS "group_sender_key_generations" (
      "id"                  SERIAL PRIMARY KEY,
      "group_id"            INTEGER NOT NULL,
      "owner_user_id"       INTEGER NOT NULL,
      "current_generation"  INTEGER NOT NULL DEFAULT 0,
      "created_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updated_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "uq_group_sender_key_generations_group_owner" UNIQUE ("group_id","owner_user_id")
    )`,
  },
  // starred_messages (2026999990010) — GET /sync and starred endpoints 500'd
  {
    name: 'starred_messages',
    sql: `CREATE TABLE IF NOT EXISTS "starred_messages" (
      "id"         SERIAL PRIMARY KEY,
      "userId"     INTEGER NOT NULL,
      "messageId"  INTEGER NOT NULL,
      "chatId"     INTEGER NOT NULL,
      "starredAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "starred_messages_user_id_message_id_unique" UNIQUE ("userId","messageId")
    )`,
  },
  // push_subscriptions (2026999990011) — POST /api/push/subscribe 500'd
  {
    name: 'push_subscriptions',
    sql: `CREATE TABLE IF NOT EXISTS "push_subscriptions" (
      "id"                       SERIAL PRIMARY KEY,
      "userId"                   INTEGER NOT NULL,
      "endpoint"                 TEXT NOT NULL UNIQUE,
      "p256dh"                   VARCHAR(255) NOT NULL,
      "auth"                     VARCHAR(255) NOT NULL,
      "userAgent"                VARCHAR(500),
      "lastUsedAt"               TIMESTAMP WITH TIME ZONE,
      "gameRemindersEnabled"     BOOLEAN NOT NULL DEFAULT true,
      "lastDailyReminderSentAt"  TIMESTAMP WITH TIME ZONE,
      "createdAt"                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  // GameProgress (2026999990012) — GET /api/games/progress 500'd
  {
    name: 'GameProgress',
    sql: `CREATE TABLE IF NOT EXISTS "GameProgress" (
      "id"                SERIAL PRIMARY KEY,
      "userId"            INTEGER NOT NULL UNIQUE,
      "xp"                INTEGER NOT NULL DEFAULT 0,
      "level"             INTEGER NOT NULL DEFAULT 1,
      "coins"             INTEGER NOT NULL DEFAULT 250,
      "gems"              INTEGER NOT NULL DEFAULT 5,
      "streak"            INTEGER NOT NULL DEFAULT 0,
      "dayIndex"          INTEGER NOT NULL DEFAULT 0,
      "lastClaim"         TIMESTAMP WITH TIME ZONE,
      "avatar"            VARCHAR(10) NOT NULL DEFAULT '🦁',
      "achievements"      JSONB NOT NULL DEFAULT '{}'::jsonb,
      "shopOwned"         JSONB NOT NULL DEFAULT '[]'::jsonb,
      "bestScores"        JSONB NOT NULL DEFAULT '{}'::jsonb,
      "totalGames"        INTEGER NOT NULL DEFAULT 0,
      "totalPockets"      INTEGER NOT NULL DEFAULT 0,
      "totalLevels"       INTEGER NOT NULL DEFAULT 0,
      "lastSessionXp"     INTEGER NOT NULL DEFAULT 0,
      "lastSessionCoins"  INTEGER NOT NULL DEFAULT 0,
      "lastSessionAt"     TIMESTAMP WITH TIME ZONE,
      "isFlagged"         BOOLEAN NOT NULL DEFAULT false,
      "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  // message_delivery_logs (2026999990008) — raw INSERT in messages.js 500'd
  {
    name: 'message_delivery_logs',
    sql: `CREATE TABLE IF NOT EXISTS "message_delivery_logs" (
      "id"         SERIAL PRIMARY KEY,
      "messageId"  INTEGER NOT NULL,
      "userId"     INTEGER NOT NULL,
      "chatId"     INTEGER NOT NULL,
      "event"      VARCHAR(50) NOT NULL,
      "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "uniq_msg_delivery_log" UNIQUE ("messageId","userId","event")
    )`,
  },
  // LiveLocationSessions (2026999990005) — live location sharing
  {
    name: 'LiveLocationSessions',
    sql: `CREATE TABLE IF NOT EXISTS "LiveLocationSessions" (
      "id"             SERIAL PRIMARY KEY,
      "messageId"      INTEGER NOT NULL,
      "chatId"         INTEGER NOT NULL,
      "userId"         INTEGER NOT NULL,
      "latitude"       DECIMAL(10,7) NOT NULL,
      "longitude"      DECIMAL(10,7) NOT NULL,
      "accuracy"       FLOAT,
      "heading"        FLOAT,
      "speed"          FLOAT,
      "startedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "expiresAt"      TIMESTAMP WITH TIME ZONE NOT NULL,
      "lastUpdatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "isActive"       BOOLEAN NOT NULL DEFAULT true,
      "stoppedAt"      TIMESTAMP WITH TIME ZONE,
      "stoppedReason"  VARCHAR(20),
      "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },

  // ── Chat-scoped polls (2026999990002) ─────────────────────────────────────
  {
    name: 'ChatPolls',
    sql: `CREATE TABLE IF NOT EXISTS "ChatPolls" (
      "id"                     SERIAL PRIMARY KEY,
      "chatId"                 INTEGER NOT NULL,
      "messageId"              INTEGER,
      "createdBy"              INTEGER NOT NULL,
      "question"               VARCHAR(500) NOT NULL,
      "allowMultipleAnswers"   BOOLEAN NOT NULL DEFAULT false,
      "isAnonymous"            BOOLEAN NOT NULL DEFAULT false,
      "closesAt"               TIMESTAMP WITH TIME ZONE,
      "isClosed"               BOOLEAN NOT NULL DEFAULT false,
      "closedAt"               TIMESTAMP WITH TIME ZONE,
      "closedBy"               INTEGER,
      "createdAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'ChatPollOptions',
    sql: `CREATE TABLE IF NOT EXISTS "ChatPollOptions" (
      "id"         SERIAL PRIMARY KEY,
      "pollId"     INTEGER NOT NULL,
      "text"       VARCHAR(255) NOT NULL,
      "position"   INTEGER NOT NULL DEFAULT 0,
      "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'ChatPollVotes',
    sql: `CREATE TABLE IF NOT EXISTS "ChatPollVotes" (
      "id"         SERIAL PRIMARY KEY,
      "pollId"     INTEGER NOT NULL,
      "optionId"   INTEGER NOT NULL,
      "userId"     INTEGER NOT NULL,
      "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "uniq_chatpollvotes_option_user" UNIQUE ("optionId","userId")
    )`,
  },

  // ── Smart Group Tools (2026999990009) — 13 tables, all previously 500'd
  // with "relation does not exist" (task boards, events/RSVP, group polls,
  // notes, shared files, finance/levies, analytics, activity log, AI
  // summaries) ────────────────────────────────────────────────────────────
  {
    name: 'GroupTasks',
    sql: `CREATE TABLE IF NOT EXISTS "GroupTasks" (
      "id"             SERIAL PRIMARY KEY,
      "groupId"        INTEGER NOT NULL,
      "createdBy"      INTEGER NOT NULL,
      "title"          VARCHAR(255) NOT NULL,
      "description"    TEXT,
      "status"         VARCHAR(20) NOT NULL DEFAULT 'pending',
      "priority"       VARCHAR(20) NOT NULL DEFAULT 'medium',
      "dueDate"        TIMESTAMP WITH TIME ZONE,
      "parentTaskId"   INTEGER,
      "attachments"    JSONB NOT NULL DEFAULT '[]'::jsonb,
      "isRecurring"    BOOLEAN NOT NULL DEFAULT false,
      "recurringRule"  VARCHAR(100),
      "deletedAt"      TIMESTAMP WITH TIME ZONE,
      "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupTaskAssignments',
    sql: `CREATE TABLE IF NOT EXISTS "GroupTaskAssignments" (
      "id"           SERIAL PRIMARY KEY,
      "taskId"       INTEGER NOT NULL,
      "userId"       INTEGER NOT NULL,
      "assignedBy"   INTEGER NOT NULL,
      "completedAt"  TIMESTAMP WITH TIME ZONE,
      "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupEvents',
    sql: `CREATE TABLE IF NOT EXISTS "GroupEvents" (
      "id"                  SERIAL PRIMARY KEY,
      "groupId"             INTEGER NOT NULL,
      "createdBy"           INTEGER NOT NULL,
      "title"               VARCHAR(255) NOT NULL,
      "description"         TEXT,
      "location"            VARCHAR(255),
      "latitude"            DECIMAL(10,7),
      "longitude"           DECIMAL(10,7),
      "startTime"           TIMESTAMP WITH TIME ZONE NOT NULL,
      "endTime"             TIMESTAMP WITH TIME ZONE,
      "timezone"            VARCHAR(50) DEFAULT 'UTC',
      "isRecurring"         BOOLEAN DEFAULT false,
      "recurringRule"       VARCHAR(100),
      "recurrenceRule"      TEXT,
      "recurrenceIndex"     INTEGER DEFAULT 0,
      "recurrenceParentId"  INTEGER,
      "rsvpEnabled"         BOOLEAN DEFAULT true,
      "maxAttendees"        INTEGER,
      "coverImage"          VARCHAR(500),
      "livestreamUrl"       VARCHAR(500),
      "qrCode"              VARCHAR(500),
      "status"              VARCHAR(20) NOT NULL DEFAULT 'upcoming',
      "deletedAt"           TIMESTAMP WITH TIME ZONE,
      "createdAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupAttendance',
    sql: `CREATE TABLE IF NOT EXISTS "GroupAttendance" (
      "id"          SERIAL PRIMARY KEY,
      "eventId"     INTEGER NOT NULL,
      "groupId"     INTEGER NOT NULL,
      "userId"      INTEGER NOT NULL,
      "status"      VARCHAR(20) NOT NULL DEFAULT 'pending',
      "rsvpAt"      TIMESTAMP WITH TIME ZONE,
      "markedAt"    TIMESTAMP WITH TIME ZONE,
      "markedBy"    INTEGER,
      "gpsLat"      DECIMAL(10,7),
      "gpsLon"      DECIMAL(10,7),
      "qrVerified"  BOOLEAN DEFAULT false,
      "note"        TEXT,
      "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "idx_gattendance_event_user" UNIQUE ("eventId","userId")
    )`,
  },
  {
    name: 'GroupPolls',
    sql: `CREATE TABLE IF NOT EXISTS "GroupPolls" (
      "id"           SERIAL PRIMARY KEY,
      "groupId"      INTEGER NOT NULL,
      "createdBy"    INTEGER NOT NULL,
      "question"     VARCHAR(500) NOT NULL,
      "type"         VARCHAR(20) NOT NULL DEFAULT 'single',
      "isAnonymous"  BOOLEAN DEFAULT false,
      "allowChange"  BOOLEAN DEFAULT true,
      "showResults"  VARCHAR(20) NOT NULL DEFAULT 'always',
      "endsAt"       TIMESTAMP WITH TIME ZONE,
      "status"       VARCHAR(20) NOT NULL DEFAULT 'active',
      "deletedAt"    TIMESTAMP WITH TIME ZONE,
      "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupPollOptions',
    sql: `CREATE TABLE IF NOT EXISTS "GroupPollOptions" (
      "id"         SERIAL PRIMARY KEY,
      "pollId"     INTEGER NOT NULL,
      "text"       VARCHAR(255) NOT NULL,
      "emoji"      VARCHAR(10),
      "isCorrect"  BOOLEAN DEFAULT false,
      "position"   INTEGER DEFAULT 0,
      "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupPollVotes',
    sql: `CREATE TABLE IF NOT EXISTS "GroupPollVotes" (
      "id"         SERIAL PRIMARY KEY,
      "pollId"     INTEGER NOT NULL,
      "optionId"   INTEGER NOT NULL,
      "userId"     INTEGER NOT NULL,
      "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupNotes',
    sql: `CREATE TABLE IF NOT EXISTS "GroupNotes" (
      "id"           SERIAL PRIMARY KEY,
      "groupId"      INTEGER NOT NULL,
      "createdBy"    INTEGER NOT NULL,
      "title"        VARCHAR(255) NOT NULL,
      "content"      TEXT,
      "contentType"  VARCHAR(20) NOT NULL DEFAULT 'markdown',
      "isPinned"     BOOLEAN DEFAULT false,
      "tags"         JSONB NOT NULL DEFAULT '[]'::jsonb,
      "category"     VARCHAR(100),
      "version"      INTEGER DEFAULT 1,
      "deletedAt"    TIMESTAMP WITH TIME ZONE,
      "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupFiles',
    sql: `CREATE TABLE IF NOT EXISTS "GroupFiles" (
      "id"             SERIAL PRIMARY KEY,
      "groupId"        INTEGER NOT NULL,
      "uploadedBy"     INTEGER NOT NULL,
      "name"           VARCHAR(255) NOT NULL,
      "url"            VARCHAR(1000) NOT NULL,
      "mimeType"       VARCHAR(100),
      "sizeBytes"      BIGINT DEFAULT 0,
      "folder"         VARCHAR(255) DEFAULT '/',
      "tags"           JSONB NOT NULL DEFAULT '[]'::jsonb,
      "thumbnailUrl"   VARCHAR(1000),
      "downloadCount"  INTEGER DEFAULT 0,
      "isPublic"       BOOLEAN DEFAULT true,
      "deletedAt"      TIMESTAMP WITH TIME ZONE,
      "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupFinances',
    sql: `CREATE TABLE IF NOT EXISTS "GroupFinances" (
      "id"              SERIAL PRIMARY KEY,
      "groupId"         INTEGER NOT NULL,
      "createdBy"       INTEGER NOT NULL,
      "type"            VARCHAR(20) NOT NULL,
      "amount"          DECIMAL(15,2) NOT NULL,
      "currency"        VARCHAR(10) DEFAULT 'KES',
      "description"     TEXT,
      "category"        VARCHAR(100),
      "reference"       VARCHAR(255),
      "paidBy"          INTEGER,
      "approvedBy"      INTEGER,
      "status"          VARCHAR(20) NOT NULL DEFAULT 'pending',
      "receipt"         VARCHAR(1000),
      "runningBalance"  DECIMAL(15,2) NOT NULL DEFAULT 0,
      "deletedAt"       TIMESTAMP WITH TIME ZONE,
      "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'group_analytics',
    sql: `CREATE TABLE IF NOT EXISTS "group_analytics" (
      "id"               SERIAL PRIMARY KEY,
      "group_id"         INTEGER NOT NULL,
      "date"             DATE NOT NULL DEFAULT NOW(),
      "message_count"    INTEGER DEFAULT 0,
      "active_members"   INTEGER DEFAULT 0,
      "new_members"      INTEGER DEFAULT 0,
      "total_reactions"  INTEGER DEFAULT 0,
      "media_shared"     INTEGER DEFAULT 0,
      "call_minutes"     INTEGER DEFAULT 0,
      "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "idx_ganalytics_group_date" UNIQUE ("group_id","date")
    )`,
  },
  {
    name: 'GroupActivityLogs',
    sql: `CREATE TABLE IF NOT EXISTS "GroupActivityLogs" (
      "id"          SERIAL PRIMARY KEY,
      "groupId"     INTEGER NOT NULL,
      "userId"      INTEGER NOT NULL,
      "action"      VARCHAR(100) NOT NULL,
      "module"      VARCHAR(50),
      "targetId"    INTEGER,
      "targetType"  VARCHAR(50),
      "meta"        JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'GroupAISummaries',
    sql: `CREATE TABLE IF NOT EXISTS "GroupAISummaries" (
      "id"            SERIAL PRIMARY KEY,
      "groupId"       INTEGER NOT NULL,
      "type"          VARCHAR(20) NOT NULL,
      "summary"       TEXT NOT NULL,
      "actionItems"   JSONB NOT NULL DEFAULT '[]'::jsonb,
      "keywords"      JSONB NOT NULL DEFAULT '[]'::jsonb,
      "messageRange"  JSONB,
      "generatedBy"   VARCHAR(50) DEFAULT 'openai',
      "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },

  // ── Sealed group membership / Phase 4 group encryption (20260627) ────────
  {
    name: 'group_commitments',
    sql: `CREATE TABLE IF NOT EXISTS "group_commitments" (
      "id"            SERIAL PRIMARY KEY,
      "groupId"       INTEGER NOT NULL,
      "commitment"    TEXT NOT NULL,
      "memberCount"   INTEGER NOT NULL DEFAULT 0,
      "publishedBy"   INTEGER NOT NULL,
      "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'group_delivery_tokens',
    sql: `CREATE TABLE IF NOT EXISTS "group_delivery_tokens" (
      "id"         SERIAL PRIMARY KEY,
      "groupId"    INTEGER NOT NULL,
      "userId"     INTEGER NOT NULL,
      "token"      TEXT NOT NULL UNIQUE,
      "active"     BOOLEAN NOT NULL DEFAULT true,
      "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT "group_delivery_tokens_group_user_unique" UNIQUE ("groupId","userId")
    )`,
  },
  {
    name: 'group_sealed_invites',
    sql: `CREATE TABLE IF NOT EXISTS "group_sealed_invites" (
      "id"               SERIAL PRIMARY KEY,
      "groupId"          INTEGER NOT NULL,
      "token"            TEXT NOT NULL UNIQUE,
      "encryptedInvite"  TEXT NOT NULL,
      "createdBy"        INTEGER NOT NULL,
      "expiresAt"        TIMESTAMP WITH TIME ZONE,
      "useCount"         INTEGER NOT NULL DEFAULT 0,
      "maxUses"          INTEGER NOT NULL DEFAULT 1,
      "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },

  // GroupThreads (20260610000001) — reply-threading on group messages
  {
    name: 'GroupThreads',
    sql: `CREATE TABLE IF NOT EXISTS "GroupThreads" (
      "id"               SERIAL PRIMARY KEY,
      "groupId"          INTEGER NOT NULL,
      "parentMessageId"  INTEGER NOT NULL,
      "createdBy"        INTEGER NOT NULL,
      "title"            VARCHAR(200),
      "replyCount"       INTEGER DEFAULT 0,
      "lastReplyAt"      TIMESTAMP WITH TIME ZONE,
      "lastReplyBy"      INTEGER,
      "isLocked"         BOOLEAN DEFAULT false,
      "isArchived"       BOOLEAN DEFAULT false,
      "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
  },
];

// ─── Columns whose TYPE was wrong from creation (not missing — wrong type) ────
// Users.id is INTEGER, but these were originally declared UUID / UUID[],
// which throws a Sequelize/Postgres type error on every JOIN or array-contains
// query against them. Mirrors 20260626_fix_marketplace_fk_types.js and
// 20260711_fix_tool_saved_purchased_by_types.js — same "migration exists but
// never actually runs in production" gap as every table above. Safe to run
// on every boot: ALTER COLUMN TYPE to the type it already is is a fast,
// harmless no-op in Postgres.
const REQUIRED_TYPE_FIXES = [
  { table: 'tools',               column: 'seller_id',     arrayType: false },
  { table: 'marketplace_orders',  column: 'buyer_id',      arrayType: false },
  { table: 'marketplace_orders',  column: 'seller_id',     arrayType: false },
  { table: 'marketplace_reviews', column: 'user_id',       arrayType: false },
  { table: 'marketplace_reviews', column: 'seller_id',     arrayType: false },
  { table: 'wishlists',           column: 'user_id',       arrayType: false },
  { table: 'tools',               column: 'saved_by',      arrayType: true },
  { table: 'tools',               column: 'purchased_by',  arrayType: true },
];

// ─── Column-level DEFAULTs that were never set at the DB level ────────────────
// The Sequelize model declares defaultValue, but raw SQL INSERTs elsewhere in
// the app (src/routes/messages.js) omit these columns entirely, so Postgres
// stores NULL instead of applying the model's default. `WHERE isArchived =
// false` / `WHERE isRead = false` never match NULL, so new chats silently
// vanish from the sidebar and unread counts silently stay at 0 — not a 500,
// but the same "migration never actually ran" root cause as everything above.
// Every statement here is idempotent (safe to run identically every boot).
const REQUIRED_DEFAULTS = [
  { table: 'chats', column: 'isActive', type: 'BOOLEAN', default: 'true' },
  { table: 'chats', column: 'isArchived', type: 'BOOLEAN', default: 'false' },
  { table: 'Messages', column: 'isRead', type: 'BOOLEAN', default: 'false' },
  { table: 'Messages', column: 'isDeleted', type: 'BOOLEAN', default: 'false' },
  { table: 'Messages', column: 'isEdited', type: 'BOOLEAN', default: 'false' },
];

// ─── Postgres ENUM values that were never added to an existing type ───────────
// ALTER TYPE ... ADD VALUE can't run inside a transaction on older Postgres,
// so it's kept as its own pass. Mirrors 2026999990003_add_poll_viewonce_
// message_types.js — same never-ran-in-production gap: without 'poll' and
// 'view_once' as valid enum_Messages_type values, sending a poll message
// (even though the ChatPolls tables above now exist) or a view-once media
// message fails at the DB layer with an invalid input value error.
const REQUIRED_ENUM_VALUES = [
  { type: 'enum_Messages_type', value: 'poll' },
  { type: 'enum_Messages_type', value: 'view_once' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the set of tables that actually exist in the public schema.
 */
async function getLiveTables(sequelize) {
  const rows = await sequelize.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    { type: QueryTypes.SELECT }
  );
  return new Set(rows.map(r => r.tablename));
}

/**
 * Get the set of columns that exist for a given table.
 * Returns empty Set if the table doesn't exist.
 */
async function getLiveColumns(sequelize, table) {
  try {
    const rows = await sequelize.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = :table`,
      { replacements: { table }, type: QueryTypes.SELECT }
    );
    return new Set(rows.map(r => r.column_name));
  } catch (_) {
    return new Set();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Fix the Tools table if it's still on the original minimal 4-column schema
 * (id, name, description, type) from 2026118081500createtools.js, instead of
 * the full marketplace schema (seller_id, title, price, category, images[],
 * status, etc.) that src/models/Tool.js and every marketplace route expect.
 * Mirrors 20260608000001-fix-tools-marketplace-schema.js's own rename+
 * recreate approach exactly (renames the old table to Tools_legacy so no
 * data is lost, rather than dropping it) — same "migration never ran in
 * production" gap as everything else in this file, just structural instead
 * of additive so it needs its own guarded routine.
 */
async function fixToolsMarketplaceSchema(sequelize) {
  const tag = '[SchemaEnforcer]';
  const qi = sequelize.getQueryInterface();

  const tableDesc = await qi.describeTable('Tools').catch(() => null);
  if (!tableDesc) return false;           // Tools doesn't exist yet — REQUIRED_TABLES/normal model sync owns creating it
  if (tableDesc.seller_id) return false;  // already on the full marketplace schema — nothing to do

  const transaction = await sequelize.transaction();
  try {
    const hasLegacy = await qi.describeTable('Tools_legacy').catch(() => null);
    if (!hasLegacy) {
      await qi.renameTable('Tools', 'Tools_legacy', { transaction });
    } else {
      await qi.dropTable('Tools', { transaction });
    }

    await qi.createTable('Tools', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      seller_id: { type: DataTypes.UUID, allowNull: false },
      title: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      category: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'other' },
      type: { type: DataTypes.ENUM('service', 'digital', 'premium', 'physical'), allowNull: false, defaultValue: 'physical' },
      images: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: [] },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
      available: { type: DataTypes.BOOLEAN, defaultValue: true },
      is_premium: { type: DataTypes.BOOLEAN, defaultValue: false },
      is_spotlight: { type: DataTypes.BOOLEAN, defaultValue: false },
      is_featured: { type: DataTypes.BOOLEAN, defaultValue: false },
      is_boosted: { type: DataTypes.BOOLEAN, defaultValue: false },
      boost_expires_at: { type: DataTypes.DATE, allowNull: true },
      views: { type: DataTypes.INTEGER, defaultValue: 0 },
      saved_by: { type: DataTypes.ARRAY(DataTypes.UUID), defaultValue: [] },
      purchased_by: { type: DataTypes.ARRAY(DataTypes.UUID), defaultValue: [] },
      rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0 },
      rating_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      status: { type: DataTypes.ENUM('active', 'inactive', 'sold', 'deleted'), defaultValue: 'active', allowNull: false },
      currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
      stock: { type: DataTypes.INTEGER, allowNull: true },
      metadata: { type: DataTypes.JSONB, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { transaction });

    await qi.addIndex('Tools', ['seller_id'], { name: 'idx_tools_seller_id', transaction }).catch(() => {});
    await qi.addIndex('Tools', ['status'], { name: 'idx_tools_status', transaction }).catch(() => {});
    await qi.addIndex('Tools', ['category'], { name: 'idx_tools_category', transaction }).catch(() => {});
    await qi.addIndex('Tools', ['available'], { name: 'idx_tools_available', transaction }).catch(() => {});
    await qi.addIndex('Tools', ['is_featured'], { name: 'idx_tools_is_featured', transaction }).catch(() => {});
    await qi.addIndex('Tools', ['createdAt'], { name: 'idx_tools_created_at', transaction }).catch(() => {});

    await transaction.commit();
    console.log(`${tag} ✅ Rebuilt Tools table with full marketplace schema (old data preserved in Tools_legacy)`);
    return true;
  } catch (err) {
    await transaction.rollback();
    console.warn(`${tag} ⚠️  Could not rebuild Tools marketplace schema: ${err.message}`);
    return false;
  }
}

async function ensureSchema(sequelize) {
  const tag = '[SchemaEnforcer]';
  let added = 0;
  let created = 0;

  console.log(`${tag} 🔍 Inspecting live schema…`);

  // ── 0. Rebuild Tools if it's still on the old minimal (pre-marketplace)
  // schema — must run before the generic passes below, since REQUIRED_TABLES
  // only CREATEs a table when it's fully absent, and the type-fix pass
  // assumes seller_id/saved_by/purchased_by already exist in some form ──────
  await fixToolsMarketplaceSchema(sequelize).catch(err => {
    console.warn(`${tag} ⚠️  Tools schema check failed: ${err.message}`);
  });

  const liveTables = await getLiveTables(sequelize);

  // ── 1. Ensure required tables exist ────────────────────────────────────────
  for (const { name, sql } of REQUIRED_TABLES) {
    if (!liveTables.has(name)) {
      try {
        await sequelize.query(sql);
        console.log(`${tag} ✅ Created table: ${name}`);
        created++;
      } catch (err) {
        console.warn(`${tag} ⚠️  Could not create table ${name}: ${err.message}`);
      }
    }
  }

  // ── 2. Ensure required columns exist ───────────────────────────────────────
  // Group by table so we only call getLiveColumns once per table
  const byTable = {};
  for (const entry of REQUIRED_COLUMNS) {
    (byTable[entry.table] = byTable[entry.table] || []).push(entry);
  }

  for (const [table, entries] of Object.entries(byTable)) {
    if (!liveTables.has(table)) {
      console.log(`${tag} ⏭️  Table "${table}" doesn't exist yet — skipping column checks`);
      continue;
    }

    const liveCols = await getLiveColumns(sequelize, table);

    for (const { column, pre, sql } of entries) {
      if (liveCols.has(column)) continue; // already there

      try {
        if (pre) {
          await sequelize.query(pre);
        }
        await sequelize.query(sql);
        console.log(`${tag} ✅ Added column: ${table}.${column}`);
        added++;
      } catch (err) {
        // 42701 = duplicate_column — race condition safety, treat as success
        if (err.original?.code === '42701' || err.message?.includes('already exists')) {
          console.log(`${tag} ℹ️  Column ${table}.${column} already exists (race-safe)`);
        } else {
          console.warn(`${tag} ⚠️  Could not add ${table}.${column}: ${err.message}`);
        }
      }
    }
  }

  // ── 3. Fix columns whose type was wrong from creation (UUID → INTEGER) ─────
  let typeFixed = 0;
  for (const { table, column, arrayType } of REQUIRED_TYPE_FIXES) {
    if (!liveTables.has(table)) continue; // table doesn't exist yet, nothing to fix

    try {
      const rows = await sequelize.query(
        `SELECT data_type, udt_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = :table AND column_name = :column`,
        { replacements: { table, column }, type: QueryTypes.SELECT }
      );
      const col = rows[0];
      if (!col) continue; // column doesn't exist — the ADD COLUMN pass above (or a real migration) owns creating it

      const isUuid = arrayType
        ? (col.data_type === 'ARRAY' && col.udt_name === '_uuid')
        : col.udt_name === 'uuid';
      if (!isUuid) continue; // already the right type

      const targetType = arrayType ? 'INTEGER[]' : 'INTEGER';
      const usingClause = arrayType ? `ARRAY[]::INTEGER[]` : `"${column}"::text::integer`;
      await sequelize.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${targetType} USING ${usingClause}`
      );
      console.log(`${tag} ✅ Fixed type: ${table}.${column} → ${targetType}`);
      typeFixed++;
    } catch (err) {
      console.warn(`${tag} ⚠️  Could not fix type for ${table}.${column}: ${err.message}`);
    }
  }

  // ── 4. Backfill NULLs + set DB-level DEFAULT for columns whose model
  // default was never applied at the DB level ─────────────────────────────
  let defaultsFixed = 0;
  for (const { table, column, default: def } of REQUIRED_DEFAULTS) {
    if (!liveTables.has(table)) continue;

    const liveCols = await getLiveColumns(sequelize, table);
    if (!liveCols.has(column)) continue; // ADD COLUMN pass above owns creating it if missing

    try {
      const nullRows = await sequelize.query(
        `SELECT COUNT(*)::int AS cnt FROM "${table}" WHERE "${column}" IS NULL`,
        { type: QueryTypes.SELECT }
      );
      const nullCount = nullRows[0]?.cnt || 0;

      if (nullCount > 0) {
        await sequelize.query(`UPDATE "${table}" SET "${column}" = ${def} WHERE "${column}" IS NULL`);
      }
      await sequelize.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT ${def}`);

      if (nullCount > 0) {
        console.log(`${tag} ✅ Backfilled ${nullCount} NULL row(s) and set DEFAULT: ${table}.${column}`);
        defaultsFixed++;
      }
    } catch (err) {
      console.warn(`${tag} ⚠️  Could not fix default for ${table}.${column}: ${err.message}`);
    }
  }

  // ── 5. Ensure required ENUM values exist ───────────────────────────────────
  let enumsFixed = 0;
  for (const { type: enumType, value } of REQUIRED_ENUM_VALUES) {
    try {
      const exists = await sequelize.query(
        `SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
         WHERE t.typname = :enumType AND e.enumlabel = :value`,
        { replacements: { enumType, value }, type: QueryTypes.SELECT }
      );
      if (exists.length > 0) continue;

      await sequelize.query(`ALTER TYPE "${enumType}" ADD VALUE IF NOT EXISTS '${value}'`);
      console.log(`${tag} ✅ Added enum value: ${enumType}.${value}`);
      enumsFixed++;
    } catch (err) {
      if (!/already exists/i.test(err.message)) {
        console.warn(`${tag} ⚠️  Could not add enum value ${enumType}.${value}: ${err.message}`);
      }
    }
  }

  if (added === 0 && created === 0 && typeFixed === 0 && defaultsFixed === 0 && enumsFixed === 0) {
    console.log(`${tag} ✅ Schema is up to date — nothing to add`);
  } else {
    console.log(`${tag} 🎉 Schema enforced: ${created} table(s) created, ${added} column(s) added, ${typeFixed} column type(s) fixed, ${defaultsFixed} default(s) backfilled, ${enumsFixed} enum value(s) added`);
  }
}

module.exports = ensureSchema;
