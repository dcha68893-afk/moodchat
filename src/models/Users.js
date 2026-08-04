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
      coverPhoto: {
        type: DataTypes.TEXT,
        allowNull: true,
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
      // FIX (DISPLAYNAME-NOT-A-COLUMN): ~25 query sites across this codebase
      // (marketplace, calls, games, moods, status, groups...) already write
      // `attributes: [..., 'displayName', ...]` as if this were a real
      // column. It never was — the only place it existed was computed
      // inline inside toSafeJSON() below. Every one of those queries threw
      // a Postgres "column does not exist" error at request time, which is
      // why marketplace product listings, wishlist, reviews, and the
      // follow-seller list all rendered as an empty screen (the frontend
      // got a 500, not an empty result). Declaring it as a real Sequelize
      // VIRTUAL attribute makes all of those `attributes` arrays valid:
      // Sequelize computes it in JS instead of trying to SELECT it. Note
      // this only resolves to "First Last" when the query's attributes list
      // also includes firstName/lastName — otherwise it falls back to
      // username, same fallback toSafeJSON() already used.
      displayName: {
        type: DataTypes.VIRTUAL,
        get() {
          const first = this.getDataValue('firstName');
          const last  = this.getDataValue('lastName');
          const full  = `${first || ''} ${last || ''}`.trim();
          return full || this.getDataValue('username') || '';
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
      // GOOGLE OAUTH FIX: stores the Google account's stable "sub" claim so a
      // returning Google login can be matched to the same local user even if
      // they change their Google display name/photo. models/index.js
      // auto-adds any column present on a model but missing in the DB at
      // startup, so defining it here is enough to self-heal it (no separate
      // migration required, consistent with mfaBackupCodes/registrationPin above).
      googleId: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: {
          name: 'googleId',
          msg: 'This Google account is already linked to another user'
        },
      },
      authProvider: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'local',
      },
      // E2E-WRAP-SECRET FIX (Phase 5 forensic audit): root cause of "Manual
      // login fails encryption, Google login works" — js/e2e-encryption.js
      // derives the key that wraps/unwraps the user's local E2E private key
      // from a password stashed in sessionStorage at login. Manual login has
      // a real typed password to stash; Google login never had one (the
      // backend generates a random, never-returned password for Google-only
      // accounts, per loginWithGoogle() below) — so KynectaE2E.init() was
      // never called at all for Google users, and encryptForChat() silently
      // fell back to returning PLAINTEXT (see its `if (!_enabled) return
      // plaintext` guard). That's why Google "worked": it was never actually
      // encrypting. Manual users hit real encryption and could hit a real
      // decrypt failure. This column is a stable, random, backend-issued
      // secret independent of the account password, generated lazily on
      // first login by authService's _ensureE2EWrapSecret() and returned
      // ONLY from register()/login()/loginWithGoogle() (see toJSON() below,
      // which strips it from every other response) so both login paths can
      // derive the exact same kind of local wrap key.
      e2eWrapSecret: {
        type: DataTypes.STRING(64),
        allowNull: true,
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
      // FIX (2FA audit): routes/settings.js's /2fa/setup and /2fa/disable
      // handlers read/write a "mfaBackupCodes" column, but it was never
      // defined on this model (and had no migration), so Sequelize silently
      // dropped it on every user.update() — backup codes were generated and
      // shown to the user once, then lost forever, making backup-code login
      // recovery impossible. models/index.js auto-adds any column present
      // on a model but missing in the DB at startup, so defining it here is
      // enough to self-heal it (see also ensureSchema.js).
      mfaBackupCodes: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: null,
      },
      // FIX-500 (registration-pin routes): routes/settings.js's
      // /registration-pin/status, POST, and DELETE handlers all read/write a
      // "registrationPin" column via raw SQL, but this column was never
      // added to the model (and there's no migration for it either) — so
      // every call 500'd with "column registrationPin does not exist".
      // models/index.js auto-adds any column present on a model but missing
      // in the DB at startup, so defining it here is enough to self-heal it.
      registrationPin: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null,
      },
      // P2 FIX (Forensic Audit): GDPR right to erasure — set when a user
      // requests account deletion; permanent purge runs 30 days later.
      deletionRequestedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // P3 FIX (Forensic Audit): "Privacy policy acceptance on registration"
      acceptedPrivacyPolicyAt: {
        type: DataTypes.DATE,
        allowNull: true,
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
      // FIX-500 (/api/marketplace/loyalty): this column never existed anywhere
      // (not on this model, not in ensureSchema.js) even though
      // marketplace.controller.js's getLoyalty()/redeemLoyalty() has always
      // queried Users.findByPk(userId, { attributes: ['id','loyaltyPoints',...] }).
      // Postgres threw "column Users.loyaltyPoints does not exist" -> 500 on
      // every loyalty-points request. See ensureSchema.js for the matching
      // ALTER TABLE ... ADD COLUMN IF NOT EXISTS healer.
      loyaltyPoints: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
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
    // E2E-WRAP-SECRET FIX: never leak this through the generic serializer —
    // it must only ever reach the account's own client, and only via the
    // explicit re-attachment authService.js does right after register()/
    // login()/loginWithGoogle() call toJSON(). Every other place a user
    // object gets serialized (friend lists, group members, search, etc.)
    // must not include it.
    delete values.e2eWrapSecret;
    return values;
  };

  Users.prototype.getPublicProfile = function () {
    // FIX (IDENTITY-CENTRALIZATION): isVerified was tracked on the model
    // (see `isVerified` column above) but never surfaced through the one
    // helper every module is supposed to call to render a user's identity,
    // so verification badges could never appear consistently anywhere.
    const { id, username, firstName, lastName, avatar, coverPhoto, bio, status, lastSeen, theme, language, isVerified } = this;
    return {
      id,
      username,
      firstName,
      lastName,
      avatar,
      coverPhoto,
      bio,
      status,
      lastSeen,
      theme,
      language,
      isVerified: !!isVerified,
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