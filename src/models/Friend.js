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
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'accepted', 'rejected', 'blocked'),
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
      },
      blockedAt: {
        type: DataTypes.DATE,
        allowNull: true,
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
        validate: {
          min: 0,
          max: 10,
        },
      },
    },
    {
      tableName: 'friends',                 // Standardized: lowercase table name
      modelName: 'Friend',                   // Explicit model name
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['requesterId', 'receiverId'],
          unique: true,
        },
        {
          fields: ['requesterId'],
        },
        {
          fields: ['receiverId'],
        },
        {
          fields: ['status'],
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
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
    this.status = 'accepted';
    this.blockedAt = null;
    return await this.save();
  };

  // Static methods (PRESERVED)
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
          as: 'friendReceiverDetails',        // FIXED: Unique alias
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
          as: 'friendRequesterDetails',       // FIXED: Unique alias
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
          as: 'friendRequesterDetails',       // FIXED: Unique alias
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
          as: 'friendReceiverDetails',        // FIXED: Unique alias
          attributes: ['id', 'username', 'avatar', 'status', 'lastSeen'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  };

  // FIXED: Associations with unique aliases
  Friend.associate = function (models) {
    if (models.Users) {
      Friend.belongsTo(models.Users, {
        foreignKey: 'requesterId',
        as: 'friendRequesterDetails',         // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
      
      Friend.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'friendReceiverDetails',           // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Friend;
};