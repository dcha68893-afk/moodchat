// --- MODEL: Token.js ---
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
          model: 'Users',
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
      tableName: 'tokens',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['userId'],
        },
        {
          fields: ['token'],
          unique: true
        },
        {
          fields: ['tokenType'],
        },
        {
          fields: ['expiresAt'],
        },
        {
          fields: ['isRevoked'],
        },
        {
          fields: ['userId', 'tokenType'],
        },
        {
          fields: ['createdAt'],
        }
      ],
      hooks: {
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
    Token.belongsTo(models.Users, {
      foreignKey: 'userId',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });
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
          model: this.sequelize.models.Users,
          as: 'user',
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
      include: [{
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'email', 'isActive', 'isVerified'],
      }],
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

  // ===== ADDITIONAL METHODS SPECIFIC FOR REFRESH TOKEN FUNCTIONALITY =====

  Token.storeRefreshToken = async function (userId, refreshToken, options = {}) {
    if (!userId || !refreshToken) {
      throw new Error('User ID and refresh token are required');
    }
    
    const { userAgent, ipAddress, deviceInfo } = options;
    
    return await this.create({
      userId,
      token: refreshToken,
      tokenType: 'refresh',
      userAgent,
      ipAddress,
      deviceInfo,
      scope: ['refresh']
    });
  };

  Token.validateRefreshToken = async function (refreshToken) {
    if (!refreshToken) {
      return null;
    }
    
    const token = await this.findOne({
      where: {
        token: refreshToken,
        tokenType: 'refresh',
        isRevoked: false
      },
      include: [{
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'email', 'isActive', 'isVerified'],
      }]
    });
    
    if (!token || token.isExpired() || !token.user || !token.user.isActive) {
      return null;
    }
    
    return token;
  };

  Token.updateRefreshToken = async function (oldRefreshToken, newRefreshToken) {
    if (!oldRefreshToken || !newRefreshToken) {
      throw new Error('Both old and new refresh tokens are required');
    }
    
    const transaction = await this.sequelize.transaction();
    
    try {
      // Revoke old token
      await this.update(
        { isRevoked: true },
        { where: { token: oldRefreshToken }, transaction }
      );
      
      // Get the old token to copy its data
      const oldToken = await this.findOne({
        where: { token: oldRefreshToken },
        transaction
      });
      
      if (!oldToken) {
        throw new Error('Old token not found');
      }
      
      // Create new token with same properties
      const newToken = await this.create({
        userId: oldToken.userId,
        token: newRefreshToken,
        tokenType: 'refresh',
        userAgent: oldToken.userAgent,
        ipAddress: oldToken.ipAddress,
        deviceInfo: oldToken.deviceInfo,
        scope: oldToken.scope
      }, { transaction });
      
      await transaction.commit();
      return newToken;
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  };

  Token.revokeRefreshToken = async function (refreshToken) {
    if (!refreshToken) {
      throw new Error('Refresh token is required');
    }
    
    return await this.update(
      { isRevoked: true },
      { 
        where: { 
          token: refreshToken,
          tokenType: 'refresh'
        } 
      }
    );
  };

  Token.findRefreshTokenByUserId = async function (userId) {
    if (!userId) {
      throw new Error('User ID is required');
    }
    
    return await this.findAll({
      where: {
        userId,
        tokenType: 'refresh',
        isRevoked: false,
        expiresAt: { [this.sequelize.Sequelize.Op.gt]: new Date() }
      },
      order: [['createdAt', 'DESC']]
    });
  };

  return Token;
};