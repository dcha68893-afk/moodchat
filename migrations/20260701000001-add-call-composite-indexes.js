'use strict';

/**
 * Migration: add composite indexes to Calls table
 *
 * H-06 FIX: _cleanupTimedOut() runs WHERE status IN (...) AND createdAt < ?
 * and history queries run WHERE participants @> [userId] AND endedAt IS NOT NULL
 * ORDER BY endedAt DESC. Only single-column indexes existed, causing full table
 * scans on every cleanup sweep and every history load.
 *
 * New indexes:
 *   calls_status_created_idx  (status, createdAt) — cleanup sweep
 *   calls_status_ended_idx    (status, endedAt)   — history sort
 *   calls_participants_gin    participants GIN     — array-contains queries
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // Composite: status + createdAt for cleanup sweep
    await queryInterface.addIndex('Calls', ['status', 'createdAt'], {
      name:        'calls_status_created_idx',
      concurrently: true,
      ifNotExists:  true,
    }).catch(e => {
      // Already exists — safe to skip
      if (!e.message.includes('already exists')) throw e;
    });

    // Composite: status + endedAt for history / analytics sort
    await queryInterface.addIndex('Calls', ['status', 'endedAt'], {
      name:        'calls_status_ended_idx',
      concurrently: true,
      ifNotExists:  true,
    }).catch(e => {
      if (!e.message.includes('already exists')) throw e;
    });

    // GIN index on participants JSONB array for @> contains queries
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS calls_participants_gin
      ON "Calls" USING gin (participants);
    `).catch(e => {
      if (!e.message.includes('already exists')) throw e;
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Calls', 'calls_status_created_idx').catch(() => {});
    await queryInterface.removeIndex('Calls', 'calls_status_ended_idx').catch(() => {});
    await queryInterface.sequelize.query(
      `DROP INDEX CONCURRENTLY IF EXISTS calls_participants_gin;`
    ).catch(() => {});
  },
};
