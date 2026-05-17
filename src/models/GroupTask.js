'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupTask = sequelize.define('GroupTask', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:     { type: DataTypes.INTEGER, allowNull: false },
    createdBy:   { type: DataTypes.INTEGER, allowNull: false },
    title:       { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT },
    status:      { type: DataTypes.ENUM('pending','active','completed','overdue','cancelled'), defaultValue: 'pending' },
    priority:    { type: DataTypes.ENUM('low','medium','high','urgent'), defaultValue: 'medium' },
    dueDate:     { type: DataTypes.DATE },
    parentTaskId:{ type: DataTypes.INTEGER },
    attachments: { type: DataTypes.JSONB, defaultValue: [] },
    isRecurring: { type: DataTypes.BOOLEAN, defaultValue: false },
    recurringRule:{ type: DataTypes.STRING(100) },
    deletedAt:   { type: DataTypes.DATE },
    createdAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupTasks', paranoid: false, timestamps: true });

  GroupTask.associate = models => {
    GroupTask.belongsTo(models.Groups || models.Group, { foreignKey: 'groupId', as: 'group' });
    GroupTask.hasMany(models.GroupTaskAssignment, { foreignKey: 'taskId', as: 'assignments' });
    GroupTask.hasMany(GroupTask, { foreignKey: 'parentTaskId', as: 'subtasks' });
  };
  return GroupTask;
};
