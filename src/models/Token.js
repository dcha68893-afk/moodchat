const { DataTypes } = require('sequelize');
const sequelize = require('./index');

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
      beforeCreate: async token => {
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

// Instance methods
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

// Static methods
Token.findByToken = async function (tokenString, includeUser = false) {
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

Token.findValidByUserId = async function (userId, tokenType = null) {
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

Token.revokeAllUserTokens = async function (userId, exceptToken = null) {
  const where = {
    userId,
    isRevoked: false,
  };

  if (exceptToken) {
    where.token = { [sequelize.Sequelize.Op.ne]: exceptToken };
  }

  return await this.update({ isRevoked: true }, { where: where });
};

Token.cleanupExpiredTokens = async function () {
  return await this.destroy({
    where: {
      expiresAt: { [sequelize.Sequelize.Op.lt]: new Date() },
    },
  });
};

Token.generateRandomToken = function (length = 64) {
  return require('crypto').randomBytes(length).toString('hex');
};

module.exports = Token;
