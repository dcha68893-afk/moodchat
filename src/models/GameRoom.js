'use strict';

module.exports = (sequelize, DataTypes) => {
  const GameRoom = sequelize.define('GameRoom', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(12), allowNull: false, unique: true },
    gameType: { type: DataTypes.STRING(30), allowNull: false },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    hostId: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onDelete: 'CASCADE' },
    guestId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onDelete: 'SET NULL' },
    targetUserId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onDelete: 'SET NULL' },
    status: { type: DataTypes.ENUM('waiting','ready','playing','finished','closed'), allowNull: false, defaultValue: 'waiting' },
    seed: { type: DataTypes.STRING(64), allowNull: false },
    hostScore: { type: DataTypes.INTEGER, allowNull: true },
    guestScore: { type: DataTypes.INTEGER, allowNull: true },
    winnerId: { type: DataTypes.INTEGER, allowNull: true },
    state: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  }, { tableName: 'GameRooms', timestamps: true });

  GameRoom.associate = (models) => {
    const U = models.Users || models.User;
    if (U) {
      GameRoom.belongsTo(U, { foreignKey: 'hostId', as: 'host' });
      GameRoom.belongsTo(U, { foreignKey: 'guestId', as: 'guest' });
      GameRoom.belongsTo(U, { foreignKey: 'targetUserId', as: 'target' });
    }
  };
  return GameRoom;
};
