'use strict';
/**
 * Migration: create GameProgress table
 *
 * Same class of bug as 2026999990010/11: src/models/GameProgress.js defines
 * this table (per-user XP/coins/gems/streak/achievements/etc.) and the games
 * routes read/write it directly, but no migration anywhere ever creates it —
 * the cause of the 500 on GET /api/games/progress.
 *
 * Idempotent (checks describeTable first) so it's safe to run on every boot.
 *
 * APPLY WITH: npx sequelize-cli db:migrate
 * ROLLBACK:   npx sequelize-cli db:migrate:undo
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface.describeTable('GameProgress').catch(() => null);
    if (tableExists) {
      console.log('GameProgress already exists — skipping create');
      return;
    }

    await queryInterface.createTable('GameProgress', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      xp: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      level: { type: Sequelize.INTEGER, defaultValue: 1, allowNull: false },
      coins: { type: Sequelize.INTEGER, defaultValue: 250, allowNull: false },
      gems: { type: Sequelize.INTEGER, defaultValue: 5, allowNull: false },
      streak: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      dayIndex: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      lastClaim: { type: Sequelize.DATE, allowNull: true },
      avatar: { type: Sequelize.STRING(10), defaultValue: '🦁', allowNull: false },
      achievements: { type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      shopOwned: { type: Sequelize.JSONB, defaultValue: [], allowNull: false },
      bestScores: { type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      totalGames: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      totalPockets: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      totalLevels: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      lastSessionXp: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      lastSessionCoins: { type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      lastSessionAt: { type: Sequelize.DATE, allowNull: true },
      isFlagged: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    console.log('✅ GameProgress table created');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('GameProgress');
  },
};
