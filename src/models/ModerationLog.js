// MODEL: ModerationLog.js
// P1 FIX: Server-persisted moderation audit log (replaces in-memory ModerationAuditLog)
module.exports = (sequelize, DataTypes) => {
  const ModerationLog = sequelize.define(
    'ModerationLog',
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
      performedBy: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'userId of the admin/mod who performed the action',
      },
      action: {
        type: DataTypes.ENUM(
          'kick', 'ban', 'unban', 'mute', 'unmute',
          'role_change', 'warn', 'slow_mode_set', 'slow_mode_disabled',
          'posting_rule_changed', 'message_deleted', 'member_approved',
          'member_rejected', 'ownership_transferred', 'group_locked',
          'group_unlocked', 'content_filtered', 'disappearing_set'
        ),
        allowNull: false,
      },
      targetUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'userId affected by the action (null for group-level actions)',
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Relevant message ID (for message_deleted actions)',
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
        comment: 'Extra context: old/new role, slow mode interval, etc.',
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
      tableName: 'ModerationLogs',
      modelName: 'ModerationLog',
      timestamps: true,
      freezeTableName: true,
      indexes: [
        { fields: ['groupId'] },
        { fields: ['performedBy'] },
        { fields: ['targetUserId'] },
        { fields: ['action'] },
        { fields: ['createdAt'] },
      ],
    }
  );

  ModerationLog.associate = function (models) {
    if (models.Groups) {
      ModerationLog.belongsTo(models.Groups, {
        foreignKey: 'groupId',
        as: 'modLogGroup',
        onDelete: 'CASCADE',
      });
    }
    if (models.Users) {
      ModerationLog.belongsTo(models.Users, {
        foreignKey: 'performedBy',
        as: 'modLogActor',
      });
      ModerationLog.belongsTo(models.Users, {
        foreignKey: 'targetUserId',
        as: 'modLogTarget',
      });
    }
  };

  return ModerationLog;
};
