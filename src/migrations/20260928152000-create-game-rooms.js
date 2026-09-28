'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('GameRooms', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      code: { type: Sequelize.STRING(12), allowNull: false, unique: true },
      gameType: { type: Sequelize.STRING(30), allowNull: false },
      level: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      hostId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      guestId: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      targetUserId: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      status: { type: Sequelize.ENUM('waiting','ready','playing','finished','closed'), allowNull: false, defaultValue: 'waiting' },
      seed: { type: Sequelize.STRING(64), allowNull: false },
      hostScore: { type: Sequelize.INTEGER, allowNull: true },
      guestScore: { type: Sequelize.INTEGER, allowNull: true },
      winnerId: { type: Sequelize.INTEGER, allowNull: true },
      state: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('GameRooms', ['gameType', 'status'], { name: 'game_rooms_type_status_idx' });
    await queryInterface.addIndex('GameRooms', ['expiresAt'], { name: 'game_rooms_expires_idx' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('GameRooms');
  },
};
