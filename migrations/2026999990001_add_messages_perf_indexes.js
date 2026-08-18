'use strict';

/**
 * FIX-AUDIT (MSG-DB-001, MSG-DB-002): Performance indexes for the Messages table.
 *
 * MSG-DB-001 — The hottest query pattern in the messaging module is:
 *   WHERE "chatId" = X AND "isDeleted" = false ORDER BY "createdAt" DESC LIMIT N
 * The existing model only indexes (chatId) and (chatId, createdAt) separately —
 * neither covers the isDeleted filter, so Postgres falls back to a partial index
 * scan + sort. This adds the exact composite index the query planner wants.
 *
 * MSG-DB-002 — Message search uses `content ILIKE '%pattern%'`, which is a full
 * sequential scan with no usable index (B-tree indexes can't accelerate a
 * leading-wildcard LIKE). This adds a GIN trigram index via pg_trgm so ILIKE
 * search uses an index scan instead of scanning every row in the chat.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // FIX (MESSAGES-CHATID-TIMING): the original createmessages.js migration
    // never included a `chatId` column at all — it's added later by this
    // project's own in-app runtime migration system (models/index.js STEP 3,
    // which only runs once the actual Node server boots). `npx sequelize-cli
    // db:migrate` runs as a separate one-off subprocess during deploy,
    // BEFORE that runtime step ever executes, so on a database where nothing
    // else has added it yet, `chatId` genuinely does not exist at the point
    // this migration runs — reproduced against a real deploy. Previously
    // this crashed the whole `CREATE INDEX ... ("chatId", ...)` call with
    // "column chatId does not exist", aborting every migration after it
    // (including 2026999990017_create_offline_message_queue.js — the
    // direct cause of "relation offline_message_queue does not exist" in
    // production). Now this checks first and skips gracefully if chatId
    // isn't there yet; the runtime system will add both the column and
    // (separately, via models/index.js) its own indexes shortly after boot.
    const messagesCols = await queryInterface.describeTable('Messages').catch(() => null);
    if (!messagesCols || !messagesCols.chatId) {
      console.log('[add_messages_perf_indexes] Messages.chatId not present yet (added later by the runtime migration system) — skipping chatId-based indexes for now.');
      return;
    }

    // pg_trgm extension required for trigram GIN index (safe no-op if it already exists)
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // MSG-DB-001: composite index covering the primary message-fetch query
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_chat_deleted_created
      ON "Messages" ("chatId", "isDeleted", "createdAt" DESC);
    `).catch(async () => {
      // CONCURRENTLY cannot run inside a transaction block on some pg setups;
      // fall back to a regular (locking) index creation if that happens.
      await queryInterface.addIndex('Messages', ['chatId', 'isDeleted', 'createdAt'], {
        name: 'idx_messages_chat_deleted_created',
      });
    });

    // MSG-DB-002: trigram GIN index to accelerate ILIKE '%text%' search
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_content_trgm
      ON "Messages" USING gin (content gin_trgm_ops);
    `).catch(async () => {
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
        ON "Messages" USING gin (content gin_trgm_ops);
      `);
    });

    // MSG-DB-001b: composite index for the disappearing-messages cron job's
    // WHERE expiresAt IS NOT NULL AND expiresAt <= NOW() scan
    await queryInterface.addIndex('Messages', ['expiresAt'], {
      name: 'idx_messages_expires_at',
      where: { expiresAt: { [Sequelize.Op.ne]: null } },
    }).catch(() => {
      // Older sequelize-cli versions may not support partial index `where` in addIndex;
      // fall back to a full index on expiresAt.
      return queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON "Messages" ("expiresAt");
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_messages_chat_deleted_created;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_messages_content_trgm;`).catch(() => {});
    await queryInterface.removeIndex('Messages', 'idx_messages_expires_at').catch(() => {});
  },
};
