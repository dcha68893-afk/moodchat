// --- MODEL: Users.js ---
// SINGLE SOURCE OF TRUTH FOR USER MODEL
const bcrypt = require('bcryptjs');
// P1 FIX (Forensic Audit): consistent SHA-256 pre-hash + bcrypt compare
const { comparePassword } = require('../utils/passwordUtils');

module.exports = (sequelize, DataTypes) => {
  const Users = sequelize.define(
    'Users',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
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
      password: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          notNull: {
            msg: 'Password is required'
          },
          notEmpty: {
            msg: 'Password cannot be empty'
          }
        }
      },
      avatar: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'https://ui-avatars.com/api/?name=User&background=random&color=fff'
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
      // AUTH-X FIX: resetToken / resetTokenExpiry were missing from model definition
      // but used in forgot-password and verify-email routes. Without these columns
      // Sequelize silently ignores user.update({ resetToken: ... }) calls,
      // breaking password reset and email verification flows.
      resetToken: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      resetTokenExpiry: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
      },
      // P2 FIX (Forensic Audit): Two-Factor Authentication (TOTP) support
      mfaSecret: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      mfaEnabled: {
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
      // P1 FIX: FCM push notification token
      fcmToken: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Firebase Cloud Messaging token for push notifications',
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
      theme: {
        type: DataTypes.STRING(20),
        defaultValue: 'light',
        allowNull: false,
      },
      language: {
        type: DataTypes.STRING(10),
        defaultValue: 'en',
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
        validate: {
          isObject(value) {
            if (typeof value !== 'object' || value === null) {
              throw new Error('Settings must be an object');
            }
          }
        }
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false
      }
    },
    {
      tableName: 'Users',
      modelName: 'Users',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      hooks: {
        beforeCreate: async (user) => {
          // CRITICAL: ONLY hash if password is NOT already hashed
          if (user.password && user.password.length > 0 && !user.password.startsWith('$2b$')) {
            try {
              console.log('🔧 [MODEL] Hashing password in beforeCreate');
              user.password = await bcrypt.hash(user.password, 10);
            } catch (error) {
              throw new Error(`Password hashing failed: ${error.message}`);
            }
          } else if (user.password && user.password.startsWith('$2b$')) {
            console.log('⚠️ [MODEL] Password already hashed - skipping');
          } else {
            throw new Error('Password is required');
          }
          
          // Generate avatar if not provided
          if (!user.avatar || user.avatar === 'https://ui-avatars.com/api/?name=User&background=random&color=fff') {
            user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=random&color=fff`;
          }
        },
        beforeUpdate: async (user) => {
          // Only hash if password changed and not already hashed
          if (user.changed('password')) {
            if (user.password && user.password.length > 0 && !user.password.startsWith('$2b$')) {
              try {
                console.log('🔧 [MODEL] Hashing password in beforeUpdate');
                user.password = await bcrypt.hash(user.password, 10);
              } catch (error) {
                throw new Error(`Password hashing failed: ${error.message}`);
              }
            } else if (user.password && user.password.startsWith('$2b$')) {
              console.log('⚠️ [MODEL] Password already hashed - skipping beforeUpdate hash');
            } else {
              throw new Error('Password cannot be empty');
            }
          }
        }
      },
    }
  );

  Users.prototype.validatePassword = async function (password) {
    if (!password || !this.password) {
      console.log('[MODEL] validatePassword: Missing password or hash');
      return false;
    }
    
    try {
      console.log(`[MODEL] Validating password for user ${this.id}`);
      const isValid = await comparePassword(password, this.password);
      console.log(`[MODEL] Password validation result: ${isValid ? '✅ VALID' : '❌ INVALID'}`);
      return isValid;
    } catch (error) {
      console.error('[MODEL] Password validation error:', error.message);
      return false;
    }
  };

  Users.prototype.toJSON = function () {
    const values = Object.assign({}, this.get());
    delete values.password;
    delete values.resetToken;
    delete values.resetTokenExpiry;
    delete values.mfaSecret;
    return values;
  };

  Users.prototype.getPublicProfile = function () {
    const { id, username, firstName, lastName, avatar, bio, status, lastSeen, theme, language } = this;
    return { 
      id, 
      username, 
      firstName, 
      lastName, 
      avatar, 
      bio, 
      status, 
      lastSeen,
      theme,
      language,
      displayName: `${firstName || ''} ${lastName || ''}`.trim() || username,
      isOnline: status === 'online'
    };
  };

  Users.prototype.updateLastSeen = async function () {
    try {
      this.lastSeen = new Date();
      return await this.save();
    } catch (error) {
      console.error('Failed to update last seen:', error);
      throw error;
    }
  };

  Users.prototype.updateStatus = async function (status) {
    try {
      this.status = status;
      this.lastSeen = new Date();
      return await this.save();
    } catch (error) {
      console.error('Failed to update status:', error);
      throw error;
    }
  };

  // Static methods
  Users.findByEmail = async function (email) {
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

  Users.findByUsername = async function (username) {
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

  Users.findActiveByIdentifier = async function (identifier) {
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

  Users.search = async function (query, limit = 20) {
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

  Users.getAllActive = async function (limit = 100) {
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

  Users.bulkUpdateStatus = async function (userIds, status) {
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

  // Associations
  Users.associate = function(models) {
    // CRITICAL: Prevent duplicate associations (alias conflict fix)
    if (this.associations && Object.keys(this.associations).length > 0) {
        // Skip if associations already defined to prevent alias conflicts
        return;
    }
        
    if (models.Friend) {
      Users.belongsToMany(Users, {
        through: models.Friend,
        as: 'friends',
        foreignKey: 'requesterId',
        otherKey: 'receiverId',
        constraints: false
      });
      
      Users.belongsToMany(Users, {
        through: models.Friend,
        as: 'friendRequests',
        foreignKey: 'receiverId',
        otherKey: 'requesterId',
        constraints: false
      });
    }
  };

  return Users;
};