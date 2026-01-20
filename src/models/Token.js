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
      freezeTableName: true,
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
        {
          fields: ['created_at'],
        }
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
        // Generate token if not provided
        beforeCreate: async (token) => {
          if (!token.token) {
            token.token = crypto.randomBytes(64).toString('hex');
          }
        }
      },
    }
  );

  // ===== ASSOCIATIONS =====
  Token.associate = function(models) {
    // All associations are defined in models/index.js
  };

  // ===== INSTANCE METHODS =====

  Token.prototype.isExpired = function () {
    return this.expiresAt < new Date();
  };

  Token.prototype.isValid = function () {
    return !this.isRevoked && !this.isExpired();
  };

  Token.prototype.revoke = async function () {
    this.isRevoked = true;
    return await this.save();
  };

  Token.prototype.extend = async function (additionalTimeMs) {
    this.expiresAt = new Date(this.expiresAt.getTime() + additionalTimeMs);
    return await this.save();
  };

  Token.prototype.updateDeviceInfo = async function (deviceInfo) {
    this.deviceInfo = { ...this.deviceInfo, ...deviceInfo };
    return await this.save();
  };

  // ===== STATIC METHODS =====

  Token.findByToken = async function (tokenString, includeUser = false) {
    if (!tokenString) {
      throw new Error('Token string is required');
    }
    
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

  Token.findValidByUserId = async function (userId, tokenType = null) {
    if (!userId) {
      throw new Error('User ID is required');
    }
    
    const { Op } = this.sequelize.Sequelize;
    const where = {
      userId,
      isRevoked: false,
      expiresAt: { [Op.gt]: new Date() },
    };

    if (tokenType) {
      where.tokenType = tokenType;
    }

    return await this.findAll({
      where: where,
      order: [['createdAt', 'DESC']],
    });
  };

  Token.revokeAllUserTokens = async function (userId, exceptToken = null) {
    if (!userId) {
      throw new Error('User ID is required');
    }
    
    const { Op } = this.sequelize.Sequelize;
    const where = {
      userId,
      isRevoked: false,
    };

    if (exceptToken) {
      where.token = { [Op.ne]: exceptToken };
    }

    const [affectedRows] = await this.update({ isRevoked: true }, { where: where });
    return affectedRows;
  };

  Token.revokeToken = async function (tokenString) {
    if (!tokenString) {
      throw new Error('Token string is required');
    }
    
    const [affectedRows] = await this.update(
      { isRevoked: true },
      { where: { token: tokenString } }
    );
    return affectedRows;
  };

  Token.cleanupExpiredTokens = async function () {
    const { Op } = this.sequelize.Sequelize;
    return await this.destroy({
      where: {
        expiresAt: { [Op.lt]: new Date() },
      },
    });
  };

  Token.generateRandomToken = function (length = 64) {
    return crypto.randomBytes(length).toString('hex');
  };

  Token.createTokenPair = async function (userId, options = {}) {
    if (!userId) {
      throw new Error('User ID is required');
    }
    
    const { userAgent, ipAddress, deviceInfo } = options;
    
    // Create refresh token
    const refreshToken = await this.create({
      userId,
      tokenType: 'refresh',
      userAgent,
      ipAddress,
      deviceInfo,
      scope: ['refresh']
    });
    
    // Create access token
    const accessToken = await this.create({
      userId,
      tokenType: 'access',
      userAgent,
      ipAddress,
      deviceInfo,
      scope: ['read', 'write']
    });
    
    return {
      accessToken,
      refreshToken
    };
  };

  Token.verify = async function (tokenString) {
    if (!tokenString) {
      return null;
    }
    
    const token = await this.findByToken(tokenString, true);
    
    if (!token || !token.isValid() || !token.user || !token.user.isActive) {
      return null;
    }
    
    return token;
  };

  return Token;
};