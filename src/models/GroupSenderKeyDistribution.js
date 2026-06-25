// --- MODEL: GroupSenderKeyDistribution.js ---
module.exports = (sequelize, DataTypes) => {
  const GroupSenderKeyDistribution = sequelize.define(
    'GroupSenderKeyDistribution',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      groupId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      ownerUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      recipientUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      keyGeneration: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      encryptedSenderKey: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: 'group_sender_key_distributions',
      timestamps: true,
      indexes: [
        { fields: ['groupId', 'recipientUserId', 'isActive'] },
        { fields: ['groupId', 'ownerUserId', 'isActive'] },
      ],
    }
  );

  GroupSenderKeyDistribution.associate = (models) => {
    if (models.Group) {
      GroupSenderKeyDistribution.belongsTo(models.Group, { foreignKey: 'groupId', as: 'group' });
    }
    if (models.User || models.Users) {
      const User = models.User || models.Users;
      GroupSenderKeyDistribution.belongsTo(User, { foreignKey: 'ownerUserId', as: 'owner' });
      GroupSenderKeyDistribution.belongsTo(User, { foreignKey: 'recipientUserId', as: 'recipient' });
    }
  };

  return GroupSenderKeyDistribution;
};
