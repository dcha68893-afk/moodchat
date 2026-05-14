module.exports = (sequelize, DataTypes) => {
  const StatusReaction = sequelize.define(
    'StatusReaction',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      statusId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      emoji: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'status_reactions',
      modelName: 'StatusReaction',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        { unique: true, fields: ['statusId', 'userId'], name: 'idx_status_reactions_unique' },
        { fields: ['statusId'], name: 'idx_status_reactions_status' },
        { fields: ['userId'], name: 'idx_status_reactions_user' },
        { fields: ['emoji'], name: 'idx_status_reactions_emoji' },
      ],
    }
  );

  StatusReaction.associate = function(models) {
    if (StatusReaction._associationsDefined) return;
    StatusReaction._associationsDefined = true;

    if (models.Status) {
      StatusReaction.belongsTo(models.Status, {
        foreignKey: 'statusId',
        as: 'status',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Users) {
      StatusReaction.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'reactionUser',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return StatusReaction;
};
