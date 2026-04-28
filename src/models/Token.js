// --- MODEL: Token.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Token = sequelize.define(
    'Token',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
      },
      userId: {
        type: DataTypes.INTEGER, // matches Users table primary key type
        allowNull: false,
        field: 'user_id',
      },
      token: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      tokenType: {
        type: DataTypes.STRING,
        defaultValue: 'refresh',
        allowNull: false,
        field: 'token_type',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      isRevoked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
        field: 'is_revoked',
      },
      userAgent: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'user_agent',
      },
      ipAddress: {
        type: DataTypes.STRING(45), // IPv6 max length
        allowNull: true,
        field: 'ip_address',
      },
      deviceInfo: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'device_info',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updated_at',
      },
    },
    {
      tableName: 'Tokens',
      modelName: 'Token',
      timestamps: true,
      underscored: true, // Use snake_case for DB columns
      freezeTableName: true,
      indexes: [
        { fields: ['user_id'], name: 'tokens_user_id_idx' },
        { fields: ['token'], name: 'tokens_token_idx' },
        { fields: ['expires_at'], name: 'tokens_expires_at_idx' },
        { fields: ['user_id', 'is_revoked'], name: 'tokens_user_revoked_idx' },
      ],
    }
  );

  // ── INSTANCE METHODS ──────────────────────────────────────────────────────
  
  /**
   * Check if token is expired
   */
  Token.prototype.isExpired = function () {
    return new Date() > this.expiresAt;
  };

  /**
   * Check if token is valid (not revoked and not expired)
   */
  Token.prototype.isValid = function () {
    return !this.isRevoked && !this.isExpired();
  };

  /**
   * Revoke the token
   */
  Token.prototype.revoke = async function () {
    this.isRevoked = true;
    return await this.save();
  };

  /**
   * Extend token expiration
   * @param {number} seconds - Seconds to extend
   */
  Token.prototype.extendExpiry = async function (seconds) {
    const newExpiry = new Date(this.expiresAt.getTime() + (seconds * 1000));
    this.expiresAt = newExpiry;
    return await this.save();
  };

  // ── STATIC METHODS ────────────────────────────────────────────────────────

  /**
   * Create a new token
   * @param {Object} data - Token data
   * @returns {Promise<Token>}
   */
  Token.createToken = async function (data) {
    return await this.create({
      userId: data.userId,
      token: data.token,
      tokenType: data.tokenType || 'refresh',
      expiresAt: data.expiresAt,
      userAgent: data.userAgent,
      ipAddress: data.ipAddress,
      deviceInfo: data.deviceInfo,
    });
  };

  /**
   * Find valid token by token string
   * @param {string} tokenString - The token to look up
   * @returns {Promise<Token|null>}
   */
  Token.findValidToken = async function (tokenString) {
    return await this.findOne({
      where: {
        token: tokenString,
        isRevoked: false,
        expiresAt: { [Op.gt]: new Date() },
      },
    });
  };

  /**
   * Get all valid tokens for a user
   * @param {string|number} userId - User ID
   * @returns {Promise<Array<Token>>}
   */
  Token.getUserValidTokens = async function (userId) {
    return await this.findAll({
      where: {
        userId: userId,
        isRevoked: false,
        expiresAt: { [Op.gt]: new Date() },
      },
      order: [['createdAt', 'DESC']],
    });
  };

  /**
   * Revoke all tokens for a user
   * @param {string|number} userId - User ID
   * @param {string|null} exceptTokenId - Token ID to exclude from revocation
   * @returns {Promise<number>} - Number of revoked tokens
   */
  Token.revokeAllUserTokens = async function (userId, exceptTokenId = null) {
    const where = {
      userId: userId,
      isRevoked: false,
    };
    
    if (exceptTokenId) {
      where.id = { [Op.ne]: exceptTokenId };
    }
    
    const [updatedCount] = await this.update(
      { isRevoked: true },
      { where: where }
    );
    
    return updatedCount;
  };

  /**
   * Clean up expired tokens (can be called periodically)
   * @returns {Promise<number>} - Number of deleted tokens
   */
  Token.cleanupExpiredTokens = async function () {
    const deleted = await this.destroy({
      where: {
        expiresAt: { [Op.lt]: new Date() },
      },
    });
    return deleted;
  };

  /**
   * Get token statistics for a user
   * @param {string|number} userId - User ID
   * @returns {Promise<Object>}
   */
  Token.getUserTokenStats = async function (userId) {
    const total = await this.count({ where: { userId: userId } });
    const active = await this.count({
      where: {
        userId: userId,
        isRevoked: false,
        expiresAt: { [Op.gt]: new Date() },
      },
    });
    const revoked = await this.count({
      where: {
        userId: userId,
        isRevoked: true,
      },
    });
    const expired = await this.count({
      where: {
        userId: userId,
        expiresAt: { [Op.lt]: new Date() },
      },
    });
    
    return { total, active, revoked, expired };
  };

  // ── ASSOCIATIONS ──────────────────────────────────────────────────────────
  
  let _associationsSetUp = false;
  Token.associate = function (models) {
    if (_associationsSetUp) return;
    _associationsSetUp = true;

    if (models.Users || models.User) {
      const UserModel = models.Users || models.User;
      Token.belongsTo(UserModel, {
        foreignKey: 'userId',
        as: 'user',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  // ── AUTO-MIGRATION: Ensure all columns exist ──────────────────────────────
  
  if (!sequelize._tokenColumnsMigrated) {
    sequelize._tokenColumnsMigrated = true;
    setImmediate(async () => {
      try {
        const qi = sequelize.getQueryInterface();
        const tableDesc = await qi.describeTable('Tokens').catch(() => null);
        if (!tableDesc) return; // table doesn't exist yet — sync will create it

        const colsToAdd = [
          { name: 'user_id', sql: 'INTEGER NOT NULL' },
          { name: 'token', sql: 'TEXT NOT NULL' },
          { name: 'token_type', sql: "VARCHAR(255) NOT NULL DEFAULT 'refresh'" },
          { name: 'expires_at', sql: 'TIMESTAMP WITH TIME ZONE NOT NULL' },
          { name: 'is_revoked', sql: "BOOLEAN NOT NULL DEFAULT FALSE" },
          { name: 'user_agent', sql: 'VARCHAR(255)' },
          { name: 'ip_address', sql: 'VARCHAR(45)' },
          { name: 'device_info', sql: 'VARCHAR(255)' },
        ];

        for (const col of colsToAdd) {
          const present = tableDesc[col.name] || tableDesc[col.name.toLowerCase()];
          
          if (!present) {
            try {
              await sequelize.query(
                `ALTER TABLE "Tokens" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.sql};`
              );
              console.log(`[Token model] ✅ Added missing column: ${col.name}`);
            } catch (colErr) {
              console.warn(`[Token model] Could not add column ${col.name} (non-fatal):`, colErr.message);
            }
          }
        }

        // Create indexes if they don't exist
        try {
          await sequelize.query(`CREATE INDEX IF NOT EXISTS "tokens_user_id_idx" ON "Tokens" ("user_id");`);
          await sequelize.query(`CREATE INDEX IF NOT EXISTS "tokens_token_idx" ON "Tokens" ("token");`);
          await sequelize.query(`CREATE INDEX IF NOT EXISTS "tokens_expires_at_idx" ON "Tokens" ("expires_at");`);
          await sequelize.query(`CREATE INDEX IF NOT EXISTS "tokens_user_revoked_idx" ON "Tokens" ("user_id", "is_revoked");`);
          console.log(`[Token model] ✅ Indexes verified`);
        } catch (idxErr) {
          console.warn(`[Token model] Could not create indexes (non-fatal):`, idxErr.message);
        }

      } catch (err) {
        console.error('[Token model] Auto-migration error (non-fatal):', err.message);
      }
    });
  }

  return Token;
};