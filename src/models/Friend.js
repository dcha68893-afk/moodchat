const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const Friend = sequelize.define(
  'Friend',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    requesterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    receiverId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    status: {
      type: DataTypes.ENUM('pending', 'accepted', 'rejected', 'blocked'),
      defaultValue: 'pending',
      allowNull: false,
    },
    requestedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    respondedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    notes: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
  },
  {
    tableName: 'friends',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['requester_id', 'receiver_id'],
        unique: true,
      },
      {
        fields: ['requester_id'],
      },
      {
        fields: ['receiver_id'],
      },
      {
        fields: ['status'],
      },
    ],
    hooks: {
      beforeCreate: async friend => {
        // Ensure requesterId is always the smaller ID to prevent duplicate friendships
        if (friend.requesterId > friend.receiverId) {
          [friend.requesterId, friend.receiverId] = [friend.receiverId, friend.requesterId];
        }
      },
    },
  }
);

// Instance methods
Friend.prototype.accept = async function () {
  this.status = 'accepted';
  this.respondedAt = new Date();
  return await this.save();
};

Friend.prototype.reject = async function () {
  this.status = 'rejected';
  this.respondedAt = new Date();
  return await this.save();
};

Friend.prototype.block = async function () {
  this.status = 'blocked';
  this.respondedAt = new Date();
  return await this.save();
};

// Static methods
Friend.findFriendship = async function (userId1, userId2) {
  const smallerId = Math.min(userId1, userId2);
  const largerId = Math.max(userId1, userId2);

  return await this.findOne({
    where: {
      requesterId: smallerId,
      receiverId: largerId,
    },
  });
};

Friend.getFriends = async function (userId, status = 'accepted') {
  return await this.findAll({
    where: {
      status: status,
      [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
    },
    include: [
      {
        model: sequelize.models.User,
        as: 'requester',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen'],
        where: { id: { [Op.ne]: userId } },
        required: false,
      },
      {
        model: sequelize.models.User,
        as: 'receiver',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen'],
        where: { id: { [Op.ne]: userId } },
        required: false,
      },
    ],
  });
};

Friend.getPendingRequests = async function (userId) {
  return await this.findAll({
    where: {
      receiverId: userId,
      status: 'pending',
    },
    include: [
      {
        model: sequelize.models.User,
        as: 'requester',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
      },
    ],
    order: [['requestedAt', 'DESC']],
  });
};

Friend.getSentRequests = async function (userId) {
  return await this.findAll({
    where: {
      requesterId: userId,
      status: 'pending',
    },
    include: [
      {
        model: sequelize.models.User,
        as: 'receiver',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
      },
    ],
    order: [['requestedAt', 'DESC']],
  });
};

Friend.getBlockedUsers = async function (userId) {
  return await this.findAll({
    where: {
      status: 'blocked',
      [Op.or]: [{ requesterId: userId }, { receiverId: userId }],
    },
    include: [
      {
        model: sequelize.models.User,
        as: 'requester',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
        where: { id: { [Op.ne]: userId } },
        required: false,
      },
      {
        model: sequelize.models.User,
        as: 'receiver',
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar'],
        where: { id: { [Op.ne]: userId } },
        required: false,
      },
    ],
  });
};

Friend.areFriends = async function (userId1, userId2) {
  const friendship = await this.findFriendship(userId1, userId2);
  return friendship && friendship.status === 'accepted';
};

Friend.isBlocked = async function (userId1, userId2) {
  const friendship = await this.findFriendship(userId1, userId2);
  return friendship && friendship.status === 'blocked';
};

module.exports = Friend;
