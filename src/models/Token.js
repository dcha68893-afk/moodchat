const Token = (sequelize, DataTypes) => {
  const TokenModel = sequelize.define(
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
      },
      token: {
        type: DataTypes.STRING(500),
        allowNull: false,
        unique: true,
      },
      tokenType: {
        type: DataTypes.ENUM('access', 'refresh', 'verification', 'password_reset', 'api'),
        defaultValue: 'access',
        allowNull: false,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
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
      ],
      hooks: {
        // Auto-set expiration date based on token type if not provided
        beforeCreate: async (token) => {
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

  // ===== INSTANCE METHODS =====

  /**
   * Check if the token is expired
   * @returns {boolean} True if token is expired
   */
  TokenModel.prototype.isExpired = function () {
    return this.expiresAt < new Date();
  };

  /**
   * Check if the token is valid (not revoked and not expired)
   * @returns {boolean} True if token is valid
   */
  TokenModel.prototype.isValid = function () {
    return !this.isRevoked && !this.isExpired();
  };

  /**
   * Revoke the token
   * @returns {Promise<Token>} Updated token instance
   */
  TokenModel.prototype.revoke = async function () {
    this.isRevoked = true;
    return await this.save();
  };

  /**
   * Extend the token's expiration time
   * @param {number} additionalTimeMs - Additional time in milliseconds
   * @returns {Promise<Token>} Updated token instance
   */
  TokenModel.prototype.extend = async function (additionalTimeMs) {
    this.expiresAt = new Date(this.expiresAt.getTime() + additionalTimeMs);
    return await this.save();
  };

  /**
   * Update device information
   * @param {Object} deviceInfo - Device information object
   * @returns {Promise<Token>} Updated token instance
   */
  TokenModel.prototype.updateDeviceInfo = async function (deviceInfo) {
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
  TokenModel.findByToken = async function (tokenString, includeUser = false) {
    const options = {
      where: { token: tokenString },
    };

    if (includeUser) {
      options.include = [
        {
          model: sequelize.models.User,
          attributes: ['id', 'username', 'email', 'isActive'],
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
  TokenModel.findValidByUserId = async function (userId, tokenType = null) {
    const where = {
      userId,
      isRevoked: false,
      expiresAt: { [sequelize.Sequelize.Op.gt]: new Date() },
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
  TokenModel.revokeAllUserTokens = async function (userId, exceptToken = null) {
    const where = {
      userId,
      isRevoked: false,
    };

    if (exceptToken) {
      where.token = { [sequelize.Sequelize.Op.ne]: exceptToken };
    }

    return await this.update({ isRevoked: true }, { where: where });
  };

  /**
   * Clean up expired tokens from database
   * @returns {Promise<number>} Number of deleted tokens
   */
  TokenModel.cleanupExpiredTokens = async function () {
    return await this.destroy({
      where: {
        expiresAt: { [sequelize.Sequelize.Op.lt]: new Date() },
      },
    });
  };

  /**
   * Generate a random token string
   * @param {number} length - Length of token in bytes (default: 64)
   * @returns {string} Random token string
   */
  TokenModel.generateRandomToken = function (length = 64) {
    return require('crypto').randomBytes(length).toString('hex');
  };

  return TokenModel;
};

module.exports = Token;