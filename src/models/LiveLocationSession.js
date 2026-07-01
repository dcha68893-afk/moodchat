'use strict';

module.exports = (sequelize, DataTypes) => {
  const LiveLocationSession = sequelize.define('LiveLocationSession', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    messageId: { type: DataTypes.INTEGER, allowNull: false },
    chatId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    accuracy: { type: DataTypes.FLOAT, allowNull: true },
    heading: { type: DataTypes.FLOAT, allowNull: true },
    speed: { type: DataTypes.FLOAT, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    lastUpdatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    stoppedAt: { type: DataTypes.DATE, allowNull: true },
    stoppedReason: { type: DataTypes.STRING(20), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'LiveLocationSessions',
    timestamps: true,
    indexes: [
      { fields: ['chatId', 'isActive'] },
      { fields: ['userId', 'isActive'] },
      { fields: ['messageId'] },
      { fields: ['expiresAt'] },
    ],
  });

  LiveLocationSession.associate = function(models) {
    if (models.Messages) {
      LiveLocationSession.belongsTo(models.Messages, { foreignKey: 'messageId', as: 'message', constraints: false });
    }
    if (models.Chats) {
      LiveLocationSession.belongsTo(models.Chats, { foreignKey: 'chatId', as: 'chat', constraints: false });
    }
    if (models.Users) {
      LiveLocationSession.belongsTo(models.Users, { foreignKey: 'userId', as: 'sharer', constraints: false });
    }
  };

  return LiveLocationSession;
};
