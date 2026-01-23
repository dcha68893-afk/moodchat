// --- MODEL: UserStatus.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const UserStatus = sequelize.define(
    'UserStatus',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
        references: {
          model: 'Users',
          key: 'id',
        },
      },
      status: {
        type: DataTypes.ENUM('online', 'offline', 'away', 'busy', 'invisible'),
        defaultValue: 'offline',
        allowNull: false,
      },
      lastSeen: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      customStatus: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      showLastSeen: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      showOnlineStatus: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      isTypingIn: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'Chats',
          key: 'id',
        },
      },
      typingStartedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      activeDevice: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      socketIds: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
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
    },
    {
      tableName: 'user_statuses',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['userId'],
          unique: true,
        },
        {
          fields: ['status'],
        },
        {
          fields: ['lastSeen'],
        },
        {
          fields: ['isTypingIn'],
        },
      ],
      hooks: {
        beforeUpdate: async (status, options) => {
          // Update lastSeen when status changes
          if (status.changed('status') && status.status === 'offline') {
            status.lastSeen = new Date();
          }
        },
      },
    }
  );

  // Instance methods
  UserStatus.prototype.setOnline = async function (socketId = null) {
    this.status = 'online';
    this.lastSeen = new Date();

    if (socketId && !this.socketIds.includes(socketId)) {
      this.socketIds = [...this.socketIds, socketId];
    }

    return await this.save();
  };

  UserStatus.prototype.setOffline = async function () {
    this.status = 'offline';
    this.lastSeen = new Date();
    this.socketIds = [];
    this.isTypingIn = null;
    this.typingStartedAt = null;

    return await this.save();
  };

  UserStatus.prototype.setAway = async function () {
    this.status = 'away';
    return await this.save();
  };

  UserStatus.prototype.setBusy = async function () {
    this.status = 'busy';
    return await this.save();
  };

  UserStatus.prototype.setInvisible = async function () {
    this.status = 'invisible';
    return await this.save();
  };

  UserStatus.prototype.updateLastSeen = async function () {
    this.lastSeen = new Date();
    return await this.save();
  };

  UserStatus.prototype.startTyping = async function (chatId) {
    this.isTypingIn = chatId;
    this.typingStartedAt = new Date();
    return await this.save();
  };

  UserStatus.prototype.stopTyping = async function () {
    this.isTypingIn = null;
    this.typingStartedAt = null;
    return await this.save();
  };

  UserStatus.prototype.addSocket = async function (socketId) {
    if (!this.socketIds.includes(socketId)) {
      this.socketIds = [...this.socketIds, socketId];
      return await this.save();
    }
    return this;
  };

  UserStatus.prototype.removeSocket = async function (socketId) {
    this.socketIds = this.socketIds.filter(id => id !== socketId);

    // If no sockets left, set offline
    if (this.socketIds.length === 0 && this.status !== 'offline' && this.status !== 'invisible') {
      this.status = 'offline';
      this.lastSeen = new Date();
    }

    return await this.save();
  };

  UserStatus.prototype.isOnline = function () {
    return this.status === 'online' || this.status === 'away' || this.status === 'busy';
  };

  UserStatus.prototype.canBeSeenOnline = function (userId) {
    // Check if user allows their online status to be seen
    if (!this.showOnlineStatus) {
      return false;
    }

    // If user is invisible, only they can see their online status
    if (this.status === 'invisible') {
      return userId === this.userId;
    }

    return this.isOnline();
  };

  UserStatus.prototype.canBeSeenLastSeen = function (userId) {
    // Check if user allows their last seen to be seen
    if (!this.showLastSeen) {
      return false;
    }

    // Users can always see their own last seen
    if (userId === this.userId) {
      return true;
    }

    return true;
  };

  // Static methods
  UserStatus.findByUserId = async function (userId) {
    return await this.findOne({
      where: { userId },
      include: [
        {
          model: this.sequelize.models.Users,
          attributes: ['id', 'username', 'avatar'],
        },
      ],
    });
  };

  UserStatus.getOnlineUsers = async function (options = {}) {
    const where = {
      status: ['online', 'away', 'busy'],
    };

    return await this.findAll({
      where: where,
      include: [
        {
          model: this.sequelize.models.Users,
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      limit: options.limit || 100,
      offset: options.offset || 0,
      order: [['lastSeen', 'DESC']],
    });
  };

  UserStatus.getUsersTypingInChat = async function (chatId) {
    return await this.findAll({
      where: {
        isTypingIn: chatId,
        status: ['online', 'away', 'busy'],
      },
      include: [
        {
          model: this.sequelize.models.Users,
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['typingStartedAt', 'ASC']],
    });
  };

  UserStatus.cleanupInactiveSockets = async function (timeoutMs = 30000) {
    const inactiveTime = new Date(Date.now() - timeoutMs);

    const statuses = await this.findAll({
      where: {
        status: ['online', 'away', 'busy'],
        lastSeen: { [Op.lt]: inactiveTime },
      },
    });

    for (const status of statuses) {
      status.socketIds = [];
      status.status = 'offline';
      await status.save();
    }

    return statuses.length;
  };

  // Associations defined in models/index.js
  UserStatus.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return UserStatus;
};