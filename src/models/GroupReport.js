// MODEL: GroupReport.js
// Group-level abuse/spam reports — backend route was missing entirely
// (reportGroup() on the frontend was an empty stub). Mirrors MessageReport
// but for the group itself rather than a single message.
module.exports = (sequelize, DataTypes) => {
  const GroupReport = sequelize.define(
    'GroupReport',
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
      reporterId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      reason: {
        type: DataTypes.ENUM(
          'spam',
          'harassment',
          'hate_speech',
          'violence',
          'sexual_content',
          'misinformation',
          'other'
        ),
        allowNull: false,
      },
      details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('pending', 'reviewed', 'actioned', 'dismissed'),
        defaultValue: 'pending',
        allowNull: false,
      },
      reviewedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      reviewedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      tableName: 'GroupReports',
      modelName: 'GroupReport',
      timestamps: true,
      freezeTableName: true,
      indexes: [
        { fields: ['groupId'] },
        { fields: ['status'] },
        { fields: ['reporterId', 'groupId'], unique: true },
      ],
    }
  );

  GroupReport.associate = function (models) {
    if (models.Users) {
      GroupReport.belongsTo(models.Users, {
        foreignKey: 'reporterId',
        as: 'reportedByUser',
        onDelete: 'CASCADE',
      });
    }
    if (models.Groups) {
      GroupReport.belongsTo(models.Groups, {
        foreignKey: 'groupId',
        as: 'reportedGroup',
        onDelete: 'CASCADE',
      });
    }
  };

  return GroupReport;
};
