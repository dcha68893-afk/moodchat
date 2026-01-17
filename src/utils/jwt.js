const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('./logger');

class JWTUtils {
  /**
   * Generate access token - FIXED: Explicit error handling
   */
  static generateAccessToken(payload, options = {}) {
    const jwtConfig = config.jwt;

    if (!jwtConfig || !jwtConfig.secret) {
      throw new Error('JWT secret is not configured');
    }

    const tokenOptions = {
      expiresIn: options.expiresIn || jwtConfig.accessToken.expiresIn,
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithm: options.algorithm || jwtConfig.accessToken.algorithm,
    };

    try {
      return jwt.sign(payload, jwtConfig.secret, tokenOptions);
    } catch (error) {
      logger.error('JWT access token generation error:', error);
      throw new Error(`Failed to generate access token: ${error.message}`);
    }
  }

  /**
   * Generate refresh token - FIXED: Explicit error handling
   */
  static generateRefreshToken(payload, options = {}) {
    const jwtConfig = config.jwt;

    if (!jwtConfig || !jwtConfig.secret) {
      throw new Error('JWT secret is not configured');
    }

    const tokenOptions = {
      expiresIn: options.expiresIn || jwtConfig.refreshToken.expiresIn,
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithm: options.algorithm || jwtConfig.refreshToken.algorithm,
    };

    try {
      return jwt.sign(payload, jwtConfig.secret, tokenOptions);
    } catch (error) {
      logger.error('JWT refresh token generation error:', error);
      throw new Error(`Failed to generate refresh token: ${error.message}`);
    }
  }

  /**
   * Generate both access and refresh tokens - FIXED: Explicit error handling
   */
  static generateTokens(userId, additionalPayload = {}) {
    try {
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
    } catch (error) {
      logger.error('Token pair generation error:', error);
      throw error;
    }
  }

  /**
   * Verify token - FIXED: Graceful error handling for expired tokens
   */
  static verifyToken(token, options = {}) {
    const jwtConfig = config.jwt;

    if (!jwtConfig || !jwtConfig.secret) {
      throw new Error('JWT secret is not configured');
    }

    const verifyOptions = {
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithms: [options.algorithm || jwtConfig.accessToken.algorithm],
    };

    try {
      return jwt.verify(token, jwtConfig.secret, verifyOptions);
    } catch (error) {
      // Don't log TokenExpiredError as an error, it's expected behavior
      if (error.name === 'TokenExpiredError') {
        logger.warn('JWT token expired:', error.message);
      } else if (error.name === 'JsonWebTokenError') {
        logger.warn('JWT token verification failed:', error.message);
      } else {
        logger.error('JWT verification error:', error);
      }
      throw error;
    }
  }

  /**
   * Decode token without verification - FIXED: Explicit error handling
   */
  static decodeToken(token) {
    if (!token || typeof token !== 'string') {
      return null;
    }

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
      this.verifyToken(token);
      return false;
    } catch (error) {
      return error.name === 'TokenExpiredError';
    }
  }

  /**
   * Get token expiration time - FIXED: Explicit error handling
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
   * Get time until token expires (in seconds) - FIXED: Explicit error handling
   */
  static getTimeUntilExpiration(token) {
    const expiration = this.getTokenExpiration(token);
    if (!expiration) return 0;

    try {
      const now = new Date();
      const diff = (expiration.getTime() - now.getTime()) / 1000;
      return Math.max(0, Math.floor(diff));
    } catch (error) {
      logger.error('Get time until expiration error:', error);
      return 0;
    }
  }

  /**
   * Generate password reset token - FIXED: Explicit error handling
   */
  static generatePasswordResetToken(userId) {
    if (!userId) {
      throw new Error('User ID is required for password reset token');
    }

    const payload = {
      userId,
      type: 'password_reset',
      timestamp: Date.now(),
    };

    try {
      return jwt.sign(payload, config.jwt.secret, {
        expiresIn: '1h',
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch (error) {
      logger.error('Password reset token generation error:', error);
      throw new Error(`Failed to generate password reset token: ${error.message}`);
    }
  }

  /**
   * Verify password reset token - FIXED: Explicit error handling
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
   * Generate email verification token - FIXED: Explicit error handling
   */
  static generateEmailVerificationToken(userId, email) {
    if (!userId || !email) {
      throw new Error('User ID and email are required for verification token');
    }

    const payload = {
      userId,
      email,
      type: 'email_verification',
      timestamp: Date.now(),
    };

    try {
      return jwt.sign(payload, config.jwt.secret, {
        expiresIn: '24h',
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch (error) {
      logger.error('Email verification token generation error:', error);
      throw new Error(`Failed to generate email verification token: ${error.message}`);
    }
  }

  /**
   * Verify email verification token - FIXED: Explicit error handling
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
   * Generate API key token - FIXED: Explicit error handling
   */
  static generateApiKey(userId, permissions = []) {
    if (!userId) {
      throw new Error('User ID is required for API key');
    }

    const payload = {
      userId,
      type: 'api_key',
      permissions,
      timestamp: Date.now(),
    };

    try {
      return jwt.sign(payload, config.jwt.secret, {
        expiresIn: '365d', // 1 year
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch (error) {
      logger.error('API key generation error:', error);
      throw new Error(`Failed to generate API key: ${error.message}`);
    }
  }

  /**
   * Verify API key - FIXED: Explicit error handling
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
   * Extract token from authorization header - FIXED: Explicit validation
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

    // Validate token format
    if (typeof token !== 'string' || token.length < 10) {
      return null;
    }

    return token;
  }

  /**
   * Generate short-lived token for one-time use - FIXED: Explicit error handling
   */
  static generateOneTimeToken(userId, purpose, expiresIn = '5m') {
    if (!userId || !purpose) {
      throw new Error('User ID and purpose are required for one-time token');
    }

    const payload = {
      userId,
      type: 'one_time',
      purpose,
      timestamp: Date.now(),
    };

    try {
      return jwt.sign(payload, config.jwt.secret, {
        expiresIn,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch (error) {
      logger.error('One-time token generation error:', error);
      throw new Error(`Failed to generate one-time token: ${error.message}`);
    }
  }

  /**
   * Verify one-time token - FIXED: Explicit error handling
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