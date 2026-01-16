const bcrypt = require('bcryptjs');

module.exports = (sequelize, DataTypes) => {
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
        // Hash password before creating user
        beforeCreate: async (user) => {
          if (user.password) {
            user.password = await bcrypt.hash(user.password, 12);
          }
        },
        // Hash password before updating if it changed
        beforeUpdate: async (user) => {
          if (user.changed('password')) {
            user.password = await bcrypt.hash(user.password, 12);
          }
        },
      },
    }
  );

  // ===== INSTANCE METHODS =====

  /**
   * Validate user password
   * @param {string} password - Plain text password to validate
   * @returns {Promise<boolean>} True if password matches
   */
  User.prototype.validatePassword = async function (password) {
    return await bcrypt.compare(password, this.password);
  };

  /**
   * Convert user instance to JSON, removing sensitive data
   * @returns {Object} User object without password and updatedAt
   */
  User.prototype.toJSON = function () {
    const values = Object.assign({}, this.get());
    delete values.password;
    delete values.updatedAt;
    return values;
  };

  /**
   * Get public profile data (safe for public viewing)
   * @returns {Object} Public user profile
   */
  User.prototype.getPublicProfile = function () {
    const { id, username, firstName, lastName, avatar, bio, status, lastSeen } = this;
    return { id, username, firstName, lastName, avatar, bio, status, lastSeen };
  };

  // ===== STATIC METHODS =====

  /**
   * Find user by email
   * @param {string} email - Email address
   * @returns {Promise<User|null>} Found user or null
   */
  User.findByEmail = async function (email) {
    return await this.findOne({ where: { email } });
  };

  /**
   * Find user by username
   * @param {string} username - Username
   * @returns {Promise<User|null>} Found user or null
   */
  User.findByUsername = async function (username) {
    return await this.findOne({ where: { username } });
  };

  /**
   * Search users by username, name, or email
   * @param {string} query - Search query
   * @param {number} limit - Maximum results (default: 20)
   * @returns {Promise<Array<User>>} Array of matching users
   */
  User.search = async function (query, limit = 20) {
    const { Op } = sequelize.Sequelize;
    
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

  return User;
};