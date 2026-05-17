'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupTaskAssignment = sequelize.define('GroupTaskAssignment', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    taskId:      { type: DataTypes.INTEGER, allowNull: false },
    userId:      { type: DataTypes.INTEGER, allowNull: false },
    assignedBy:  { type: DataTypes.INTEGER, allowNull: false },
    completedAt: { type: DataTypes.DATE },
    createdAt:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupTaskAssignments', timestamps: false });

  GroupTaskAssignment.associate = models => {
    GroupTaskAssignment.belongsTo(models.GroupTask, { foreignKey: 'taskId', as: 'task' });
  };
  return GroupTaskAssignment;
};
