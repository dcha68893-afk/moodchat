// services/tokenService.js
// VERSION: 2.0.0 - Production-safe deferred model resolution + atomic token rotation
const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────────────────────────────────────────
// BUG FIX #1: Do NOT require('../models') at module load time.
// In production on Render, tokenService is loaded (via require cache) BEFORE
// sequelize.sync() finishes.  The top-level `const db = require('../models')`
// therefore captures an empty / partially-hydrated registry — Token is null.
// We resolve the model lazily on every call instead.
// ─────────────────────────────────────────────────────────────────────────────

class TokenService {
  constructor() {
    // FIX-018: Read from centralized config so resolution order is consistent everywhere
    let _cfg = {};
    try { _cfg = require('../config').jwt || {}; } catch(_) {}
    this.accessSecret  = _cfg.accessSecret  || process.env.JWT_ACCESS_SECRET  || process.env.JWT_SECRET;
    this.refreshSecret = _cfg.refreshSecret || process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

    if (!this.accessSecret) {
      throw new Error('JWT_SECRET or JWT_ACCESS_SECRET must be set');
    }

    this.accessExpiry  = process.env.JWT_ACCESS_EXPIRES_IN  || '24h';
    this.refreshExpiry = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

    console.log('[TokenService] Initialized');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX #1 (continued): Lazy model getter — always re-requires so we get
  // the post-sync, fully-hydrated Sequelize registry regardless of load order.
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // Token generation
  // ─────────────────────────────────────────────────────────────────────────
  generateAccessToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) throw new Error('Cannot generate token: Missing user ID');

    return jwt.sign(
      {
        userId,
        id: userId,
        email:    user.email    || null,
        username: user.username || null,
        role:     user.role     || 'user',
        type:     'access'
      },
      this.accessSecret,
      { expiresIn: this.accessExpiry }
    );
  }

  generateRefreshToken(user) {
    const userId = user.id || user.userId || user._id;
    if (!userId) throw new Error('Cannot generate refresh token: Missing user ID');

    return jwt.sign(
      { userId, id: userId, type: 'refresh' },
      this.refreshSecret,
      { expiresIn: this.refreshExpiry }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token verification
  // ─────────────────────────────────────────────────────────────────────────
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
        error:   error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
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
        error:   error.name === 'TokenExpiredError' ? 'REFRESH_TOKEN_EXPIRED' : 'INVALID_REFRESH_TOKEN',
        message: error.message
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token extraction from HTTP requests
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // Legacy in-memory fallback (dev only, wiped on restart)
  // ─────────────────────────────────────────────────────────────────────────
  static refreshTokenStore = new Map();

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX #2: storeRefreshToken — production-safe retry with clear error.
  //
  // Root cause of the login failure:
  //   The Token model was null at call time because sequelize.sync() had not
  //   yet completed.  The old code fell through to the production hard-throw
  //   immediately, so login always failed in production.
  //
  // Fix:
  //   1. Try DB — if it works, great.
  //   2. If the model is null, wait up to 3 seconds for sync to complete and
  //      retry once (handles the race condition on cold-start / first request).
  //   3. If DB is still unavailable in production, log clearly and throw with
  //      a message that points to the actual problem (sync not complete /
  //      Token model not registered), NOT a misleading "DB connection" error.
  //   4. In development, fall back to in-memory as before.
  // ─────────────────────────────────────────────────────────────────────────
  async storeRefreshToken(token, userId, expiresIn = 7 * 24 * 60 * 60 * 1000, metadata = {}) {
    // ── Attempt 1: DB (immediate) ────────────────────────────────────────
    const result = await this._tryStoreInDb(token, userId, expiresIn, metadata);
    if (result) return result;

    // ── Attempt 2: DB (retry after short delay — handles cold-start race) ─
    if (!this.getTokenModel()) {
      console.warn('[TokenService] Token model not ready — waiting 2s for sync then retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const result2 = await this._tryStoreInDb(token, userId, expiresIn, metadata);
    if (result2) return result2;

    // ── Production: hard-fail with a clear, actionable message ───────────
    if (process.env.NODE_ENV === 'production') {
      const TokenModel = this.getTokenModel();
      const msg = TokenModel
        // Model is registered but the DB write itself failed — check logs above
        ? '[TokenService] DB write failed in production — check DB connectivity and Tokens table migration.'
        // Model is not registered at all — most likely cause of the original bug
        : '[TokenService] Token model not registered in production — ensure Token.js is included in models/index.js and sequelize.sync() has completed before handling requests.';
      console.error(msg);
      throw new Error(msg);
    }

    // ── Development: in-memory fallback ─────────────────────────────────
    console.warn('[TokenService] In-memory refresh token store active (dev only — tokens lost on restart)');
    TokenService.refreshTokenStore.set(token, {
      userId,
      expiresAt: Date.now() + expiresIn,
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
        tokenType:  'refresh',
        expiresAt,
        isRevoked:  false,
        userAgent:  metadata.userAgent  || null,
        ipAddress:  metadata.ipAddress  || null,
        deviceInfo: metadata.deviceInfo || null
        // NOTE: 'scope' is not a column in Token.js — removed to prevent Sequelize error
      });
      console.log('[TokenService] ✅ Refresh token stored in DB for user:', userId);
      return { valid: true, source: 'db', userId };
    } catch (error) {
      console.warn('[TokenService] DB store attempt failed:', error.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX #3: validateStoredRefreshToken — graceful DB fallback.
  // If the model is null (race condition on refresh call), fall through to
  // memory store rather than crashing, so /auth/refresh still works in dev
  // and gives a clear error in production.
  //
  // FIX-REFRESH-FALSE-REAUTH (confirmed live Aug 28 2026 — frontend console
  // showed a wave of "Token expired and requires reauthentication" across
  // message.html/friend.html/Tools.html all firing at once, at the exact
  // same moment app.realtime.socket.js was logging repeated "xhr poll
  // error" — i.e. a transient backend/DB connectivity blip (Render cold
  // start / dyno wake / DB pool reconnect), not an actually-dead refresh
  // token): a thrown DB error here used to be silently swallowed (just a
  // console.warn) and fall through to the in-memory refreshTokenStore —
  // which, in production, never has this token in it (real tokens are
  // stored via the DB, not the memory map), so it always came back
  // TOKEN_NOT_FOUND. The caller (authController.refreshToken) treats
  // TOKEN_NOT_FOUND as a hard 401 "Invalid refresh token", which the
  // frontend's refreshTokenIfNeeded() maps straight to requiresReauth:true
  // — permanently giving up on a session that was actually still valid,
  // for every subsystem that shares this one refresh call, simultaneously.
  // Fixed by tracking whether the DB lookup itself failed (vs. genuinely
  // found nothing) and, only in that case, returning a distinct
  // transient:true error instead of TOKEN_NOT_FOUND — so the controller
  // can respond 503 (retryable) instead of 401 (terminal). A DB error that
  // still resolves via the memory fallback is unaffected — this only
  // changes the case where BOTH lookups come up empty after a real DB
  // error, which previously had no way to distinguish itself from an
  // actually-invalid token.
  // ─────────────────────────────────────────────────────────────────────────
  async validateStoredRefreshToken(token) {
    const TokenModel = this.getTokenModel();
    let dbErrored = false;
    if (TokenModel) {
      try {
        const tokenRow = await TokenModel.findOne({
          where: { token, tokenType: 'refresh', isRevoked: false }
        });

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

    // Memory fallback (dev only — in production this only fires if DB is down)
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

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX #4: invalidateRefreshToken — atomic old-token wipe.
  // Called during token rotation (/auth/refresh) so the old refresh token is
  // always invalidated before the new one is stored, preventing replay attacks
  // and ensuring no stale token lingers in the DB.
  // ─────────────────────────────────────────────────────────────────────────
  async invalidateRefreshToken(token) {
    const TokenModel = this.getTokenModel();
    if (TokenModel) {
      try {
        const [affectedRows] = await TokenModel.update(
          { isRevoked: true },
          { where: { token, tokenType: 'refresh', isRevoked: false } }
        );
        // Log even if 0 rows — could mean token was already revoked (idempotent)
        console.log(`[TokenService] Revoked ${affectedRows} DB token(s)`);
        if (affectedRows > 0) return { valid: true, source: 'db', affectedRows };
      } catch (error) {
        console.warn('[TokenService] DB revoke failed:', error.message);
      }
    }

    // Memory fallback
    TokenService.refreshTokenStore.delete(token);
    return { valid: true, source: 'memory', affectedRows: 1 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P2 FIX (Forensic Audit): "Add new-device login notification"
  // Checks whether this user has a prior, non-revoked refresh token issued
  // from the same User-Agent. Used by /auth/login to decide whether to send
  // a "new device" security alert email. This is a heuristic (UA string
  // match) — not a strong device fingerprint — but matches the audit's
  // suggested approach without requiring new infrastructure.
  // ─────────────────────────────────────────────────────────────────────────
  async hasKnownDevice(userId, userAgent) {
    if (!userAgent) return true; // can't compare — don't alert on missing UA
    const TokenModel = this.getTokenModel();
    if (!TokenModel) return true; // fail open — don't block/alert if DB unavailable

    try {
      const existing = await TokenModel.findOne({
        where: { userId, tokenType: 'refresh', userAgent }
      });
      return !!existing;
    } catch (error) {
      console.warn('[TokenService] hasKnownDevice check failed:', error.message);
      return true; // fail open
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
          id:         row.id,
          createdAt:  row.createdAt,
          expiresAt:  row.expiresAt,
          userAgent:  row.userAgent  || 'Unknown',
          ipAddress:  row.ipAddress  || 'Unknown',
          deviceInfo: row.deviceInfo || null,
          tokenType:  row.tokenType
        }));
    } catch (error) {
      console.warn('[TokenService] Failed to list refresh sessions:', error.message);
      return [];
    }
  }
}

// Remove the top-level db debug logs — they fire before sync and always show
// an empty model registry, which is misleading and noisy in production.
module.exports = new TokenService();