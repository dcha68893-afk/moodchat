// services/tokenService.js
const jwt = require('jsonwebtoken');
const db = require('../models');

class TokenService {
  constructor() {
    this.accessSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
    this.refreshSecret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

    if (!this.accessSecret) {
      throw new Error('JWT_SECRET or JWT_ACCESS_SECRET must be set');
    }

    this.accessExpiry = process.env.JWT_ACCESS_EXPIRES_IN || '24h';
    this.refreshExpiry = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

    console.log('[TokenService] Initialized');
  }

  getTokenModel() {
    // Always re-require db to get the post-sync, fully hydrated module.
    // Using a cached top-level `db` reference can miss the Token model when
    // tokenService is first loaded before sequelize.sync() completes.
    try {
      const freshDb = require('../models');
      return (
        freshDb.Token ||
        freshDb.models?.Token ||
        freshDb.getModel?.('Token') ||
        null
      );
    } catch (_) {
      return db?.Token || db?.models?.Token || null;
    }
  }

  generateAccessToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) {
      throw new Error('Cannot generate token: Missing user ID');
    }

    const payload = {
      userId,
      id: userId,
      email: user.email || null,
      username: user.username || null,
      role: user.role || 'user',
      type: 'access'
    };

    return jwt.sign(payload, this.accessSecret, { expiresIn: this.accessExpiry });
  }

  generateRefreshToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) {
      throw new Error('Cannot generate refresh token: Missing user ID');
    }

    return jwt.sign(
      {
        userId,
        id: userId,
        type: 'refresh'
      },
      this.refreshSecret,
      { expiresIn: this.refreshExpiry }
    );
  }

  verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, this.accessSecret);
      if (decoded.type && decoded.type !== 'access') {
        return {
          valid: false,
          error: 'INVALID_TOKEN_TYPE',
          message: 'Token type must be "access"'
        };
      }
      return { valid: true, decoded };
    } catch (error) {
      return {
        valid: false,
        error: error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: error.message
      };
    }
  }

  verifyRefreshToken(token) {
    try {
      const decoded = jwt.verify(token, this.refreshSecret);
      if (decoded.type && decoded.type !== 'refresh') {
        return {
          valid: false,
          error: 'INVALID_TOKEN_TYPE',
          message: 'Token type must be "refresh"'
        };
      }
      return { valid: true, decoded };
    } catch (error) {
      return {
        valid: false,
        error: error.name === 'TokenExpiredError' ? 'REFRESH_TOKEN_EXPIRED' : 'INVALID_REFRESH_TOKEN',
        message: error.message
      };
    }
  }

  extractTokenFromRequest(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[1].trim()) {
        return parts[1].trim();
      }
    }

    const xAccessToken = req.headers['x-access-token'];
    if (xAccessToken && xAccessToken.trim()) {
      return xAccessToken.trim();
    }

    if (req.cookies && req.cookies.accessToken) {
      return req.cookies.accessToken;
    }

    return null;
  }

  extractRefreshTokenFromRequest(req) {
    if (req.body && req.body.refreshToken) {
      return req.body.refreshToken;
    }

    if (req.cookies && req.cookies.refreshToken) {
      return req.cookies.refreshToken;
    }

    const refreshHeader = req.headers['x-refresh-token'];
    if (refreshHeader && refreshHeader.trim()) {
      return refreshHeader.trim();
    }

    return null;
  }

  // Legacy in-memory fallback store.
  static refreshTokenStore = new Map();

  async storeRefreshToken(token, userId, expiresIn = 7 * 24 * 60 * 60 * 1000, metadata = {}) {
    const TokenModel = this.getTokenModel();
    if (TokenModel) {
      try {
        const expiresAt = new Date(Date.now() + expiresIn);
        await TokenModel.create({
          userId,
          token,
          tokenType: 'refresh',
          expiresAt,
          isRevoked: false,
          userAgent: metadata.userAgent || null,
          ipAddress: metadata.ipAddress || null,
          deviceInfo: metadata.deviceInfo || null,
          scope: ['refresh']
        });
        return { valid: true, source: 'db', userId };
      } catch (error) {
        console.warn('[TokenService] Failed DB store, using memory fallback:', error.message);
      }
    }

    if (process.env.NODE_ENV === 'production') {
        // SECURITY FIX #9: Hard-fail in production rather than silently falling back to memory.
        // In-memory tokens are lost on every deploy/restart, forcing all users to re-login.
        // If we reach here, the DB Token model is unavailable — that is a fatal configuration error.
        throw new Error('[TokenService] Token model unavailable in production — cannot store refresh token. Check DB connection.');
      }
      // Development-only in-memory fallback below
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[TokenService] In-memory refresh token store active (dev only)');
      }

    TokenService.refreshTokenStore.set(token, {
      userId,
      expiresAt: Date.now() + expiresIn,
      createdAt: new Date().toISOString()
    });
    return { valid: true, source: 'memory', userId };
  }

  async validateStoredRefreshToken(token) {
    const TokenModel = this.getTokenModel();
    if (TokenModel) {
      try {
        const tokenRow = await TokenModel.findOne({
          where: {
            token,
            tokenType: 'refresh',
            isRevoked: false
          }
        });

        if (!tokenRow) {
          return { valid: false, error: 'TOKEN_NOT_FOUND' };
        }

        if (new Date(tokenRow.expiresAt).getTime() < Date.now()) {
          await tokenRow.update({ isRevoked: true }).catch(() => {});
          return { valid: false, error: 'TOKEN_EXPIRED' };
        }

        return { valid: true, userId: tokenRow.userId, source: 'db' };
      } catch (error) {
        console.warn('[TokenService] Failed DB validation, using memory fallback:', error.message);
      }
    }

    const stored = TokenService.refreshTokenStore.get(token);
    if (!stored) {
      return { valid: false, error: 'TOKEN_NOT_FOUND' };
    }

    if (stored.expiresAt < Date.now()) {
      TokenService.refreshTokenStore.delete(token);
      return { valid: false, error: 'TOKEN_EXPIRED' };
    }

    return { valid: true, userId: stored.userId, source: 'memory' };
  }

  async invalidateRefreshToken(token) {
    const TokenModel = this.getTokenModel();
    if (TokenModel) {
      try {
        const [affectedRows] = await TokenModel.update(
          { isRevoked: true },
          { where: { token, tokenType: 'refresh', isRevoked: false } }
        );
        if (affectedRows > 0) {
          return { valid: true, source: 'db', affectedRows };
        }
      } catch (error) {
        console.warn('[TokenService] Failed DB revoke, using memory fallback:', error.message);
      }
    }

    TokenService.refreshTokenStore.delete(token);
    return { valid: true, source: 'memory', affectedRows: 1 };
  }

  async listUserRefreshSessions(userId) {
    const TokenModel = this.getTokenModel();
    if (!TokenModel) return [];

    try {
      const rows = await TokenModel.findAll({
        where: {
          userId,
          tokenType: 'refresh',
          isRevoked: false
        },
        order: [['createdAt', 'DESC']]
      });

      return rows
        .filter((row) => new Date(row.expiresAt).getTime() > Date.now())
        .map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          userAgent: row.userAgent || 'Unknown',
          ipAddress: row.ipAddress || 'Unknown',
          deviceInfo: row.deviceInfo || null,
          tokenType: row.tokenType
        }));
    } catch (error) {
      console.warn('[TokenService] Failed to list refresh sessions:', error.message);
      return [];
    }
  }
}
console.log("🔍 DB keys:", Object.keys(db));
console.log("🔍 Sequelize models:", db?.sequelize?.models);

module.exports = new TokenService();