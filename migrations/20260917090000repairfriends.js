'use strict';

/**
 * Repair the Friends schema used by the current Friend model.
 * This migration is deliberately idempotent because the previous version
 * could fail during Render startup after partially changing the table.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const qi = queryInterface;

    const exists = async (tableName) => {
      const [rows] = await sequelize.query(`
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ${sequelize.escape(tableName)}
        LIMIT 1
      `);
      return rows.length > 0;
    };

    const columns = async (tableName) => {
      if (!(await exists(tableName))) return {};
      return await qi.describeTable(tableName);
    };

    const columnExists = async (tableName, columnName) => {
      const [rows] = await sequelize.query(`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${sequelize.escape(tableName)}
          AND column_name = ${sequelize.escape(columnName)}
        LIMIT 1
      `);
      return rows.length > 0;
    };

    // If only the legacy quoted Friends table exists, normalize it in place.
    if (!(await exists('friends')) && await exists('Friends')) {
      await sequelize.query('ALTER TABLE "Friends" RENAME TO "friends"');
    }

    // If both tables exist, merge legacy data into the current table first.
    // Status is explicitly converted according to the actual PostgreSQL type
    // of the target column; this avoids the enum/varchar error that previously
    // stopped Render from booting.
    if (await exists('friends') && await exists('Friends')) {
      const current = await columns('friends');
      const legacy = await columns('Friends');

      const currentRequester = current.requester_id ? 'requester_id' : (current.requesterId ? 'requesterId' : 'userId');
      const currentReceiver = current.receiver_id ? 'receiver_id' : (current.receiverId ? 'receiverId' : 'friendId');
      const legacyRequester = legacy.requester_id ? 'requester_id' : (legacy.requesterId ? 'requesterId' : 'userId');
      const legacyReceiver = legacy.receiver_id ? 'receiver_id' : (legacy.receiverId ? 'receiverId' : 'friendId');

      if (currentRequester && currentReceiver && legacyRequester && legacyReceiver) {
        const [statusMeta] = await sequelize.query(`
          SELECT c.data_type, c.udt_name
          FROM information_schema.columns c
          WHERE c.table_schema = current_schema()
            AND c.table_name = 'friends'
            AND c.column_name = 'status'
          LIMIT 1
        `);

        const target = statusMeta[0];
        const statusExpression = target && target.data_type === 'USER-DEFINED'
          ? `CAST("status" AS text)::"${String(target.udt_name).replace(/"/g, '""')}"`
          : 'CAST("status" AS text)';

        await sequelize.query(`
          INSERT INTO "friends" ("${currentRequester}", "${currentReceiver}", "status", "createdAt", "updatedAt")
          SELECT "${legacyRequester}", "${legacyReceiver}", ${statusExpression},
                 COALESCE("createdAt", NOW()), COALESCE("updatedAt", NOW())
          FROM "Friends"
          WHERE "${legacyRequester}" IS NOT NULL
            AND "${legacyReceiver}" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM "friends" f
              WHERE (f."${currentRequester}" = "Friends"."${legacyRequester}"
                 AND f."${currentReceiver}" = "Friends"."${legacyReceiver}")
                 OR (f."${currentRequester}" = "Friends"."${legacyReceiver}"
                 AND f."${currentReceiver}" = "Friends"."${legacyRequester}")
            )
        `);
      }

      // The legacy table has now been merged and must not remain as a second
      // source of truth for the Friend model.
      await sequelize.query('DROP TABLE "Friends"');
    }

    // Create the canonical table if neither form survived.
    if (!(await exists('friends'))) {
      await sequelize.query(`
        CREATE TABLE "friends" (
          "id" SERIAL PRIMARY KEY,
          "requester_id" INTEGER NOT NULL,
          "receiver_id" INTEGER NOT NULL,
          "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
          "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
    }

    // Normalize the old column names before adding anything else.
    if (await columnExists('friends', 'userId') && !(await columnExists('friends', 'requester_id'))) {
      await sequelize.query('ALTER TABLE "friends" RENAME COLUMN "userId" TO "requester_id"');
    }
    if (await columnExists('friends', 'friendId') && !(await columnExists('friends', 'receiver_id'))) {
      await sequelize.query('ALTER TABLE "friends" RENAME COLUMN "friendId" TO "receiver_id"');
    }
    if (await columnExists('friends', 'requesterId') && !(await columnExists('friends', 'requester_id'))) {
      await sequelize.query('ALTER TABLE "friends" RENAME COLUMN "requesterId" TO "requester_id"');
    }
    if (await columnExists('friends', 'receiverId') && !(await columnExists('friends', 'receiver_id'))) {
      await sequelize.query('ALTER TABLE "friends" RENAME COLUMN "receiverId" TO "receiver_id"');
    }

    const add = async (name, definition) => {
      if (!(await columnExists('friends', name))) {
        await qi.addColumn('friends', name, definition);
      }
    };

    await add('requester_id', { type: Sequelize.INTEGER, allowNull: false });
    await add('receiver_id', { type: Sequelize.INTEGER, allowNull: false });

    if (!(await columnExists('friends', 'status'))) {
      await sequelize.query(`ALTER TABLE "friends" ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'pending'`);
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

    // If an enum_friends_status type exists and the current status column is
    // text/varchar, convert it using an explicit PostgreSQL cast. We inspect
    // pg_catalog rather than Sequelize's formatted type string.
    const [statusMeta] = await sequelize.query(`
      SELECT c.data_type, c.udt_name
      FROM information_schema.columns c
      WHERE c.table_schema = current_schema()
        AND c.table_name = 'friends'
        AND c.column_name = 'status'
      LIMIT 1
    `);
    const [enumRows] = await sequelize.query(`
      SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'enum_friends_status'
        AND n.nspname = current_schema()
      LIMIT 1
    `);

    if (enumRows.length && statusMeta[0]?.data_type !== 'USER-DEFINED') {
      await sequelize.query(`
        ALTER TABLE "friends"
        ALTER COLUMN "status" TYPE "enum_friends_status"
        USING CAST("status" AS text)::"enum_friends_status"
      `);
    }

    await sequelize.query('CREATE INDEX IF NOT EXISTS "friends_requester_id_idx" ON "friends" ("requester_id")');
    await sequelize.query('CREATE INDEX IF NOT EXISTS "friends_receiver_id_idx" ON "friends" ("receiver_id")');
    await sequelize.query('CREATE INDEX IF NOT EXISTS "friends_status_idx" ON "friends" ("status")');
    await sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS "friends_requester_receiver_unique" ON "friends" ("requester_id", "receiver_id")');
  },

  async down() {
    // Non-destructive rollback: friendships must survive deployment rollback.
  }
};