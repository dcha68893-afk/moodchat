// MODEL: GroupThread.js
// P2 FIX: Topic threads inside group chats (Discord-style thread replies)
'use strict';

module.exports = (sequelize, DataTypes) => {
  const GroupThread = sequelize.define(
    'GroupThread',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      groupId:      { type: DataTypes.INTEGER, allowNull: false },
      parentMessageId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'The group message that started this thread',
      },
      createdBy:    { type: DataTypes.INTEGER, allowNull: false },
      title: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: 'Optional thread title',
      },
      replyCount:   { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
      lastReplyAt:  { type: DataTypes.DATE, allowNull: true },
      lastReplyBy:  { type: DataTypes.INTEGER, allowNull: true },
      isLocked:     { type: DataTypes.BOOLEAN, defaultValue: false },
      isArchived:   { type: DataTypes.BOOLEAN, defaultValue: false },
      createdAt:    { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt:    { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'GroupThreads',
      modelName: 'GroupThread',
      timestamps: true,
      indexes: [
        { fields: ['groupId'] },
        { fields: ['parentMessageId'] },
        { fields: ['createdBy'] },
        { fields: ['lastReplyAt'] },
      ],
    }
  );

  GroupThread.associate = models => {
    if (models.Groups) GroupThread.belongsTo(models.Groups, { foreignKey: 'groupId', as: 'threadGroup' });
    if (models.Users)  GroupThread.belongsTo(models.Users,  { foreignKey: 'createdBy', as: 'threadCreator' });
  };

  return GroupThread;
};
