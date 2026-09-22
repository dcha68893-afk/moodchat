'use strict';

// Real, persisted one-way follow relationship (follower -> followedUser).
// This is deliberately separate from Friend (a two-way, request/accept
// relationship): TikTok-style "Following" means "I chose to see this
// person's posts", not "we are mutually connected". Until this model
// existed, /api/profiles/:userId/follow and the Vibes "Following" tab
// were both wired to nothing — see profileController.js and status.js
// for the callers this backs.
module.exports = (sequelize, DataTypes) => {
  const Follow = sequelize.define('Follow', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    followerId: { type: DataTypes.INTEGER, allowNull: false },
    followingId: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    tableName: 'Follows',
    freezeTableName: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['followerId', 'followingId'] },
      { fields: ['followerId'] },
      { fields: ['followingId'] },
    ],
  });

  Follow.associate = function (models) {
    if (!models.Users) return;
    Follow.belongsTo(models.Users, { foreignKey: 'followerId', targetKey: 'id', as: 'follower', constraints: false });
    Follow.belongsTo(models.Users, { foreignKey: 'followingId', targetKey: 'id', as: 'followedUser', constraints: false });
  };

  Follow.isFollowing = async function (followerId, followingId) {
    followerId = Number(followerId); followingId = Number(followingId);
    if (!followerId || !followingId) return false;
    return !!(await this.findOne({ where: { followerId, followingId } }));
  };

  Follow.getFollowingIds = async function (userId) {
    userId = Number(userId); if (!userId) return [];
    const rows = await this.findAll({ where: { followerId: userId }, attributes: ['followingId'] });
    return rows.map(r => Number(r.followingId));
  };

  Follow.getFollowerIds = async function (userId) {
    userId = Number(userId); if (!userId) return [];
    const rows = await this.findAll({ where: { followingId: userId }, attributes: ['followerId'] });
    return rows.map(r => Number(r.followerId));
  };

  return Follow;
};
