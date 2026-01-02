const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const sequelize = require('./index');

const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      validate: {
        len: [3, 50],
        is: /^[a-zA-Z0-9_]+$/,
      },
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
        len: [1, 100],
      },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        len: [8, 100],
      },
    },
    firstName: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    lastName: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    avatar: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bio: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
      validate: {
        is: /^\+?[1-9]\d{1,14}$/,
      },
    },
    dateOfBirth: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    role: {
      type: DataTypes.ENUM('user', 'admin', 'moderator'),
      defaultValue: 'user',
      allowNull: false,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
    },
    lastSeen: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('online', 'offline', 'away', 'busy', 'invisible'),
      defaultValue: 'offline',
      allowNull: false,
    },
    settings: {
      type: DataTypes.JSONB,
      defaultValue: {
        notifications: {
          messages: true,
          friendRequests: true,
          mentions: true,
          calls: true,
        },
        privacy: {
          showOnline: true,
          showLastSeen: true,
          allowFriendRequests: true,
          allowMessages: 'friends',
        },
        theme: 'light',
        language: 'en',
      },
      allowNull: false,
    },
  },
  {
    tableName: 'users',
    timestamps: true,
    underscored: true,
    hooks: {
      beforeCreate: async user => {
        if (user.password) {
          user.password = await bcrypt.hash(user.password, 12);
        }
      },
      beforeUpdate: async user => {
        if (user.changed('password')) {
          user.password = await bcrypt.hash(user.password, 12);
        }
      },
    },
  }
);

// Instance methods
User.prototype.validatePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

User.prototype.toJSON = function () {
  const values = Object.assign({}, this.get());
  delete values.password;
  delete values.updatedAt;
  return values;
};

User.prototype.getPublicProfile = function () {
  const { id, username, firstName, lastName, avatar, bio, status, lastSeen } = this;
  return { id, username, firstName, lastName, avatar, bio, status, lastSeen };
};

// Static methods
User.findByEmail = async function (email) {
  return await this.findOne({ where: { email } });
};

User.findByUsername = async function (username) {
  return await this.findOne({ where: { username } });
};

User.search = async function (query, limit = 20) {
  return await this.findAll({
    where: {
      [Op.or]: [
        { username: { [Op.iLike]: `%${query}%` } },
        { firstName: { [Op.iLike]: `%${query}%` } },
        { lastName: { [Op.iLike]: `%${query}%` } },
        { email: { [Op.iLike]: `%${query}%` } },
      ],
    },
    limit: limit,
    attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio'],
  });
};

module.exports = User;
