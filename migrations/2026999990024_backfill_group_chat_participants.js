'use strict';

/**
 * FIX (GROUP-JOIN-CHATPARTICIPANT-GAP — backfill): POST /groups/:id/join
 * (src/controllers/groupController.js's joinGroup) never mirrored a new
 * membership into chat_participants for the group's underlying Chats row.
 * The code fix stops the gap from growing, but every member who joined a
 * group through that endpoint before this fix shipped is still missing
 * their chat_participants row today. This migration is the one-time
 * repair: for every active (leftAt IS NULL) GroupMembers row, ensure a
 * matching chat_participants row exists for that group's chat.
 *
 * Idempotent — only inserts rows that don't already exist. Safe to re-run.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    const tables = await queryInterface.showAllTables();
    const lower = tables.map((t) => String(t).toLowerCase());
    if (!lower.includes('groupmembers') && !lower.includes('groups')) {
      console.log('[Migration] Groups/GroupMembers tables not found — skipping backfill.');
      return;
    }

    const groupMembersTable = tables.find((t) => String(t).toLowerCase() === 'groupmembers') || 'GroupMembers';
    const groupsTable       = tables.find((t) => String(t).toLowerCase() === 'groups') || 'Groups';
    const chatParticipantsTable =
      tables.find((t) => String(t).toLowerCase() === 'chat_participants') || 'chat_participants';

    const [result] = await sequelize.query(`
      INSERT INTO "${chatParticipantsTable}" ("chatId", "userId", "createdAt", "updatedAt")
      SELECT DISTINCT g."chatId", gm."userId", NOW(), NOW()
      FROM "${groupMembersTable}" gm
      JOIN "${groupsTable}" g ON g.id = gm."groupId"
      WHERE gm."leftAt" IS NULL
        AND g."chatId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "${chatParticipantsTable}" cp
          WHERE cp."chatId" = g."chatId" AND cp."userId" = gm."userId"
        )
      ON CONFLICT DO NOTHING;
    `).catch((err) => {
      console.error('[Migration] group chat_participants backfill failed:', err.message);
      return [null];
    });

    console.log('[Migration] Backfilled chat_participants rows for existing group members:', result?.rowCount ?? 'unknown');
  },

  async down() {
    // Not reversible — these rows are the same as ones legitimately created
    // via the fixed join path, so there's no way to tell backfilled rows
    // apart from normal ones after the fact. Leaving them is strictly safer
    // than trying to guess-and-delete.
  },
};
