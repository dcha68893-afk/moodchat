const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('./logger');

class JWTUtils {
  /**
   * Generate access token
   */
  static generateAccessToken(payload, options = {}) {
    const jwtConfig = config.jwt;

    const tokenOptions = {
      expiresIn: options.expiresIn || jwtConfig.accessToken.expiresIn,
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithm: options.algorithm || jwtConfig.accessToken.algorithm,
    };

    return jwt.sign(payload, jwtConfig.secret, tokenOptions);
  }

  /**
   * Generate refresh token
   */
  static generateRefreshToken(payload, options = {}) {
    const jwtConfig = config.jwt;

    const tokenOptions = {
      expiresIn: options.expiresIn || jwtConfig.refreshToken.expiresIn,
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithm: options.algorithm || jwtConfig.refreshToken.algorithm,
    };

    return jwt.sign(payload, jwtConfig.secret, tokenOptions);
  }

  /**
   * Generate both access and refresh tokens
   */
  static generateTokens(userId, additionalPayload = {}) {
    const accessTokenPayload = {
      userId,
      type: 'access',
      ...additionalPayload,
    };

    const refreshTokenPayload = {
      userId,
      type: 'refresh',
      ...additionalPayload,
    };

    const accessToken = this.generateAccessToken(accessTokenPayload);
    const refreshToken = this.generateRefreshToken(refreshTokenPayload);

    return { accessToken, refreshToken };
  }

  /**
   * Verify token
   */
  static verifyToken(token, options = {}) {
    const jwtConfig = config.jwt;

    const verifyOptions = {
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithms: [options.algorithm || jwtConfig.accessToken.algorithm],
    };

    try {
      return jwt.verify(token, jwtConfig.secret, verifyOptions);
    } catch (error) {
      logger.error('JWT verification error:', error);
      throw error;
    }
  }

  /**
   * Decode token without verification
   */
  static decodeToken(token) {
    try {
      return jwt.decode(token, { complete: true });
    } catch (error) {
      logger.error('JWT decode error:', error);
      return null;
    }
  }

  /**
   * Check if token is expired
   */
  static isTokenExpired(token) {
    try {
      const decoded = this.verifyToken(token);
      return false;
    } catch (error) {
      return error.name === 'TokenExpiredError';
    }
  }

  /**
   * Get token expiration time
   */
  static getTokenExpiration(token) {
    try {
      const decoded = this.decodeToken(token);
      if (decoded && decoded.payload.exp) {
        return new Date(decoded.payload.exp * 1000);
      }
    } catch (error) {
      logger.error('Get token expiration error:', error);
    }
    return null;
  }

  /**
   * Get time until token expires (in seconds)
   */
  static getTimeUntilExpiration(token) {
    const expiration = this.getTokenExpiration(token);
    if (!expiration) return 0;

    const now = new Date();
    const diff = (expiration.getTime() - now.getTime()) / 1000;

    return Math.max(0, Math.floor(diff));
  }

  /**
   * Generate password reset token
   */
  static generatePasswordResetToken(userId) {
    const payload = {
      userId,
      type: 'password_reset',
      timestamp: Date.now(),
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: '1h',
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  }

  /**
   * Verify password reset token
   */
  static verifyPasswordResetToken(token) {
    try {
      const decoded = this.verifyToken(token);

      if (decoded.type !== 'password_reset') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      logger.error('Password reset token verification error:', error);
      throw error;
    }
  }

  /**
   * Generate email verification token
   */
  static generateEmailVerificationToken(userId, email) {
    const payload = {
      userId,
      email,
      type: 'email_verification',
      timestamp: Date.now(),
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: '24h',
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  }

  /**
   * Verify email verification token
   */
  static verifyEmailVerificationToken(token) {
    try {
      const decoded = this.verifyToken(token);

      if (decoded.type !== 'email_verification') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      logger.error('Email verification token verification error:', error);
      throw error;
    }
  }

  /**
   * Generate API key token
   */
  static generateApiKey(userId, permissions = []) {
    const payload = {
      userId,
      type: 'api_key',
      permissions,
      timestamp: Date.now(),
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: '365d', // 1 year
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  }

  /**
   * Verify API key
   */
  static verifyApiKey(token) {
    try {
      const decoded = this.verifyToken(token);

      if (decoded.type !== 'api_key') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      logger.error('API key verification error:', error);
      throw error;
    }
  }

  /**
   * Extract token from authorization header
   */
  static extractTokenFromHeader(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') {
      return null;
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2) {
      return null;
    }

    const [scheme, token] = parts;

    if (!/^Bearer$/i.test(scheme)) {
      return null;
    }

    return token;
  }

  /**
   * Generate short-lived token for one-time use
   */
  static generateOneTimeToken(userId, purpose, expiresIn = '5m') {
    const payload = {
      userId,
      type: 'one_time',
      purpose,
      timestamp: Date.now(),
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  }

  /**
   * Verify one-time token
   */
  static verifyOneTimeToken(token, purpose) {
    try {
      const decoded = this.verifyToken(token);

      if (decoded.type !== 'one_time') {
        throw new Error('Invalid token type');
      }

      if (decoded.purpose !== purpose) {
        throw new Error('Invalid token purpose');
      }

      return decoded;
    } catch (error) {
      logger.error('One-time token verification error:', error);
      throw error;
    }
  }
}

module.exports = JWTUtils;
