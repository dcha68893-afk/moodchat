'use strict';
module.exports = (sequelize, DataTypes) => {
  const GroupFinance = sequelize.define('GroupFinance', {
    id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    groupId:        { type: DataTypes.INTEGER, allowNull: false },
    createdBy:      { type: DataTypes.INTEGER, allowNull: false },
    type:           { type: DataTypes.ENUM('income','expense','transfer','levy'), allowNull: false },
    amount:         { type: DataTypes.DECIMAL(15,2), allowNull: false },
    currency:       { type: DataTypes.STRING(10), defaultValue: 'KES' },
    description:    { type: DataTypes.TEXT },
    category:       { type: DataTypes.STRING(100) },
    reference:      { type: DataTypes.STRING(255) },
    paidBy:         { type: DataTypes.INTEGER },
    approvedBy:     { type: DataTypes.INTEGER },
    status:         { type: DataTypes.ENUM('pending','approved','rejected','completed'), defaultValue: 'pending' },
    receipt:        { type: DataTypes.STRING(1000) },
    // P2 FIX: Running balance stored per transaction for O(1) retrieval
    runningBalance: { type: DataTypes.DECIMAL(15,2), defaultValue: 0, allowNull: false,
                      comment: 'Group balance after this transaction — computed on insert' },
    deletedAt:      { type: DataTypes.DATE },
    createdAt:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updatedAt:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, { tableName: 'GroupFinances', timestamps: true });

  GroupFinance.associate = models => {
    GroupFinance.belongsTo(models.Groups || models.Group, { foreignKey: 'groupId', as: 'group' });
  };
  return GroupFinance;
};

