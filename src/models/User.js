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
          notNull: {
            msg: 'Username is required'
          },
          notEmpty: {
            msg: 'Username cannot be empty'
          },
          len: {
            args: [3, 50],
            msg: 'Username must be between 3 and 50 characters'
          },
          is: {
            args: /^[a-zA-Z0-9_]+$/,
            msg: 'Username can only contain letters, numbers, and underscores'
          }
        }
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
          notNull: {
            msg: 'Email is required'
          },
          notEmpty: {
            msg: 'Email cannot be empty'
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
          notNull: {
            msg: 'Password is required'
          },
          notEmpty: {
            msg: 'Password cannot be empty'
          },
          len: {
            args: [6, 100],
            msg: 'Password must be at least 6 characters'
          }
        }
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
        defaultValue: null
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
        validate: {
          isDate: {
            msg: 'Invalid date format'
          },
          isBefore: {
            args: new Date().toISOString().split('T')[0],
            msg: 'Date of birth must be in the past'
          }
        }
      },
      role: {
        type: DataTypes.ENUM('user', 'admin', 'moderator'),
        defaultValue: 'user',
        allowNull: false,
        validate: {
          isIn: {
            args: [['user', 'admin', 'moderator']],
            msg: 'Invalid role'
          }
        }
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
        defaultValue: null
      },
      status: {
        type: DataTypes.ENUM('online', 'offline', 'away', 'busy', 'invisible'),
        defaultValue: 'offline',
        allowNull: false,
        validate: {
          isIn: {
            args: [['online', 'offline', 'away', 'busy', 'invisible']],
            msg: 'Invalid status'
          }
        }
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
        validate: {
          isObject(value) {
            if (typeof value !== 'object' || value === null) {
              throw new Error('Settings must be an object');
            }
          }
        }
      },
    },
    {
      tableName: 'users',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      hooks: {
        // Hash password before creating user
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
        // Hash password before updating if it changed
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
        // Set default avatar if not provided
        beforeCreate: async (user) => {
          if (!user.avatar) {
            user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=random&color=fff`;
          }
        }
      },
    }
  );

  // ===== INSTANCE METHODS =====

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

  User.prototype.toJSON = function () {
    const values = Object.assign({}, this.get());
    
    // Remove sensitive fields
    delete values.password;
    
    return values;
  };

  User.prototype.getPublicProfile = function () {
    const { id, username, firstName, lastName, avatar, bio, status, lastSeen } = this;
    return { 
      id, 
      username, 
      firstName, 
      lastName, 
      avatar, 
      bio, 
      status, 
      lastSeen,
      displayName: `${firstName || ''} ${lastName || ''}`.trim() || username,
      isOnline: status === 'online'
    };
  };

  User.prototype.updateLastSeen = async function () {
    try {
      this.lastSeen = new Date();
      return await this.save();
    } catch (error) {
      console.error('Failed to update last seen:', error);
      throw error;
    }
  };

  User.prototype.updateStatus = async function (status) {
    try {
      this.status = status;
      this.lastSeen = new Date();
      return await this.save();
    } catch (error) {
      console.error('Failed to update status:', error);
      throw error;
    }
  };

  // ===== STATIC METHODS =====

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

  User.findActiveByIdentifier = async function (identifier) {
    if (!identifier) {
      throw new Error('Identifier is required');
    }
    try {
      const Op = this.sequelize.Sequelize.Op;
      return await this.findOne({
        where: {
          [Op.or]: [
            { email: identifier.toLowerCase().trim() },
            { username: identifier.trim() }
          ],
          isActive: true
        }
      });
    } catch (error) {
      console.error('Error finding active user:', error);
      throw error;
    }
  };

  User.search = async function (query, limit = 20) {
    if (!query || query.length < 2) {
      throw new Error('Search query must be at least 2 characters');
    }
    
    try {
      const Op = this.sequelize.Sequelize.Op;
      
      return await this.findAll({
        where: {
          [Op.or]: [
            { username: { [Op.iLike]: `%${query}%` } },
            { firstName: { [Op.iLike]: `%${query}%` } },
            { lastName: { [Op.iLike]: `%${query}%` } },
            { email: { [Op.iLike]: `%${query}%` } },
          ],
          isActive: true
        },
        limit: limit,
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio', 'status', 'lastSeen'],
        order: [['username', 'ASC']]
      });
    } catch (error) {
      console.error('User search error:', error);
      throw error;
    }
  };

  User.getAllActive = async function (limit = 100) {
    try {
      return await this.findAll({
        where: {
          isActive: true
        },
        limit: limit,
        attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'createdAt'],
        order: [['createdAt', 'DESC']]
      });
    } catch (error) {
      console.error('Get all active users error:', error);
      throw error;
    }
  };

  User.bulkUpdateStatus = async function (userIds, status) {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error('User IDs array is required');
    }
    
    if (!['online', 'offline', 'away', 'busy', 'invisible'].includes(status)) {
      throw new Error('Invalid status');
    }
    
    try {
      const [affectedRows] = await this.update(
        { 
          status: status,
          lastSeen: new Date()
        },
        {
          where: {
            id: userIds
          }
        }
      );
      
      return affectedRows;
    } catch (error) {
      console.error('Bulk update status error:', error);
      throw error;
    }
  };

  // ===== ASSOCIATIONS =====
  // Note: All associations are defined in models/index.js to avoid conflicts
  User.associate = function(models) {
    // All associations moved to models/index.js
  };

  return User;
};