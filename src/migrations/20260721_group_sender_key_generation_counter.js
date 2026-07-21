'use strict';
/**
 * Migration: atomic Sender Key generation counter
 *
 * Root cause: POST /api/group-encryption/:groupId/distribute trusted whatever
 * keyGeneration number the CLIENT sent, computed by the client itself from a
 * separate earlier GET /my-generation call ("current + 1"). Two calls close
 * together — two tabs/devices for the same account both sending a first
 * message in a brand new group around the same moment, each generating a
 * DIFFERENT random key — could both read the same "current generation" and
 * both submit the same "next" number. group_sender_key_distributions has no
 * unique constraint on (group_id, owner_user_id, key_generation) at all, so
 * there was nothing to stop this: whichever distribution request landed last
 * in bulkCreate's updateOnDuplicate simply won for whichever recipients
 * overlapped, silently discarding the other call's key for those recipients
 * — while the losing tab kept using its own (now orphaned) key locally,
 * making anything it sends under that generation number undecryptable by
 * everyone.
 *
 * Fix: a small counter table with a real unique constraint on
 * (group_id, owner_user_id), claimed via an atomic
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING in the route handler. The
 * database becomes the single source of truth for "what's the next
 * generation number", so two concurrent callers can never receive the same
 * one, regardless of how many devices or tabs are involved.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.createTable('group_sender_key_generations', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
        },
        groupId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          field: 'group_id',
        },
        ownerUserId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          field: 'owner_user_id',
        },
        currentGeneration: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
          field: 'current_generation',
        },
        createdAt: { type: Sequelize.DATE, allowNull: false, field: 'created_at', defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, field: 'updated_at', defaultValue: Sequelize.NOW },
      });
      console.log('✅ Created group_sender_key_generations');
    } catch (e) {
      console.warn(`⚠️  Could not create group_sender_key_generations: ${e.message}`);
    }

    try {
      await queryInterface.addIndex('group_sender_key_generations', ['group_id', 'owner_user_id'], {
        unique: true,
        name: 'uq_group_sender_key_generations_group_owner',
      });
      console.log('✅ Added unique index on (group_id, owner_user_id)');
    } catch (e) {
      console.warn(`⚠️  Could not add unique index: ${e.message}`);
    }

    // Backfill: seed each existing owner's counter from the highest
    // generation number already present in the distributions table, so an
    // owner who already has keys out there doesn't get handed a number that
    // collides with (or goes backwards from) one already in use.
    try {
      await queryInterface.sequelize.query(`
        INSERT INTO group_sender_key_generations (group_id, owner_user_id, current_generation, created_at, updated_at)
        SELECT "groupId", "ownerUserId", MAX("keyGeneration"), NOW(), NOW()
        FROM group_sender_key_distributions
        GROUP BY "groupId", "ownerUserId"
        ON CONFLICT (group_id, owner_user_id) DO NOTHING;
      `);
      console.log('✅ Backfilled generation counters from existing distributions');
    } catch (e) {
      console.warn(`⚠️  Backfill skipped: ${e.message}`);
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.dropTable('group_sender_key_generations');
    } catch (e) {
      console.warn(`⚠️  Could not drop group_sender_key_generations: ${e.message}`);
    }
  }
};
