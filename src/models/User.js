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
        unique: {
          name: 'username',
          msg: 'Username already exists'
        },
        validate: {
          len: {
            args: [3, 30],
            msg: 'Username must be between 3 and 30 characters'
          },
          is: {
            args: /^[a-zA-Z0-9_]+$/,
            msg: 'Username can only contain letters, numbers, and underscores'
          }
        },
      },
      email: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: {
          name: 'email',
          msg: 'Email already exists'
        },
        validate: {
          isEmail: {
            args: true,
            msg: 'Invalid email format'
          },
          len: {
            args: [1, 100],
            msg: 'Email must be less than 100 characters'
          }
        },
      },
      password: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          len: {
            args: [8, 100],
            msg: 'Password must be at least 8 characters long'
          }
        },
      },
      firstName: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: {
            args: [0, 50],
            msg: 'First name cannot exceed 50 characters'
          }
        }
      },
      lastName: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: {
            args: [0, 50],
            msg: 'Last name cannot exceed 50 characters'
          }
        }
      },
      avatar: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      bio: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: {
          len: {
            args: [0, 500],
            msg: 'Bio cannot exceed 500 characters'
          }
        }
      },
      phone: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          is: {
            args: /^\+?[1-9]\d{1,14}$/,
            msg: 'Invalid phone number format'
          }
        }
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
        // Hash password before creating user - FIXED: Ensure it only hashes when password exists
        beforeCreate: async (user) => {
          if (user.password && user.password.length > 0) {
            try {
              user.password = await bcrypt.hash(user.password, 12);
            } catch (error) {
              throw new Error(`Password hashing failed: ${error.message}`);
            }
          } else {
            throw new Error('Password is required');
          }
        },
        // Hash password before updating if it changed - FIXED: Explicit error handling
        beforeUpdate: async (user) => {
          if (user.changed('password')) {
            if (user.password && user.password.length > 0) {
              try {
                user.password = await bcrypt.hash(user.password, 12);
              } catch (error) {
                throw new Error(`Password hashing failed: ${error.message}`);
              }
            } else {
              throw new Error('Password cannot be empty');
            }
          }
        },
        // FIXED: Add beforeSave hook to ensure validation errors are thrown properly
        beforeSave: async (user) => {
          // Ensure password is hashed if it's a new user or password was changed
          if ((user.isNewRecord || user.changed('password')) && user.password) {
            if (user.password.length < 8) {
              throw new Error('Password must be at least 8 characters long');
            }
          }
        }
      },
    }
  );

  // ===== INSTANCE METHODS =====

  /**
   * Validate user password - FIXED: Explicit error handling
   * @param {string} password - Plain text password to validate
   * @returns {Promise<boolean>} True if password matches
   */
  User.prototype.validatePassword = async function (password) {
    if (!password || !this.password) {
      return false;
    }
    try {
      return await bcrypt.compare(password, this.password);
    } catch (error) {
      console.error('Password validation error:', error);
      return false;
    }
  };

  /**
   * Convert user instance to JSON, removing sensitive data
   * @returns {Object} User object without password and updatedAt
   */
  User.prototype.toJSON = function () {
    const values = Object.assign({}, this.get());
    
    // Remove sensitive fields
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

  /**
   * Update user's last seen timestamp
   * @returns {Promise<User>} Updated user instance
   */
  User.prototype.updateLastSeen = async function () {
    try {
      this.lastSeen = new Date();
      return await this.save();
    } catch (error) {
      console.error('Failed to update last seen:', error);
      throw error;
    }
  };

  // ===== STATIC METHODS =====

  /**
   * Find user by email - FIXED: Explicit error handling
   * @param {string} email - Email address
   * @returns {Promise<User|null>} Found user or null
   */
  User.findByEmail = async function (email) {
    if (!email) {
      throw new Error('Email is required');
    }
    try {
      return await this.findOne({ 
        where: { 
          email: email.toLowerCase().trim() 
        } 
      });
    } catch (error) {
      console.error('Error finding user by email:', error);
      throw error;
    }
  };

  /**
   * Find user by username - FIXED: Explicit error handling
   * @param {string} username - Username
   * @returns {Promise<User|null>} Found user or null
   */
  User.findByUsername = async function (username) {
    if (!username) {
      throw new Error('Username is required');
    }
    try {
      return await this.findOne({ 
        where: { 
          username: username.trim() 
        } 
      });
    } catch (error) {
      console.error('Error finding user by username:', error);
      throw error;
    }
  };

  /**
   * Search users by username, name, or email
   * @param {string} query - Search query
   * @param {number} limit - Maximum results (default: 20)
   * @returns {Promise<Array<User>>} Array of matching users
   */
  User.search = async function (query, limit = 20) {
    if (!query || query.length < 2) {
      throw new Error('Search query must be at least 2 characters');
    }
    
    try {
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
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio', 'status'],
      });
    } catch (error) {
      console.error('User search error:', error);
      throw error;
    }
  };

  return User;
};