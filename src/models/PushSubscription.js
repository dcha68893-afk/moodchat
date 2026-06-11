// --- MODEL: PushSubscription.js ---
// Stores Web Push subscription objects (endpoint + keys) per user/device
module.exports = (sequelize, DataTypes) => {
  const PushSubscription = sequelize.define(
    'PushSubscription',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      endpoint: {
        type: DataTypes.TEXT,
        allowNull: false,
        unique: true,
      },
      p256dh: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      auth: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      // Per-category opt-ins so users can disable game reminders without
      // disabling chat message push notifications
      gameRemindersEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      lastDailyReminderSentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'PushSubscriptions',
      timestamps: true,
    }
  );

  PushSubscription.associate = (models) => {
    PushSubscription.belongsTo(models.Users || models.User, {
      foreignKey: 'userId',
      as: 'user',
    });
  };

  return PushSubscription;
};