'use strict';

/**
 * FIX (CALLS-CHATID-MISSING): the original Calls table migration
 * (20260118081100createcalls.js) never created chatId, type, or duration
 * columns, even though src/models/Call.js has always defined them as real
 * attributes. Because Calls.findAll / findAndCountAll implicitly SELECT
 * every model attribute, every call to GET /history and GET /scheduled
 * failed in production with:
 *
 *   column "chatId" does not exist
 *
 * The model's runtime self-heal block (bottom of src/models/Call.js) adds
 * missing columns automatically, but its list never included these three,
 * and — being an async setImmediate() — it also races against early
 * request traffic right after a deploy. This migration is the durable,
 * deploy-time fix: it runs before the app accepts traffic and is safe to
 * re-run (idempotent, additive only).
 *
 * FIX (CALLS-CHATID-FK-CASE-MISMATCH): the chatId column below used to add
 * a foreign key with `references: { model: 'Chats' }` (capital C). The
 * physical table created by 2026999990000_create_chats_and_chat_participants
 * is named "chats" (lowercase — see src/models/Chats.js's `tableName:
 * 'chats'`). Sequelize/Postgres quote identifiers exactly as given, so
 * "Chats" and "chats" are different relations to Postgres — the FK always
 * failed with `relation "Chats" does not exist`, even on a completely
 * fresh database with no prior migration history (reproduced locally: a
 * clean `db:migrate` run from zero fails at this exact migration).
 *
 * Fixed by resolving the real, case-correct table name at runtime instead
 * of hardcoding a literal, and by making this migration self-healing: if
 * the chats table is somehow still missing when this runs (e.g. a
 * production database whose migration history predates
 * 2026999990000, or any other partial/out-of-order state), it creates the
 * minimal Chats schema itself (idempotent CREATE TABLE IF NOT EXISTS,
 * matching 2026999990000) before adding the FK, rather than failing.
 */

// Shared with 2026999990000_create_chats_and_chat_participants.js: creates
// the minimal "chats" table if it isn't already present. Idempotent.
async function ensureChatsTable(queryInterface, Sequelize) {
  const sequelize = queryInterface.sequelize;
  const tables = await queryInterface.showAllTables();
  const existing = tables.find((t) => String(t).toLowerCase() === 'chats');
  if (existing) return existing;

  console.warn(
    '[Migration] "chats" table not found before adding Calls.chatId — creating it now (expected to already exist via 2026999990000_create_chats_and_chat_participants).'
  );

  await sequelize.query(`
    DO $$ BEGIN
      CREATE TYPE "enum_chats_type" AS ENUM ('direct', 'group');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "chats" (
      "id" SERIAL PRIMARY KEY,
      "name" VARCHAR(100),
      "type" "enum_chats_type" NOT NULL DEFAULT 'direct',
      "createdBy" INTEGER,
      "description" TEXT,
      "avatar" VARCHAR(255),
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "isArchived" BOOLEAN NOT NULL DEFAULT false,
      "archivedBy" INTEGER,
      "archivedAt" TIMESTAMP WITH TIME ZONE,
      "deletedAt" TIMESTAMP WITH TIME ZONE,
      "deletedBy" INTEGER,
      "lastMessageId" INTEGER,
      "lastMessageAt" TIMESTAMP WITH TIME ZONE,
      "settings" JSONB NOT NULL DEFAULT '{"allowMedia":true,"allowCalls":true,"allowReactions":true,"allowReplies":true,"allowEditing":true,"allowDeleting":true,"slowMode":0,"requireAdminApproval":false}'::jsonb,
      "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  const refreshed = await queryInterface.showAllTables();
  return refreshed.find((t) => String(t).toLowerCase() === 'chats');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const callsTable = tables.find((t) => String(t).toLowerCase() === 'calls');
    if (!callsTable) {
      console.log('[Migration] Calls table not found — skipping (will be created by createcalls migration).');
      return;
    }

    const columns = await queryInterface.describeTable(callsTable);

    if (!columns.chatId) {
      // Resolve (and, if genuinely absent, create) the real chats table
      // before wiring the FK, instead of hardcoding a literal that can
      // mismatch case with the actual relation.
      const chatsTable = await ensureChatsTable(queryInterface, Sequelize);

      const chatIdDefinition = {
        type: Sequelize.INTEGER,
        allowNull: true,
      };
      if (chatsTable) {
        chatIdDefinition.references = { model: chatsTable, key: 'id' };
        chatIdDefinition.onUpdate = 'CASCADE';
        chatIdDefinition.onDelete = 'SET NULL';
      } else {
        // Should be unreachable — ensureChatsTable() either finds or
        // creates it — but never let a naming edge case hard-fail this
        // migration. Add the column now and let a later reconciliation
        // pass (e.g. 2026999990021/2026999990022) attach the FK.
        console.warn(
          `[Migration] Could not resolve or create "chats" table — adding ${callsTable}.chatId without a foreign-key constraint.`
        );
      }

      await queryInterface.addColumn(callsTable, 'chatId', chatIdDefinition);
      console.log(`[Migration] Added ${callsTable}.chatId${chatsTable ? '' : ' (no FK — chats table unavailable)'}`);
    }

    if (!columns.type) {
      await queryInterface.addColumn(callsTable, 'type', {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'audio',
      });
      console.log(`[Migration] Added ${callsTable}.type`);

      // Backfill from the legacy 'callType' column if it has data, so
      // existing rows don't silently default to 'audio'.
      if (columns.callType) {
        await queryInterface.sequelize.query(
          `UPDATE "${callsTable}" SET "type" = "callType" WHERE "callType" IS NOT NULL AND "callType" IN ('audio', 'video');`
        );
      }
    }

    if (!columns.duration) {
      await queryInterface.addColumn(callsTable, 'duration', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
      console.log(`[Migration] Added ${callsTable}.duration`);
    }

    // Backfill duration for completed calls that have both timestamps but
    // duration is still at the default 0, so history/analytics aren't blank.
    try {
      await queryInterface.sequelize.query(`
        UPDATE "${callsTable}"
        SET "duration" = GREATEST(0, EXTRACT(EPOCH FROM ("endedAt" - "startedAt"))::INTEGER)
        WHERE "duration" = 0 AND "startedAt" IS NOT NULL AND "endedAt" IS NOT NULL;
      `);
    } catch (e) {
      console.warn('[Migration] duration backfill skipped (non-fatal):', e.message);
    }

    // Index for the chatId lookups used by findActiveCall / getActiveCalls.
    try {
      await queryInterface.addIndex(callsTable, ['chatId'], {
        name: 'calls_chatid_idx',
      });
    } catch (e) {
      // already exists — ignore
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const callsTable = tables.find((t) => String(t).toLowerCase() === 'calls');
    if (!callsTable) return;

    try { await queryInterface.removeIndex(callsTable, 'calls_chatid_idx'); } catch (e) {}
    try { await queryInterface.removeColumn(callsTable, 'chatId'); } catch (e) {}
    try { await queryInterface.removeColumn(callsTable, 'type'); } catch (e) {}
    try { await queryInterface.removeColumn(callsTable, 'duration'); } catch (e) {}
  },
};
