'use strict';

/**
 * Repair the Friends schema used by the current Friend model.
 *
 * The original migration created a quoted "Friends" table with userId/friendId,
 * while the live model queries "friends" with requester_id/receiver_id.
 * This migration normalizes the live database without deleting existing
 * friendships. It is safe to run against either the legacy or already-repaired
 * schema.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const tableInfo = async (tableName) => {
      try { return await qi.describeTable(tableName); } catch (_) { return null; }
    };

    let legacy = await tableInfo('Friends');
    let current = await tableInfo('friends');

    // Legacy database: "Friends" -> "friends" and userId/friendId ->
    // requester_id/receiver_id. PostgreSQL folds unquoted identifiers to lower
    // case, but the original migration explicitly created "Friends".
    if (!current && legacy) {
      await qi.sequelize.query('ALTER TABLE "Friends" RENAME TO "friends"');
      current = await tableInfo('friends');
      legacy = null;
    }

    // If both tables exist, merge legacy rows into the current table first.
    // This avoids losing friendships after a partial/manual schema repair.
    if (current && legacy) {
      const currentCols = Object.keys(current);
      const legacyCols = Object.keys(legacy);
      const legacyRequester = legacyCols.includes('requester_id') ? 'requester_id' : 'userId';
      const legacyReceiver = legacyCols.includes('receiver_id') ? 'receiver_id' : 'friendId';
      const currentRequester = currentCols.includes('requester_id') ? 'requester_id' : 'requesterId';
      const currentReceiver = currentCols.includes('receiver_id') ? 'receiver_id' : 'receiverId';
      await qi.sequelize.query(`
        INSERT INTO "friends" (${currentRequester}, ${currentReceiver}, "status", "createdAt", "updatedAt")
        SELECT "${legacyRequester}", "${legacyReceiver}", "status", "createdAt", "updatedAt"
        FROM "Friends"
        WHERE "${legacyRequester}" IS NOT NULL AND "${legacyReceiver}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "friends" f
            WHERE (f.${currentRequester} = "Friends"."${legacyRequester}" AND f.${currentReceiver} = "Friends"."${legacyReceiver}")
               OR (f.${currentRequester} = "Friends"."${legacyReceiver}" AND f.${currentReceiver} = "Friends"."${legacyRequester}")
          )
      `);
      await qi.sequelize.query('DROP TABLE "Friends"');
    }

    current = await tableInfo('friends');
    if (!current) {
      await qi.createTable('friends', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        requester_id: { type: Sequelize.INTEGER, allowNull: false },
        receiver_id: { type: Sequelize.INTEGER, allowNull: false },
        status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'pending' },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }
      });
      current = await tableInfo('friends');
    }

    // Normalize old camelCase columns if a lowercase table was created by a
    // previous repair but still has the legacy column names.
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
    await add('status', { type: Sequelize.STRING, allowNull: false, defaultValue: 'pending' });
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

    // Keep the hot paths used by the Friends API indexed and make duplicate
    // friendship/request rows impossible going forward.
    await qi.sequelize.query('CREATE INDEX IF NOT EXISTS "friends_requester_id_idx" ON "friends" ("requester_id")');
    await qi.sequelize.query('CREATE INDEX IF NOT EXISTS "friends_receiver_id_idx" ON "friends" ("receiver_id")');
    await qi.sequelize.query('CREATE INDEX IF NOT EXISTS "friends_status_idx" ON "friends" ("status")');
    await qi.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS "friends_requester_receiver_unique" ON "friends" ("requester_id", "receiver_id")');
  },

  async down(queryInterface) {
    // Do not rename/drop the production Friends table on rollback. The repair
    // is intentionally non-destructive because existing friendship data must
    // survive deployments and rollback attempts.
  }
};