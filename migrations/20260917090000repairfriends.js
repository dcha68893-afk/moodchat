'use strict';

/**
 * Repair the Friends schema used by the current Friend model.
 * Preserves existing friendship data and safely handles PostgreSQL ENUM status columns.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const tableInfo = async (tableName) => {
      try { return await qi.describeTable(tableName); } catch (_) { return null; }
    };

    let legacy = await tableInfo('Friends');
    let current = await tableInfo('friends');

    if (!current && legacy) {
      await qi.sequelize.query('ALTER TABLE "Friends" RENAME TO "friends"');
      current = await tableInfo('friends');
      legacy = null;
    }

    if (current && legacy) {
      const currentCols = Object.keys(current);
      const legacyCols = Object.keys(legacy);
      const legacyRequester = legacyCols.includes('requester_id') ? 'requester_id' : 'userId';
      const legacyReceiver = legacyCols.includes('receiver_id') ? 'receiver_id' : 'friendId';
      const currentRequester = currentCols.includes('requester_id') ? 'requester_id' : 'requesterId';
      const currentReceiver = currentCols.includes('receiver_id') ? 'receiver_id' : 'receiverId';

      const [statusTypeRows] = await qi.sequelize.query(`
        SELECT c.udt_name
        FROM information_schema.columns c
        WHERE c.table_schema = current_schema()
          AND c.table_name = 'friends'
          AND c.column_name = 'status'
        LIMIT 1
      `);
      const targetStatusType = statusTypeRows?.[0]?.udt_name;
      const statusExpression = targetStatusType
        ? `CAST("status" AS text)::"${String(targetStatusType).replace(/"/g, '""')}"`
        : '"status"';

      await qi.sequelize.query(`
        INSERT INTO "friends" ("${currentRequester}", "${currentReceiver}", "status", "createdAt", "updatedAt")
        SELECT "${legacyRequester}", "${legacyReceiver}", ${statusExpression}, "createdAt", "updatedAt"
        FROM "Friends"
        WHERE "${legacyRequester}" IS NOT NULL
          AND "${legacyReceiver}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "friends" f
            WHERE (f."${currentRequester}" = "Friends"."${legacyRequester}" AND f."${currentReceiver}" = "Friends"."${legacyReceiver}")
               OR (f."${currentRequester}" = "Friends"."${legacyReceiver}" AND f."${currentReceiver}" = "Friends"."${legacyRequester}")
          )
      `);
      await qi.sequelize.query('DROP TABLE "Friends"');
    }

    current = await tableInfo('friends');
    if (!current) {
      await qi.sequelize.query(`
        CREATE TABLE "friends" (
          "id" SERIAL PRIMARY KEY,
          "requester_id" INTEGER NOT NULL,
          "receiver_id" INTEGER NOT NULL,
          "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
          "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      current = await tableInfo('friends');
    }

    if (current.userId && !current.requester_id) {
      await qi.sequelize.query('ALTER TABLE "friends" RENAME COLUMN "userId" TO "requester_id"');
    }
    if (current.friendId && !current.receiver_id) {
      await qi.sequelize.query('ALTER TABLE "friends" RENAME COLUMN "friendId" TO "receiver_id"');
    }

    current = await tableInfo('friends');

    const add = async (name, definition) => {
      if (!current[name]) await qi.addColumn('friends', name, definition);
    };

    await add('requester_id', { type: Sequelize.INTEGER, allowNull: false });
    await add('receiver_id', { type: Sequelize.INTEGER, allowNull: false });

    // Never use Sequelize's ENUM addColumn here: an existing PostgreSQL enum
    // named enum_friends_status can make its generated DEFAULT expression fail.
    if (!current.status) {
      await qi.sequelize.query(`ALTER TABLE "friends" ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'pending'`);
    }

    await add('createdAt', { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW });
    await add('updatedAt', { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW });
    await add('accepted_at', { type: Sequelize.DATE, allowNull: true });
    await add('blocked_at', { type: Sequelize.DATE, allowNull: true });
    await add('notes', { type: Sequelize.STRING(200), allowNull: true });
    await add('category', { type: Sequelize.STRING(50), allowNull: true });
    await add('closeness_level', { type: Sequelize.INTEGER, allowNull: true, defaultValue: 0 });
    await add('is_pinned', { type: Sequelize.BOOLEAN, allowNull: true, defaultValue: false });
    await add('is_muted', { type: Sequelize.BOOLEAN, allowNull: true, defaultValue: false });
    await add('expires_at', { type: Sequelize.DATE, allowNull: true });
    await add('is_business', { type: Sequelize.BOOLEAN, allowNull: true, defaultValue: false });
    await add('request_message', { type: Sequelize.STRING(300), allowNull: true });
    await add('snoozed_until', { type: Sequelize.DATE, allowNull: true });
    await add('is_restricted', { type: Sequelize.BOOLEAN, allowNull: true, defaultValue: false });

    // If the database already has the enum_friends_status type, normalize a
    // newly-created VARCHAR status column to that exact enum type.
    const [enumRows] = await qi.sequelize.query(`
      SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'enum_friends_status'
        AND n.nspname = current_schema()
      LIMIT 1
    `);
    if (enumRows.length && (await tableInfo('friends')).status?.type === 'VARCHAR(32)') {
      await qi.sequelize.query(`
        ALTER TABLE "friends"
        ALTER COLUMN "status" TYPE "enum_friends_status"
        USING CAST("status" AS text)::"enum_friends_status"
      `);
    }

    await qi.sequelize.query('CREATE INDEX IF NOT EXISTS "friends_requester_id_idx" ON "friends" ("requester_id")');
    await qi.sequelize.query('CREATE INDEX IF NOT EXISTS "friends_receiver_id_idx" ON "friends" ("receiver_id")');
    await qi.sequelize.query('CREATE INDEX IF NOT EXISTS "friends_status_idx" ON "friends" ("status")');
    await qi.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS "friends_requester_receiver_unique" ON "friends" ("requester_id", "receiver_id")');
  },

  async down() {
    // Intentionally non-destructive: existing friendships must survive rollback attempts.
  }
};