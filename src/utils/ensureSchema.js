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

  // ── Groups ────────────────────────────────────────────────────────────────
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

async function ensureSchema(sequelize) {
  const tag = '[SchemaEnforcer]';
  let added = 0;
  let created = 0;

  console.log(`${tag} 🔍 Inspecting live schema…`);

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

  if (added === 0 && created === 0) {
    console.log(`${tag} ✅ Schema is up to date — nothing to add`);
  } else {
    console.log(`${tag} 🎉 Schema enforced: ${created} table(s) created, ${added} column(s) added`);
  }
}

module.exports = ensureSchema;
