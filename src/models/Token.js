const crypto = require('crypto');

module.exports = (sequelize, DataTypes) => {
  const Token = sequelize.define(
    'Token',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        validate: {
          notNull: {
            msg: 'User ID is required'
          },
          isInt: {
            msg: 'User ID must be an integer'
          }
        }
      },
      token: {
        type: DataTypes.STRING(500),
        allowNull: false,
        unique: {
          name: 'token',
          msg: 'Token already exists'
        },
        validate: {
          notEmpty: {
            msg: 'Token cannot be empty'
          },
          len: {
            args: [10, 500],
            msg: 'Token must be between 10 and 500 characters'
          }
        }
      },
      tokenType: {
        type: DataTypes.ENUM('access', 'refresh', 'verification', 'password_reset', 'api'),
        defaultValue: 'access',
        allowNull: false,
        validate: {
          isIn: {
            args: [['access', 'refresh', 'verification', 'password_reset', 'api']],
            msg: 'Invalid token type'
          }
        }
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        validate: {
          isDate: {
            msg: 'Expires at must be a valid date'
          },
          isAfter: {
            args: new Date().toISOString(),
            msg: 'Expires at must be in the future'
          }
        }
      },
      isRevoked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      userAgent: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      ipAddress: {
        type: DataTypes.STRING(45),
        allowNull: true,
        validate: {
          isIP: {
            msg: 'Invalid IP address'
          }
        }
      },
      deviceInfo: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      scope: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
    },
    {
      tableName: 'tokens',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ['user_id'],
        },
        {
          fields: ['token'],
          unique: true
        },
        {
          fields: ['token_type'],
        },
        {
          fields: ['expires_at'],
        },
        {
          fields: ['is_revoked'],
        },
        {
          fields: ['user_id', 'token_type'],
        },
      ],
      hooks: {
        // Auto-set expiration date based on token type if not provided
        beforeValidate: async (token) => {
          if (!token.expiresAt) {
            const expiresIn =
              {
                access: 15 * 60 * 1000, // 15 minutes
                refresh: 7 * 24 * 60 * 60 * 1000, // 7 days
                verification: 24 * 60 * 60 * 1000, // 24 hours
                password_reset: 1 * 60 * 60 * 1000, // 1 hour
                api: 30 * 24 * 60 * 60 * 1000, // 30 days
              }[token.tokenType] || 15 * 60 * 1000;

            token.expiresAt = new Date(Date.now() + expiresIn);
          }
        },
      },
    }
  );

  // ===== ASSOCIATIONS =====
  Token.associate = function(models) {
    Token.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'user',
      onDelete: 'CASCADE'
    });
  };

  // ===== INSTANCE METHODS =====

  /**
   * Check if the token is expired
   * @returns {boolean} True if token is expired
   */
  Token.prototype.isExpired = function () {
    return this.expiresAt < new Date();
  };

  /**
   * Check if the token is valid (not revoked and not expired)
   * @returns {boolean} True if token is valid
   */
  Token.prototype.isValid = function () {
    return !this.isRevoked && !this.isExpired();
  };

  /**
   * Revoke the token
   * @returns {Promise<Token>} Updated token instance
   */
  Token.prototype.revoke = async function () {
    this.isRevoked = true;
    return await this.save();
  };

  /**
   * Extend the token's expiration time
   * @param {number} additionalTimeMs - Additional time in milliseconds
   * @returns {Promise<Token>} Updated token instance
   */
  Token.prototype.extend = async function (additionalTimeMs) {
    this.expiresAt = new Date(this.expiresAt.getTime() + additionalTimeMs);
    return await this.save();
  };

  /**
   * Update device information
   * @param {Object} deviceInfo - Device information object
   * @returns {Promise<Token>} Updated token instance
   */
  Token.prototype.updateDeviceInfo = async function (deviceInfo) {
    this.deviceInfo = { ...this.deviceInfo, ...deviceInfo };
    return await this.save();
  };

  // ===== STATIC METHODS =====

  /**
   * Find token by token string
   * @param {string} tokenString - The token string
   * @param {boolean} includeUser - Whether to include user data
   * @returns {Promise<Token|null>} Found token or null
   */
  Token.findByToken = async function (tokenString, includeUser = false) {
    const options = {
      where: { token: tokenString },
    };

    if (includeUser) {
      options.include = [
        {
          model: this.sequelize.models.User,
          attributes: ['id', 'username', 'email', 'isActive', 'isVerified'],
        },
      ];
    }

    return await this.findOne(options);
  };

  /**
   * Find all valid tokens for a user
   * @param {number} userId - User ID
   * @param {string|null} tokenType - Optional token type filter
   * @returns {Promise<Array<Token>>} Array of valid tokens
   */
  Token.findValidByUserId = async function (userId, tokenType = null) {
    const where = {
      userId,
      isRevoked: false,
      expiresAt: { [this.sequelize.Sequelize.Op.gt]: new Date() },
    };

    if (tokenType) {
      where.tokenType = tokenType;
    }

    return await this.findAll({
      where: where,
      order: [['createdAt', 'DESC']],
    });
  };

  /**
   * Revoke all tokens for a user except optionally one token
   * @param {number} userId - User ID
   * @param {string|null} exceptToken - Token to exclude from revocation
   * @returns {Promise<number>} Number of revoked tokens
   */
  Token.revokeAllUserTokens = async function (userId, exceptToken = null) {
    const where = {
      userId,
      isRevoked: false,
    };

    if (exceptToken) {
      where.token = { [this.sequelize.Sequelize.Op.ne]: exceptToken };
    }

    const [affectedRows] = await this.update({ isRevoked: true }, { where: where });
    return affectedRows;
  };

  /**
   * Clean up expired tokens from database
   * @returns {Promise<number>} Number of deleted tokens
   */
  Token.cleanupExpiredTokens = async function () {
    return await this.destroy({
      where: {
        expiresAt: { [this.sequelize.Sequelize.Op.lt]: new Date() },
      },
    });
  };

  /**
   * Generate a random token string
   * @param {number} length - Length of token in bytes (default: 64)
   * @returns {string} Random token string
   */
  Token.generateRandomToken = function (length = 64) {
    return crypto.randomBytes(length).toString('hex');
  };

  return Token;
};