'use strict';
// FIX (NO-MIGRATION-FOR-CORE-TABLES / FIRST-SEND-FLAKY): `chats` and
// `chat_participants` — the two tables the entire 1:1 direct-messaging
// bootstrap flow depends on (directChatResolver.js, POST /chats/bootstrap,
// POST /chats/start, POST /messages) — had NO migration anywhere in this
// repo. They only ever got created by the best-effort `sequelize.sync()`
// self-heal fallback in src/models/index.js at server boot.
//
// Reproduced locally: on a genuinely fresh database, that fallback is not
// reliable — one boot successfully created both tables and a full
// register -> bootstrap -> send -> reply flow worked end-to-end; an
// otherwise-identical boot right after left `chat_participants` missing
// entirely (confirmed no CREATE TABLE for it ran), and the very first
// POST /chats/bootstrap a user ever made failed with:
//   relation "chat_participants" does not exist
// which is exactly a "first message send doesn't work" symptom — and,
// because it's a race rather than a hard failure, it can appear to work on
// one deploy/restart and not the next.
//
// This migration makes both tables durable and idempotent (CREATE TABLE IF
// NOT EXISTS, one-shot index/constraint guards), matching the schema
// src/models/Chats.js and src/models/ChatParticipant.js already define, so
// they exist deterministically regardless of how sync() behaves.
//
// @type {import('sequelize-cli').Migration}
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;

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

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS "chat_participants" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "chatId" INTEGER NOT NULL,
        "role" VARCHAR(20) NOT NULL DEFAULT 'member',
        "isMuted" BOOLEAN NOT NULL DEFAULT false,
        "mutedUntil" TIMESTAMP WITH TIME ZONE,
        "isPinned" BOOLEAN NOT NULL DEFAULT false,
        "pinnedAt" TIMESTAMP WITH TIME ZONE,
        "joinedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    // FKs added separately (not inline) so a pre-existing table from the
    // sync() fallback that's missing them doesn't block this migration —
    // each is independently idempotent.
    const addFkIfMissing = async (constraintName, sql) => {
      const [rows] = await sequelize.query(
        `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = :name`,
        { replacements: { name: constraintName } }
      );
      if (!rows.length) {
        await sequelize.query(sql).catch((e) => {
          console.warn(`[create_chats_and_chat_participants] skipped ${constraintName}: ${e.message}`);
        });
      }
    };

    await addFkIfMissing(
      'chats_createdBy_fkey',
      `ALTER TABLE "chats" ADD CONSTRAINT "chats_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Users"("id") ON UPDATE CASCADE ON DELETE SET NULL`
    );
    await addFkIfMissing(
      'chat_participants_userId_fkey',
      `ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON UPDATE CASCADE ON DELETE CASCADE`
    );
    await addFkIfMissing(
      'chat_participants_chatId_fkey',
      `ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON UPDATE CASCADE ON DELETE CASCADE`
    );

    await sequelize.query(`CREATE INDEX IF NOT EXISTS "chat_participants_user_id" ON "chat_participants" ("userId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS "chat_participants_chat_id" ON "chat_participants" ("chatId");`);
    await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "chat_participants_chat_id_user_id" ON "chat_participants" ("chatId", "userId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS "chat_participants_role" ON "chat_participants" ("role");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS "chat_participants_is_muted" ON "chat_participants" ("isMuted");`);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`DROP TABLE IF EXISTS "chat_participants";`);
    await sequelize.query(`DROP TABLE IF EXISTS "chats";`);
    await sequelize.query(`DROP TYPE IF EXISTS "enum_chats_type";`);
  },
};
