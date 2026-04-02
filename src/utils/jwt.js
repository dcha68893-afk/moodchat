const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('./logger');

class JWTUtils {
  /**
   * Generate access token - FIXED: Consistent payload structure
   */
  static generateAccessToken(payload, options = {}) {
    const jwtConfig = config.jwt;

    if (!jwtConfig || !jwtConfig.secret) {
      throw new Error('JWT secret is not configured');
    }

    // CRITICAL FIX: Normalize payload structure with type field
    const normalizedPayload = {
      userId: payload.userId || payload.id,
      id: payload.userId || payload.id,
      email: payload.email || null,
      username: payload.username || null,
      role: payload.role || 'user',
      type: 'access',  // ← CRITICAL: Token type identification
      ...payload
    };

    // Ensure userId exists
    if (!normalizedPayload.userId) {
      logger.error('Cannot generate access token: Missing userId in payload');
      throw new Error('Missing userId in token payload');
    }

    const tokenOptions = {
      expiresIn: options.expiresIn || jwtConfig.accessToken.expiresIn,
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithm: options.algorithm || jwtConfig.accessToken.algorithm,
    };

    try {
      logger.info('🔐 Generating access token for user:', normalizedPayload.userId);
      logger.debug('Token payload:', {
        userId: normalizedPayload.userId,
        email: normalizedPayload.email,
        username: normalizedPayload.username,
        role: normalizedPayload.role,
        type: normalizedPayload.type
      });
      
      const token = jwt.sign(normalizedPayload, jwtConfig.secret, tokenOptions);
      logger.info('✅ Access token generated successfully');
      return token;
    } catch (error) {
      logger.error('JWT access token generation error:', error);
      throw new Error(`Failed to generate access token: ${error.message}`);
    }
  }

  /**
   * Generate refresh token - FIXED: Consistent payload structure
   */
  static generateRefreshToken(payload, options = {}) {
    const jwtConfig = config.jwt;

    if (!jwtConfig || !jwtConfig.secret) {
      throw new Error('JWT secret is not configured');
    }

    // CRITICAL FIX: Normalize payload structure with type field
    const normalizedPayload = {
      userId: payload.userId || payload.id,
      id: payload.userId || payload.id,
      type: 'refresh',  // ← CRITICAL: Token type identification
      ...payload
    };

    // Ensure userId exists
    if (!normalizedPayload.userId) {
      logger.error('Cannot generate refresh token: Missing userId in payload');
      throw new Error('Missing userId in token payload');
    }

    const tokenOptions = {
      expiresIn: options.expiresIn || jwtConfig.refreshToken.expiresIn,
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithm: options.algorithm || jwtConfig.refreshToken.algorithm,
    };

    try {
      logger.info('🔐 Generating refresh token for user:', normalizedPayload.userId);
      const token = jwt.sign(normalizedPayload, jwtConfig.secret, tokenOptions);
      logger.info('✅ Refresh token generated successfully');
      return token;
    } catch (error) {
      logger.error('JWT refresh token generation error:', error);
      throw new Error(`Failed to generate refresh token: ${error.message}`);
    }
  }

  /**
   * Generate both access and refresh tokens - FIXED: Consistent structure
   */
  static generateTokens(userId, additionalPayload = {}) {
    try {
      if (!userId) {
        throw new Error('User ID is required for token generation');
      }

      logger.info('Generating token pair for user:', userId);

      const accessTokenPayload = {
        userId,
        ...additionalPayload,
      };

      const refreshTokenPayload = {
        userId,
        ...additionalPayload,
      };

      const accessToken = this.generateAccessToken(accessTokenPayload);
      const refreshToken = this.generateRefreshToken(refreshTokenPayload);

      logger.info('✅ Token pair generated successfully');
      return { accessToken, refreshToken };
    } catch (error) {
      logger.error('Token pair generation error:', error);
      throw error;
    }
  }

  /**
   * Verify token - FIXED: Graceful error handling and type validation
   */
  static verifyToken(token, options = {}) {
    const jwtConfig = config.jwt;

    if (!jwtConfig || !jwtConfig.secret) {
      throw new Error('JWT secret is not configured');
    }

    if (!token || typeof token !== 'string') {
      throw new Error('Invalid token format');
    }

    const verifyOptions = {
      issuer: options.issuer || jwtConfig.issuer,
      audience: options.audience || jwtConfig.audience,
      algorithms: [options.algorithm || jwtConfig.accessToken.algorithm],
    };

    try {
      logger.debug('Verifying JWT token...');
      const decoded = jwt.verify(token, jwtConfig.secret, verifyOptions);
      
      // CRITICAL FIX: Validate token type if specified
      if (options.expectedType && decoded.type !== options.expectedType) {
        logger.warn(`Token type mismatch. Expected ${options.expectedType}, got ${decoded.type}`);
        throw new Error('Invalid token type');
      }
      
      // Validate required fields based on type
      if (decoded.type === 'access') {
        if (!decoded.userId && !decoded.id) {
          logger.warn('Access token missing userId');
          throw new Error('Invalid access token: missing user ID');
        }
      } else if (decoded.type === 'refresh') {
        if (!decoded.userId && !decoded.id) {
          logger.warn('Refresh token missing userId');
          throw new Error('Invalid refresh token: missing user ID');
        }
      }
      
      logger.info('✅ Token verification successful for user:', decoded.userId || decoded.id);
      logger.debug('Token type:', decoded.type);
      
      return decoded;
    } catch (error) {
      // Don't log TokenExpiredError as an error, it's expected behavior
      if (error.name === 'TokenExpiredError') {
        logger.warn('⏰ JWT token expired:', error.message);
      } else if (error.name === 'JsonWebTokenError') {
        logger.warn('❌ JWT token verification failed:', error.message);
      } else {
        logger.error('❌ JWT verification error:', error);
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
      const decoded = jwt.decode(token, { complete: true });
      if (decoded && decoded.payload) {
        logger.debug('Token decoded successfully');
      }
      return decoded;
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
        const expirationDate = new Date(decoded.payload.exp * 1000);
        logger.debug('Token expiration:', expirationDate.toISOString());
        return expirationDate;
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
      const secondsRemaining = Math.max(0, Math.floor(diff));
      logger.debug('Time until expiration:', secondsRemaining, 'seconds');
      return secondsRemaining;
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
      logger.info('Generating password reset token for user:', userId);
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
        throw new Error('Invalid token type - expected password_reset');
      }

      logger.info('Password reset token verified for user:', decoded.userId);
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
      logger.info('Generating email verification token for user:', userId);
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
        throw new Error('Invalid token type - expected email_verification');
      }

      logger.info('Email verification token verified for user:', decoded.userId);
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
      logger.info('Generating API key for user:', userId);
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
        throw new Error('Invalid token type - expected api_key');
      }

      logger.info('API key verified for user:', decoded.userId);
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

    logger.debug('Token extracted from header successfully');
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
      logger.info(`Generating one-time token for user ${userId} with purpose: ${purpose}`);
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
        throw new Error('Invalid token type - expected one_time');
      }

      if (decoded.purpose !== purpose) {
        throw new Error('Invalid token purpose');
      }

      logger.info(`One-time token verified for user ${decoded.userId} with purpose: ${purpose}`);
      return decoded;
    } catch (error) {
      logger.error('One-time token verification error:', error);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token - FIXED: Validation
   */
  static async refreshAccessToken(refreshToken, userService) {
    try {
      // Verify refresh token
      const decoded = this.verifyToken(refreshToken, { expectedType: 'refresh' });
      
      if (!decoded.userId) {
        throw new Error('Invalid refresh token payload');
      }

      // Verify user still exists and is active
      if (userService) {
        const user = await userService.findById(decoded.userId);
        if (!user || !user.isActive) {
          throw new Error('User not found or inactive');
        }
      }

      // Generate new access token
      const newAccessToken = this.generateAccessToken({
        userId: decoded.userId,
        email: decoded.email,
        username: decoded.username,
        role: decoded.role
      });

      logger.info('Access token refreshed successfully for user:', decoded.userId);
      
      return {
        accessToken: newAccessToken,
        refreshToken: refreshToken, // Keep same refresh token or generate new one
        expiresIn: this.getTimeUntilExpiration(newAccessToken)
      };
    } catch (error) {
      logger.error('Token refresh error:', error);
      throw error;
    }
  }

  /**
   * Validate token and return user info - FIXED: Complete validation
   */
  static validateToken(token, expectedType = 'access') {
    try {
      const decoded = this.verifyToken(token, { expectedType });
      
      // Extract user information
      const userInfo = {
        userId: decoded.userId || decoded.id,
        email: decoded.email,
        username: decoded.username,
        role: decoded.role,
        type: decoded.type,
        expiresAt: this.getTokenExpiration(token),
        timeToExpire: this.getTimeUntilExpiration(token)
      };

      logger.debug('Token validation successful for user:', userInfo.userId);
      
      return {
        valid: true,
        user: userInfo,
        decoded: decoded
      };
    } catch (error) {
      logger.debug('Token validation failed:', error.message);
      
      return {
        valid: false,
        error: error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: error.message
      };
    }
  }

  /**
   * Check if token needs refresh (within refresh threshold) - NEW METHOD
   */
  static needsRefresh(token, thresholdSeconds = 300) {
    const timeRemaining = this.getTimeUntilExpiration(token);
    const needsRefresh = timeRemaining > 0 && timeRemaining <= thresholdSeconds;
    
    if (needsRefresh) {
      logger.info(`Token needs refresh. ${timeRemaining} seconds remaining (threshold: ${thresholdSeconds}s)`);
    }
    
    return needsRefresh;
  }

  /**
   * Get token type - NEW METHOD
   */
  static getTokenType(token) {
    try {
      const decoded = this.decodeToken(token);
      if (decoded && decoded.payload && decoded.payload.type) {
        return decoded.payload.type;
      }
      return null;
    } catch (error) {
      logger.error('Error getting token type:', error);
      return null;
    }
  }

  /**
   * Check if token has required role - NEW METHOD
   */
  static hasRole(token, requiredRole) {
    try {
      const decoded = this.decodeToken(token);
      if (decoded && decoded.payload) {
        const userRole = decoded.payload.role || 'user';
        const hasRole = userRole === requiredRole;
        logger.debug(`Token role check: ${userRole} ${hasRole ? 'matches' : 'does not match'} ${requiredRole}`);
        return hasRole;
      }
      return false;
    } catch (error) {
      logger.error('Error checking token role:', error);
      return false;
    }
  }
}

module.exports = JWTUtils;