// --- MODEL: Friend.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
        field: 'requester_id',
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'receiver_id',
      },
      status: {
        // FIX: Added 'removed' and 'cancelled' — codebase writes these values but they
        // were missing from the ENUM, causing Sequelize validation errors or silent DB failures.
        type: DataTypes.ENUM('pending', 'accepted', 'rejected', 'blocked', 'removed', 'cancelled', 'expired'),
        defaultValue: 'pending',
        allowNull: false,
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
      acceptedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'accepted_at',
      },
      blockedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'blocked_at',
      },
      notes: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      category: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      closenessLevel: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'closeness_level',
        validate: {
          min: 0,
          max: 10,
        },
      },
      isPinned: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_pinned',
      },
      isMuted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_muted',
      },
      // P1 FIX: server-side temporary friend expiry
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'expires_at',
      },
      // P2 FIX: isBusiness flag (was sent by frontend but silently dropped)
      isBusiness: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_business',
      },
      // P2 FIX: LinkedIn-style connection note sent with request
      requestMessage: {
        type: DataTypes.STRING(300),
        allowNull: true,
        field: 'request_message',
      },
      // P3 FIX: snooze — hide friend from feed for N days without unfriending
      snoozedUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'snoozed_until',
      },
      // P3 FIX: restrict — friend can see public posts but not private ones
      isRestricted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_restricted',
      },
    },
    {
      tableName: 'friends',
      modelName: 'Friend',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
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
    }
  );

  // Instance methods
  Friend.prototype.accept = async function () {
    this.status = 'accepted';
    this.acceptedAt = new Date();
    return await this.save();
  };

  Friend.prototype.reject = async function () {
    this.status = 'rejected';
    return await this.save();
  };

  Friend.prototype.block = async function () {
    this.status = 'blocked';
    this.blockedAt = new Date();
    return await this.save();
  };

  Friend.prototype.unblock = async function () {
    // FIX: Setting status = 'accepted' was wrong when the two users were never friends —
    // it would make them friends automatically on unblock. Destroy the record instead
    // so they can send a fresh friend request if desired.
    this.blockedAt = null;
    return await this.destroy();
  };

  // Static methods
  Friend.getFriendship = async function (userId1, userId2) {
    return await this.findOne({
      where: {
        [Op.or]: [
          { requesterId: userId1, receiverId: userId2 },
          { requesterId: userId2, receiverId: userId1 },
        ],
      },
    });
  };

  Friend.getUserFriends = async function (userId, status = 'accepted') {
    if (!this.sequelize.models.Users) {
      return [];
    }

    const friendsAsRequester = await this.findAll({
      where: {
        requesterId: userId,
        status: status,
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'friendReceiverUser',
          attributes: ['id', 'username', 'avatar', 'status', 'lastSeen'],
        },
      ],
    });

    const friendsAsReceiver = await this.findAll({
      where: {
        receiverId: userId,
        status: status,
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'friendRequesterUser',
          attributes: ['id', 'username', 'avatar', 'status', 'lastSeen'],
        },
      ],
    });

    return [...friendsAsRequester, ...friendsAsReceiver];
  };

  Friend.getPendingRequests = async function (userId) {
    if (!this.sequelize.models.Users) {
      return [];
    }

    return await this.findAll({
      where: {
        receiverId: userId,
        status: 'pending',
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'friendRequesterUser',
          attributes: ['id', 'username', 'avatar', 'status', 'lastSeen'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  };

  Friend.getSentRequests = async function (userId) {
    if (!this.sequelize.models.Users) {
      return [];
    }

    return await this.findAll({
      where: {
        requesterId: userId,
        status: 'pending',
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'friendReceiverUser',
          attributes: ['id', 'username', 'avatar', 'status', 'lastSeen'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  };

  // Associations
  Friend.associate = function (models) {
    if (models.Users) {
      Friend.belongsTo(models.Users, {
        foreignKey: 'requesterId',
        as: 'friendRequesterUser',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
      
      Friend.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'friendReceiverUser',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Friend;
};