// --- MODEL: GameProgress.js ---
// Stores persistent game state per user (XP, coins, gems, achievements, best scores)
module.exports = (sequelize, DataTypes) => {
  const GameProgress = sequelize.define(
    'GameProgress',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      xp: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        allowNull: false,
      },
      coins: {
        type: DataTypes.INTEGER,
        defaultValue: 250,
        allowNull: false,
      },
      gems: {
        type: DataTypes.INTEGER,
        defaultValue: 5,
        allowNull: false,
      },
      streak: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      dayIndex: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      lastClaim: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      avatar: {
        type: DataTypes.STRING(10),
        defaultValue: '🦁',
        allowNull: false,
      },
      achievements: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      shopOwned: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      bestScores: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      totalGames: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      totalPockets: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      totalLevels: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      // Anti-cheat: track last session maximums
      lastSessionXp: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      lastSessionCoins: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      lastSessionAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      isFlagged: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
    },
    {
      tableName: 'GameProgress',
      timestamps: true,
    }
  );

  GameProgress.associate = (models) => {
    GameProgress.belongsTo(models.Users || models.User, {
      foreignKey: 'userId',
      as: 'user',
    });
  };

  return GameProgress;
};