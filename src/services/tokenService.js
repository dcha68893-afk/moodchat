// services/tokenService.js
// VERSION: 2.1.0 - Per-user security session timeout + production-safe token storage
const jwt = require('jsonwebtoken');

class TokenService {
  constructor() {
    let _cfg = {};
    try { _cfg = require('../config').jwt || {}; } catch (_) {}
    this.accessSecret  = _cfg.accessSecret  || process.env.JWT_ACCESS_SECRET  || process.env.JWT_SECRET;
    this.refreshSecret = _cfg.refreshSecret || process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

    if (!this.accessSecret) throw new Error('JWT_SECRET or JWT_ACCESS_SECRET must be set');

    this.accessExpiry  = process.env.JWT_ACCESS_EXPIRES_IN  || '24h';
    this.refreshExpiry = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
    this.defaultSessionTimeout = '8h';

    console.log('[TokenService] Initialized');
  }

  getTokenModel() {
    try {
      const freshDb = require('../models');
      return (
        freshDb.Token ||
        freshDb.models?.Token ||
        freshDb.sequelize?.models?.Token ||
        freshDb.getModel?.('Token') ||
        null
      );
    } catch (err) {
      console.warn('[TokenService] Could not load model registry:', err.message);
      return null;
    }
  }

  // Security > Session Timeout is stored under user.settings.securitySettings.
  // Keep the parser deliberately small and dependency-free because tokenService
  // is loaded very early during server startup.
  parseSessionTimeout(value) {
    if (value === undefined || value === null || value === '' || value === 'default') {
      value = this.defaultSessionTimeout;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(60, Math.floor(value));
    }
    const raw = String(value).trim().toLowerCase();
    const match = raw.match(/^(\d+)\s*(s|m|h|d)$/);
    if (!match) return this.parseSessionTimeout(this.defaultSessionTimeout);
    const amount = Number(match[1]);
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
    const seconds = amount * multiplier;
    if (!Number.isFinite(seconds) || seconds <= 0) return this.parseSessionTimeout(this.defaultSessionTimeout);
    return Math.max(60, Math.floor(seconds));
  }

  getSessionTimeoutSeconds(user) {
    const settings = user && (user.settings || (typeof user.toJSON === 'function' ? user.toJSON().settings : null));
    const security = settings && (settings.securitySettings || settings.security);
    return this.parseSessionTimeout(security && security.sessionTimeout);
  }

  getSessionTimeoutMs(user) {
    return this.getSessionTimeoutSeconds(user) * 1000;
  }

  generateAccessToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) throw new Error('Cannot generate token: Missing user ID');

    const sessionTimeoutSeconds = this.getSessionTimeoutSeconds(user);
    return jwt.sign(
      {
        userId,
        id: userId,
        email: user.email || null,
        username: user.username || null,
        role: user.role || 'user',
        type: 'access',
        sessionTimeoutMs: sessionTimeoutSeconds * 1000
      },
      this.accessSecret,
      { expiresIn: sessionTimeoutSeconds }
    );
  }

  generateRefreshToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) throw new Error('Cannot generate refresh token: Missing user ID');

    const sessionTimeoutSeconds = this.getSessionTimeoutSeconds(user);
    return jwt.sign(
      {
        userId,
        id: userId,
        type: 'refresh',
        sessionTimeoutMs: sessionTimeoutSeconds * 1000
      },
      this.refreshSecret,
      { expiresIn: sessionTimeoutSeconds }
    );
  }

  verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, this.accessSecret);
      if (decoded.type && decoded.type !== 'access') {
        return { valid: false, error: 'INVALID_TOKEN_TYPE', message: 'Token type must be "access"' };
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
        return { valid: false, error: 'INVALID_TOKEN_TYPE', message: 'Token type must be "refresh"' };
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
      if (parts.length === 2 && parts[1].trim()) return parts[1].trim();
    }
    const xAccess = req.headers['x-access-token'];
    if (xAccess && xAccess.trim()) return xAccess.trim();
    if (req.cookies?.accessToken) return req.cookies.accessToken;
    return null;
  }

  extractRefreshTokenFromRequest(req) {
    if (req.body?.refreshToken) return req.body.refreshToken;
    if (req.cookies?.refreshToken) return req.cookies.refreshToken;
    const refreshHeader = req.headers['x-refresh-token'];
    if (refreshHeader && refreshHeader.trim()) return refreshHeader.trim();
    return null;
  }

  static refreshTokenStore = new Map();

  async storeRefreshToken(token, userId, expiresIn = 7 * 24 * 60 * 60 * 1000, metadata = {}) {
    // Never let the database row outlive the JWT itself. This also fixes the
    // existing /login and /refresh callers that still pass a legacy 7-day
    // storage duration while the JWT now follows the user's session timeout.
    let effectiveExpiresIn = expiresIn;
    try {
      const decoded = jwt.decode(token);
      if (decoded && decoded.exp) {
        const tokenRemaining = Math.max(1000, decoded.exp * 1000 - Date.now());
        effectiveExpiresIn = Math.min(expiresIn, tokenRemaining);
      }
    } catch (_) {}

    const result = await this._tryStoreInDb(token, userId, effectiveExpiresIn, metadata);
    if (result) return result;

    if (!this.getTokenModel()) {
      console.warn('[TokenService] Token model not ready — waiting 2s for sync then retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const result2 = await this._tryStoreInDb(token, userId, effectiveExpiresIn, metadata);
    if (result2) return result2;

    if (process.env.NODE_ENV === 'production') {
      const TokenModel = this.getTokenModel();
      const msg = TokenModel
        ? '[TokenService] DB write failed in production — check DB connectivity and Tokens table migration.'
        : '[TokenService] Token model not registered in production — ensure Token.js is included in models/index.js and sequelize.sync() has completed before handling requests.';
      console.error(msg);
      throw new Error(msg);
    }

    console.warn('[TokenService] In-memory refresh token store active (dev only — tokens lost on restart)');
    TokenService.refreshTokenStore.set(token, {
      userId,
      expiresAt: Date.now() + effectiveExpiresIn,
      createdAt: new Date().toISOString()
    });
    return { valid: true, source: 'memory', userId };
  }

  async _tryStoreInDb(token, userId, expiresIn, metadata) {
    const TokenModel = this.getTokenModel();
    if (!TokenModel) return null;
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
        deviceInfo: metadata.deviceInfo || null
      });
      console.log('[TokenService] ✅ Refresh token stored in DB for user:', userId);
      return { valid: true, source: 'db', userId };
    } catch (error) {
      console.warn('[TokenService] DB store attempt failed:', error.message);
      return null;
    }
  }

  async validateStoredRefreshToken(token) {
    const TokenModel = this.getTokenModel();
    let dbErrored = false;
    if (TokenModel) {
      try {
        const tokenRow = await TokenModel.findOne({ where: { token, tokenType: 'refresh', isRevoked: false } });
        if (!tokenRow) return { valid: false, error: 'TOKEN_NOT_FOUND' };
        if (new Date(tokenRow.expiresAt).getTime() < Date.now()) {
          await tokenRow.update({ isRevoked: true }).catch(() => {});
          return { valid: false, error: 'TOKEN_EXPIRED' };
        }
        return { valid: true, userId: tokenRow.userId, source: 'db' };
      } catch (error) {
        console.warn('[TokenService] DB validation failed:', error.message);
        dbErrored = true;
      }
    }

    const stored = TokenService.refreshTokenStore.get(token);
    if (!stored) {
      return dbErrored
        ? { valid: false, error: 'VALIDATION_UNAVAILABLE', transient: true }
        : { valid: false, error: 'TOKEN_NOT_FOUND' };
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
        console.log(`[TokenService] Revoked ${affectedRows} DB token(s)`);
        if (affectedRows > 0) return { valid: true, source: 'db', affectedRows };
      } catch (error) {
        console.warn('[TokenService] DB revoke failed:', error.message);
      }
    }
    TokenService.refreshTokenStore.delete(token);
    return { valid: true, source: 'memory', affectedRows: 1 };
  }

  async hasKnownDevice(userId, userAgent) {
    if (!userAgent) return true;
    const TokenModel = this.getTokenModel();
    if (!TokenModel) return true;
    try {
      const existing = await TokenModel.findOne({ where: { userId, tokenType: 'refresh', userAgent } });
      return !!existing;
    } catch (error) {
      console.warn('[TokenService] hasKnownDevice check failed:', error.message);
      return true;
    }
  }

  async listUserRefreshSessions(userId) {
    const TokenModel = this.getTokenModel();
    if (!TokenModel) return [];
    try {
      const rows = await TokenModel.findAll({
        where: { userId, tokenType: 'refresh', isRevoked: false },
        order: [['createdAt', 'DESC']]
      });
      return rows
        .filter(row => new Date(row.expiresAt).getTime() > Date.now())
        .map(row => ({
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

module.exports = new TokenService();