'use strict';

async function ensureStatusSchema(db) {
  const sequelize = db.sequelize;
  // The legacy database may already contain a six-column Status table.
  // Use idempotent PostgreSQL SQL here instead of QueryInterface.addColumn so
  // existing rows and JSONB/default expressions are repaired safely.
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "Status" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "content" TEXT,
      "type" VARCHAR(24) NOT NULL DEFAULT 'text',
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const columns = [
    [`"mediaUrl" TEXT`, `"mediaPublicId" VARCHAR(500)`, `"mediaMime" VARCHAR(120)`,
     `"thumbnailUrl" TEXT`, `"caption" TEXT`, `"background" VARCHAR(120)`,
     `"font" VARCHAR(80)`, `"musicUrl" TEXT`, `"linkUrl" TEXT`],
    [`"mentions" JSONB NOT NULL DEFAULT '[]'::jsonb`, `"stickers" JSONB NOT NULL DEFAULT '[]'::jsonb`,
     `"topics" JSONB NOT NULL DEFAULT '[]'::jsonb`, `"moodType" VARCHAR(60)`,
     `"category" VARCHAR(60)`, `"intent" VARCHAR(60)`, `"privacy" VARCHAR(40) NOT NULL DEFAULT 'all_contacts'`,
     `"privacyList" JSONB NOT NULL DEFAULT '[]'::jsonb`],
    [`"durationSeconds" INTEGER NOT NULL DEFAULT 7`, `"allowReplies" BOOLEAN NOT NULL DEFAULT TRUE`,
     `"allowReactions" BOOLEAN NOT NULL DEFAULT TRUE`, `"allowSharing" BOOLEAN NOT NULL DEFAULT TRUE`,
     `"isPublic" BOOLEAN NOT NULL DEFAULT FALSE`, `"isActive" BOOLEAN NOT NULL DEFAULT TRUE`],
    [`"expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')`,
     `"viewCount" INTEGER NOT NULL DEFAULT 0`, `"reactionCount" INTEGER NOT NULL DEFAULT 0`,
     `"replyCount" INTEGER NOT NULL DEFAULT 0`, `"shareCount" INTEGER NOT NULL DEFAULT 0`,
     `"highlight" BOOLEAN NOT NULL DEFAULT FALSE`, `"pollOptions" JSONB NOT NULL DEFAULT '[]'::jsonb`]
  ];
  for (const group of columns) {
    await sequelize.query(`ALTER TABLE "Status" ${group.map(c => `ADD COLUMN IF NOT EXISTS ${c}`).join(', ')}`);
  }

  await sequelize.query(`
    UPDATE "Status"
    SET "expiresAt" = COALESCE("expiresAt", "createdAt" + INTERVAL '24 hours'),
        "updatedAt" = COALESCE("updatedAt", "createdAt")
    WHERE "expiresAt" IS NULL OR "updatedAt" IS NULL
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "StatusViews" (
      "id" SERIAL PRIMARY KEY,
      "statusId" INTEGER NOT NULL,
      "viewerId" INTEGER NOT NULL,
      "viewedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "StatusViews_status_user_unique" ON "StatusViews" ("statusId","viewerId");
    CREATE INDEX IF NOT EXISTS "StatusViews_status_idx" ON "StatusViews" ("statusId");
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "StatusReactions" (
      "id" SERIAL PRIMARY KEY,
      "statusId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL,
      "emoji" VARCHAR(16) NOT NULL DEFAULT '❤️',
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "StatusReactions_status_user_unique" ON "StatusReactions" ("statusId","userId");
    CREATE INDEX IF NOT EXISTS "StatusReactions_status_idx" ON "StatusReactions" ("statusId");
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "StatusReplies" (
      "id" SERIAL PRIMARY KEY,
      "statusId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL,
      "text" TEXT NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS "StatusReplies_status_created_idx" ON "StatusReplies" ("statusId","createdAt");
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "StatusReports" (
      "id" SERIAL PRIMARY KEY,
      "statusId" INTEGER NOT NULL,
      "reporterId" INTEGER NOT NULL,
      "reason" VARCHAR(80) NOT NULL,
      "details" TEXT,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS "StatusReports_status_idx" ON "StatusReports" ("statusId");
    CREATE INDEX IF NOT EXISTS "StatusReports_reporter_idx" ON "StatusReports" ("reporterId");
  `);
}

module.exports = { ensureStatusSchema };
