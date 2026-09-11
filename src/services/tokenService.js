// services/tokenService.js
// VERSION: 2.1.3 - Per-user security session timeout + non-expiring option + refresh grace
const jwt = require('jsonwebtoken');
const express = require('express');

if (!express.response.__moodSessionExpiryPatched) {
  const originalJson = express.response.json;
  express.response.json = function normalizedAuthJson(body) {
    try {
      if (body && body.success === true) {
        const accessToken = body.accessToken || body.token;
        if (accessToken && typeof accessToken === 'string') {
          const decoded = jwt.decode(accessToken);
          if (decoded && Number.isFinite(decoded.exp)) {
            body.expiresIn = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
            body.expiresAt = new Date(decoded.exp * 1000).toISOString();
          } else if (decoded && decoded.sessionTimeoutMs === 0) {
            body.expiresIn = null;
            body.expiresAt = null;
            body.sessionTimeout = 'off';
          }
        }
      }
    } catch (_) {}
    return originalJson.call(this, body);
  };
  express.response.__moodSessionExpiryPatched = true;
}

class TokenService {
  constructor() {
    let _cfg = {};
    try { _cfg = require('../config').jwt || {}; } catch (_) {}
    this.accessSecret  = _cfg.accessSecret  || process.env.JWT_ACCESS_SECRET  || process.env.JWT_SECRET;
    this.refreshSecret = _cfg.refreshSecret || process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
    if (!this.accessSecret) throw new Error('JWT_SECRET or JWT_ACCESS_SECRET must be set');
    this.accessExpiry = process.env.JWT_ACCESS_EXPIRES_IN || '24h';
    this.refreshExpiry = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
    this.defaultSessionTimeout = '8h';
    console.log('[TokenService] Initialized');
  }

  getTokenModel() {
    try {
      const freshDb = require('../models');
      return freshDb.Token || freshDb.models?.Token || freshDb.sequelize?.models?.Token || freshDb.getModel?.('Token') || null;
    } catch (err) {
      console.warn('[TokenService] Could not load model registry:', err.message);
      return null;
    }
  }

  parseSessionTimeout(value) {
    if (value === undefined || value === null || value === '' || value === 'default') value = this.defaultSessionTimeout;
    if (String(value).trim().toLowerCase() === 'off' || String(value).trim().toLowerCase() === 'never' || value === 0) return 0;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.max(60, Math.floor(value));
    const normalized = String(value).trim().toLowerCase().replace(/minutes?$/, 'min').replace(/hours?$/, 'hr');
    const compact = normalized === '15min' ? '15m' : normalized === '30min' ? '30m' : normalized === '1hr' ? '1h' : normalized === '8hr' ? '8h' : normalized;
    const match = compact.match(/^(\d+)\s*(s|m|h|d)$/);
    if (!match) return this.parseSessionTimeout(this.defaultSessionTimeout);
    const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.max(60, Math.floor(seconds)) : this.parseSessionTimeout(this.defaultSessionTimeout);
  }

  getSessionTimeoutSeconds(user) {
    const settings = user && (user.settings || (typeof user.toJSON === 'function' ? user.toJSON().settings : null));
    const security = settings && (settings.securitySettings || settings.security);
    return this.parseSessionTimeout(security && security.sessionTimeout);
  }

  getSessionTimeoutMs(user) { const seconds = this.getSessionTimeoutSeconds(user); return seconds === 0 ? 0 : seconds * 1000; }

  generateAccessToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) throw new Error('Cannot generate token: Missing user ID');
    const sessionTimeoutSeconds = this.getSessionTimeoutSeconds(user);
    const payload = {
      userId, id: userId, email: user.email || null, username: user.username || null,
      role: user.role || 'user', type: 'access', sessionTimeoutMs: sessionTimeoutSeconds * 1000
    };
    return sessionTimeoutSeconds === 0
      ? jwt.sign(payload, this.accessSecret)
      : jwt.sign(payload, this.accessSecret, { expiresIn: sessionTimeoutSeconds });
  }

  generateRefreshToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) throw new Error('Cannot generate refresh token: Missing user ID');
    const sessionTimeoutSeconds = this.getSessionTimeoutSeconds(user);
    if (sessionTimeoutSeconds === 0) {
      return jwt.sign({ userId, id: userId, type: 'refresh', sessionTimeoutMs: 0 }, this.refreshSecret);
    }
    const refreshSeconds = Math.max(sessionTimeoutSeconds + 120, sessionTimeoutSeconds * 2);
    return jwt.sign({ userId, id: userId, type: 'refresh', sessionTimeoutMs: sessionTimeoutSeconds * 1000 }, this.refreshSecret, { expiresIn: refreshSeconds });
  }

  verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, this.accessSecret);
      if (decoded.type && decoded.type !== 'access') return { valid: false, error: 'INVALID_TOKEN_TYPE', message: 'Token type must be "access"' };
      return { valid: true, decoded };
    } catch (error) {
      return { valid: false, error: error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', message: error.message };
    }
  }

  verifyRefreshToken(token) {
    try {
      const decoded = jwt.verify(token, this.refreshSecret);
      if (decoded.type && decoded.type !== 'refresh') return { valid: false, error: 'INVALID_TOKEN_TYPE', message: 'Token type must be "refresh"' };
      return { valid: true, decoded };
    } catch (error) {
      return { valid: false, error: error.name === 'TokenExpiredError' ? 'REFRESH_TOKEN_EXPIRED' : 'INVALID_REFRESH_TOKEN', message: error.message };
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
    let effectiveExpiresIn = expiresIn;
    try {
      const decoded = jwt.decode(token);
      if (decoded && decoded.exp) effectiveExpiresIn = Math.min(expiresIn, Math.max(1000, decoded.exp * 1000 - Date.now()));
      else if (decoded && decoded.sessionTimeoutMs === 0) effectiveExpiresIn = 365 * 24 * 60 * 60 * 1000 * 100;
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
    TokenService.refreshTokenStore.set(token, { userId, expiresAt: Date.now() + effectiveExpiresIn, createdAt: new Date().toISOString() });
    return { valid: true, source: 'memory', userId };
  }

  async _tryStoreInDb(token, userId, expiresIn, metadata) {
    const TokenModel = this.getTokenModel();
    if (!TokenModel) return null;
    try {
      await TokenModel.create({ userId, token, tokenType: 'refresh', expiresAt: new Date(Date.now() + expiresIn), isRevoked: false, userAgent: metadata.userAgent || null, ipAddress: metadata.ipAddress || null, deviceInfo: metadata.deviceInfo || null });
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
    if (!stored) return dbErrored ? { valid: false, error: 'VALIDATION_UNAVAILABLE', transient: true } : { valid: false, error: 'TOKEN_NOT_FOUND' };
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
        const [affectedRows] = await TokenModel.update({ isRevoked: true }, { where: { token, tokenType: 'refresh', isRevoked: false } });
        console.log(`[TokenService] Revoked ${affectedRows} DB token(s)`);
        if (affectedRows > 0) return { valid: true, source: 'db', affectedRows };
      } catch (error) { console.warn('[TokenService] DB revoke failed:', error.message); }
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
      const rows = await TokenModel.findAll({ where: { userId, tokenType: 'refresh', isRevoked: false }, order: [['createdAt', 'DESC']] });
      return rows.filter(row => new Date(row.expiresAt).getTime() > Date.now()).map(row => ({ id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt, userAgent: row.userAgent || 'Unknown', ipAddress: row.ipAddress || 'Unknown', deviceInfo: row.deviceInfo || null, tokenType: row.tokenType }));
    } catch (error) {
      console.warn('[TokenService] Failed to list refresh sessions:', error.message);
      return [];
    }
  }
}

module.exports = new TokenService();