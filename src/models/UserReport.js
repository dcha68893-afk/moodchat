'use strict';
// MODEL: UserReport.js
//
// FIX (Play Store compliance audit #4/#5): POST /api/privacy/report was
// trying to persist a general "report this user" action into ModerationLog
// — a model that requires a NOT-NULL groupId and whose `action` ENUM has no
// 'user_report' value (it only has group-moderation actions like kick/ban/
// mute). That insert always failed validation; the route's fallback raw
// INSERT into `moderation_logs` also targeted the wrong table/columns (the
// model's real table is `ModerationLogs`, capitalized, with a different
// schema) and failed too — both failures were silently swallowed, and the
// endpoint still told the reporter "Report submitted," so reports were
// never actually being stored anywhere. This is the dedicated model that
// route needed all along, parallel to the already-existing StatusReport
// and MessageReport models for those content types.
module.exports = (sequelize, DataTypes) => {
  const UserReport = sequelize.define(
    'UserReport',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      reporterId: { type: DataTypes.INTEGER, allowNull: false },
      reportedUserId: { type: DataTypes.INTEGER, allowNull: false },
      reason: {
        type: DataTypes.ENUM('spam', 'harassment', 'fake_account', 'inappropriate_content', 'other'),
        allowNull: false,
      },
      details: { type: DataTypes.TEXT, allowNull: true },
      messageIds: { type: DataTypes.JSONB, allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'reviewed', 'actioned', 'dismissed'),
        defaultValue: 'pending',
        allowNull: false,
      },
      reviewedBy: { type: DataTypes.INTEGER, allowNull: true },
      reviewedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false },
      updatedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false },
    },
    {
      tableName: 'user_reports',
      modelName: 'UserReport',
      timestamps: true,
      freezeTableName: true,
      indexes: [
        { fields: ['reporterId'] },
        { fields: ['reportedUserId'] },
        { fields: ['status'] },
      ],
    }
  );

  UserReport.associate = function (models) {
    if (!models.Users) return;
    UserReport.belongsTo(models.Users, { foreignKey: 'reporterId', as: 'reporter', constraints: false });
    UserReport.belongsTo(models.Users, { foreignKey: 'reportedUserId', as: 'reportedUser', constraints: false });
  };

  return UserReport;
};
