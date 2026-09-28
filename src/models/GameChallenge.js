// --- MODEL: GameChallenge.js ---
// Async challenge-a-friend: one user beats a score, challenges another to beat it
module.exports = (sequelize, DataTypes) => {
  const GameChallenge = sequelize.define(
    'GameChallenge',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      challengerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      targetId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      gameType: {
        type: DataTypes.STRING(30),
        allowNull: false,
      },
      challengerScore: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      targetScore: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('pending', 'accepted', 'completed', 'expired'),
        defaultValue: 'pending',
        allowNull: false,
      },
      result: {
        type: DataTypes.ENUM('challenger_wins', 'target_wins', 'draw', null),
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      inviteCode: {
        type: DataTypes.STRING(12),
        allowNull: true,
      },
      inviteTargetId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      roomSeed: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      gameLevel: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      player2Id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      player1Score: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      player2Score: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      joinedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'GameChallenges',
      timestamps: true,
    }
  );

  GameChallenge.associate = (models) => {
    const U = models.Users || models.User;
    if (U) {
      GameChallenge.belongsTo(U, { foreignKey: 'challengerId', as: 'challenger' });
      GameChallenge.belongsTo(U, { foreignKey: 'targetId', as: 'target' });
    }
  };

  return GameChallenge;
};