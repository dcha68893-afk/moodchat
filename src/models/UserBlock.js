'use strict';
const { Op } = require('sequelize');

// Real, persisted block relationship. Found while building the Follow model
// (src/models/Follow.js) that blockUser/unblockUser/getBlockedUsers in
// profileController.js were ALSO complete stubs — they always responded
// success:true and wrote nothing, so nothing was ever actually blocked.
// This is the real version, plus wiring so a block actually stops the
// blocked party from following you or seeing your non-public content
// (see canView() in src/routes/status.js and followUser() in
// profileController.js).
module.exports = (sequelize, DataTypes) => {
  const UserBlock = sequelize.define('UserBlock', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    blockerId: { type: DataTypes.INTEGER, allowNull: false },
    blockedId: { type: DataTypes.INTEGER, allowNull: false },
    reason: { type: DataTypes.STRING(300), allowNull: true },
  }, {
    tableName: 'UserBlocks',
    freezeTableName: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['blockerId', 'blockedId'] },
      { fields: ['blockerId'] },
      { fields: ['blockedId'] },
    ],
  });

  UserBlock.associate = function (models) {
    if (!models.Users) return;
    UserBlock.belongsTo(models.Users, { foreignKey: 'blockerId', targetKey: 'id', as: 'blocker', constraints: false });
    UserBlock.belongsTo(models.Users, { foreignKey: 'blockedId', targetKey: 'id', as: 'blockedUser', constraints: false });
  };

  // True if either direction has blocked the other — used to gate viewing
  // and following, since a block should be mutual-effect even though it's
  // stored one-way (matches how most social apps treat blocking).
  UserBlock.isBlockedEitherWay = async function (a, b) {
    a = Number(a); b = Number(b);
    if (!a || !b) return false;
    const row = await this.findOne({
      where: {
        [Op.or]: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return !!row;
  };

  UserBlock.getBlockedIds = async function (userId) {
    userId = Number(userId); if (!userId) return [];
    const rows = await this.findAll({ where: { blockerId: userId }, attributes: ['blockedId'] });
    return rows.map(r => Number(r.blockedId));
  };

  return UserBlock;
};
