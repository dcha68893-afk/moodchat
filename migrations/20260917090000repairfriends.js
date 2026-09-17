'use strict';

/**
 * Repair the Friends schema used by the current Friend model.
 * Idempotent so a failed Render startup can safely retry the same migration.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const qi = queryInterface;

    const exists = async (tableName) => {
      const [rows] = await sequelize.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ${sequelize.escape(tableName)}
        LIMIT 1
      `);
      return rows.length > 0;
    };

    const columnExists = async (tableName, columnName) => {
      const [rows] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${sequelize.escape(tableName)}
          AND column_name = ${sequelize.escape(columnName)}
        LIMIT 1
      `);
      return rows.length > 0;
    };

    const columns = async (tableName) => {
      if (!(await exists(tableName))) return {};
      return qi.describeTable(tableName);
    };

    // Normalize the legacy quoted table into the canonical lower-case table.
    if (!(await exists('friends')) && await exists('Friends')) {
      await sequelize.query('ALTER TABLE "Friends" RENAME TO "friends"');
    }

    // If both versions exist, merge legacy records into the canonical table.
    if (await exists('friends') && await exists('Friends')) {
      const current = await columns('friends');
      const legacy = await columns('Friends');
      const cr = current.requester_id ? 'requester_id' : (current.requesterId ? 'requesterId' : 'userId');
      const cf = current.receiver_id ? 'receiver_id' : (current.receiverId ? 'receiverId' : 'friendId');
      const lr = legacy.requester_id ? 'requester_id' : (legacy.requesterId ? 'requesterId' : 'userId');
      const lf = legacy.receiver_id ? 'receiver_id' : (legacy.receiverId ? 'receiverId' : 'friendId');

      if (cr && cf && lr && lf && current.status && legacy.status) {
        const [targetStatus] = await sequelize.query(`
          SELECT data_type, udt_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'friends' AND column_name = 'status'
          LIMIT 1
        `);
        const target = targetStatus[0];
        const statusExpr = target?.data_type === 'USER-DEFINED'
          ? `CAST("status" AS text)::"${String(target.udt_name).replace(/"/g, '""')}"`
          : 'CAST("status" AS text)';

        await sequelize.query(`
          INSERT INTO "friends" ("${cr}", "${cf}", "status", "createdAt", "updatedAt")
          SELECT "${lr}", "${lf}", ${statusExpr},
                 COALESCE("createdAt", NOW()), COALESCE("updatedAt", NOW())
          FROM "Friends"
          WHERE "${lr}" IS NOT NULL AND "${lf}" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM "friends" f
              WHERE (f."${cr}" = "Friends"."${lr}" AND f."${cf}" = "Friends"."${lf}")
                 OR (f."${cr}" = "Friends"."${lf}" AND f."${cf}" = "Friends"."${lr}")
            )
        `);
      }
      await sequelize.query('DROP TABLE "Friends"');
    }

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

    // Normalize every known legacy column spelling.
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
      if (!(await columnExists('friends', name))) await qi.addColumn('friends', name, definition);
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

    // Ensure the existing PostgreSQL enum contains every status the current
    // Friend model legitimately writes before converting/casting anything.
    const [enumRows] = await sequelize.query(`
      SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'enum_friends_status' AND n.nspname = current_schema()
      LIMIT 1
    `);
    if (enumRows.length) {
      for (const value of ['pending', 'accepted', 'rejected', 'blocked', 'removed', 'cancelled', 'expired']) {
        await sequelize.query(`ALTER TYPE "enum_friends_status" ADD VALUE IF NOT EXISTS ${sequelize.escape(value)}`);
      }
    }

    // Convert a text/varchar status column only after the enum is guaranteed to
    // accept every value used by the model.
    const [statusMeta] = await sequelize.query(`
      SELECT data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'friends' AND column_name = 'status'
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
    // Non-destructive rollback: friendship data must survive rollback attempts.
  }
};