// --- MODEL: Token.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Token = sequelize.define('Token', {
    // Tokens were originally created with an INTEGER primary key and existing
    // production rows use that contract. Keep the model compatible with them.
    id: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    token: { type: DataTypes.TEXT, allowNull: false },
    tokenType: { type: DataTypes.STRING, defaultValue: 'refresh', allowNull: false, field: 'token_type' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    isRevoked: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false, field: 'is_revoked' },
    userAgent: { type: DataTypes.STRING, allowNull: true, field: 'user_agent' },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true, field: 'ip_address' },
    deviceInfo: { type: DataTypes.STRING, allowNull: true, field: 'device_info' },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'updated_at' },
  }, {
    tableName: 'Tokens', modelName: 'Token', timestamps: true, underscored: true, freezeTableName: true,
    indexes: [
      { fields: ['user_id'], name: 'tokens_user_id_idx' },
      { fields: ['token'], name: 'tokens_token_idx' },
      { fields: ['expires_at'], name: 'tokens_expires_at_idx' },
      { fields: ['user_id', 'is_revoked'], name: 'tokens_user_revoked_idx' },
    ],
  });

  Token.prototype.isExpired = function () { return new Date() > this.expiresAt; };
  Token.prototype.isValid = function () { return !this.isRevoked && !this.isExpired(); };
  Token.prototype.revoke = async function () { this.isRevoked = true; return this.save(); };
  Token.prototype.extendExpiry = async function (seconds) {
    this.expiresAt = new Date(this.expiresAt.getTime() + seconds * 1000);
    return this.save();
  };

  Token.createToken = data => Token.create({
    userId: data.userId, token: data.token, tokenType: data.tokenType || 'refresh', expiresAt: data.expiresAt,
    userAgent: data.userAgent, ipAddress: data.ipAddress, deviceInfo: data.deviceInfo,
  });

  Token.findValidToken = tokenString => Token.findOne({ where: {
    token: tokenString, isRevoked: false, expiresAt: { [Op.gt]: new Date() },
  }});

  Token.getUserValidTokens = userId => Token.findAll({
    where: { userId, isRevoked: false, expiresAt: { [Op.gt]: new Date() } }, order: [['createdAt', 'DESC']],
  });

  Token.revokeAllUserTokens = async (userId, exceptTokenId = null) => {
    const where = { userId, isRevoked: false };
    if (exceptTokenId) where.id = { [Op.ne]: exceptTokenId };
    const [updatedCount] = await Token.update({ isRevoked: true }, { where });
    return updatedCount;
  };

  Token.cleanupExpiredTokens = () => Token.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });

  Token.getUserTokenStats = async userId => ({
    total: await Token.count({ where: { userId }}),
    active: await Token.count({ where: { userId, isRevoked: false, expiresAt: { [Op.gt]: new Date() } }}),
    revoked: await Token.count({ where: { userId, isRevoked: true }}),
    expired: await Token.count({ where: { userId, expiresAt: { [Op.lt]: new Date() } } }),
  });

  let associationsSetUp = false;
  Token.associate = models => {
    if (associationsSetUp) return;
    associationsSetUp = true;
    const UserModel = models.Users || models.User;
    if (UserModel) Token.belongsTo(UserModel, { foreignKey: 'userId', as: 'user', constraints: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' });
  };

  // Production schema changes are handled by versioned migrations.
  return Token;
};
