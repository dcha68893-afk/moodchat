module.exports = (sequelize, DataTypes) => {
  const StatusView = sequelize.define(
    'StatusView',
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
      viewedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
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
      tableName: 'status_views',
      modelName: 'StatusView',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        { unique: true, fields: ['statusId', 'userId'], name: 'idx_status_views_unique' },
        { fields: ['statusId'], name: 'idx_status_views_status' },
        { fields: ['userId'], name: 'idx_status_views_user' },
        { fields: ['viewedAt'], name: 'idx_status_views_viewed' },
      ],
    }
  );

  StatusView.associate = function(models) {
    if (StatusView._associationsDefined) return;
    StatusView._associationsDefined = true;

    if (models.Status) {
      StatusView.belongsTo(models.Status, {
        foreignKey: 'statusId',
        as: 'status',
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Users) {
      StatusView.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'viewerUser',
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return StatusView;
};
