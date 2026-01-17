const authService = require('../services/authService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const validator = require('validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { User, Token, LoginAttempt } = require('../models'); // Import models

// In-memory store for login attempts (for simplicity)
// In production, use Redis or database
const loginAttemptsStore = new Map();

class AuthController {
  async register(req, res, next) {
    try {
      console.log("AUTH BODY (Register):", { ...req.body, password: '[REDACTED]' });
      
      const { username, email, password } = req.body;

      logger.info(`Registration attempt for: ${email}`, { username });

      // Validate all required fields
      if (!email || !password || !username) {
        return res.status(400).json({
          success: false,
          message: 'Email, username, and password are required'
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Validate username format
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({
          success: false,
          message: 'Username can only contain letters, numbers, and underscores'
        });
      }

      // Validate password strength
      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters long'
        });
      }

      // Call authService.register - FIXED: Use authService for registration logic
      const result = await authService.register({
        username: username.trim(),
        email: email.toLowerCase().trim(),
        password: password,
        firstName: req.body.firstName,
        lastName: req.body.lastName
      });

      // Log successful registration
      logger.info(`User registered successfully: ${email}`, { 
        userId: result.user.id,
        username: result.user.username 
      });

      // Return JSON response with user and tokens
      return res.status(201).json({
        success: true,
        message: 'Registration successful',
        data: {
          user: result.user,
          tokens: result.tokens
        }
      });
    } catch (error) {
      logger.error('Registration controller error:', {
        error: error.message,
        stack: error.stack,
        email: req.body.email
      });
      
      // Handle specific error cases
      if (error.message.includes('already exists') || 
          error.message.includes('already taken') || 
          error.message.includes('already registered')) {
        return res.status(409).json({
          success: false,
          message: error.message
        });
      }
      
      // Handle validation errors
      if (error.name === 'SequelizeValidationError' || 
          error.name === 'ValidationError') {
        const messages = error.errors ? error.errors.map(err => err.message) : [error.message];
        return res.status(400).json({
          success: false,
          message: messages.join(', ')
        });
      }
      
      // Handle database errors
      if (error.name === 'SequelizeDatabaseError' || 
          error.name === 'SequelizeUniqueConstraintError') {
        return res.status(400).json({
          success: false,
          message: 'Database error occurred'
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async login(req, res, next) {
    try {
      console.log("AUTH BODY (Login):", { ...req.body, password: '[REDACTED]' });
      
      const { identifier, password } = req.body;

      logger.info(`Login attempt for identifier: ${identifier}`);

      // Validate required fields
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email or username) and password are required'
        });
      }

      // ============================================================================
      // PROGRESSIVE LOGIN ATTEMPT LIMITING
      // ============================================================================
      
      // Generate a key for tracking attempts (email or username + IP)
      const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      const attemptKey = `${identifier}_${clientIp}`;
      
      // Check existing attempts
      let attempts = loginAttemptsStore.get(attemptKey) || { count: 0, lastAttempt: null };
      
      // Progressive delays: 20s, 40s, 60s
      const delays = [20000, 40000, 60000];
      const maxAttempts = 3;
      
      if (attempts.count >= maxAttempts) {
        // After 3 attempts, block for 1 minute and suggest password recovery
        const blockTime = 60000; // 1 minute
        const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
        
        if (timeSinceLastAttempt < blockTime) {
          const remainingTime = Math.ceil((blockTime - timeSinceLastAttempt) / 1000);
          
          return res.status(429).json({
            success: false,
            message: `Too many login attempts. Please wait ${remainingTime} seconds or use password recovery.`,
            blockTime: blockTime,
            remainingTime: remainingTime,
            suggestPasswordRecovery: true
          });
        } else {
          // Reset after block time expires
          attempts.count = 0;
        }
      } else if (attempts.count > 0) {
        // Apply progressive delay based on attempt count
        const delayIndex = Math.min(attempts.count - 1, delays.length - 1);
        const delayTime = delays[delayIndex];
        const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
        
        if (timeSinceLastAttempt < delayTime) {
          const remainingTime = Math.ceil((delayTime - timeSinceLastAttempt) / 1000);
          
          return res.status(429).json({
            success: false,
            message: `Please wait ${remainingTime} seconds before trying again.`,
            blockTime: delayTime,
            remainingTime: remainingTime,
            attemptCount: attempts.count,
            maxAttempts: maxAttempts
          });
        }
      }
      
      // Call authService.login - FIXED: Use authService for login logic
      let result;
      if (validator.isEmail(identifier)) {
        result = await authService.login(identifier.toLowerCase().trim(), password);
      } else {
        // For username login, we need to find the user first to get email
        const user = await User.findOne({ 
          where: { 
            username: identifier.trim(),
            isActive: true 
          } 
        });
        
        if (!user) {
          // Record failed attempt
          attempts.count++;
          attempts.lastAttempt = Date.now();
          loginAttemptsStore.set(attemptKey, attempts);
          
          return res.status(401).json({
            success: false,
            message: 'Invalid credentials',
            attemptCount: attempts.count,
            maxAttempts: maxAttempts
          });
        }
        
        result = await authService.login(user.email, password);
      }

      // SUCCESSFUL LOGIN - Reset attempts for this identifier
      loginAttemptsStore.delete(attemptKey);

      // Log successful login
      logger.info(`User logged in successfully: ${result.user.email}`, { 
        userId: result.user.id,
        username: result.user.username 
      });

      // Return JSON response with user and tokens
      return res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: result.user,
          tokens: result.tokens
        }
      });
    } catch (error) {
      logger.error('Login controller error:', {
        error: error.message,
        stack: error.stack,
        identifier: req.body.identifier
      });
      
      // Handle specific error cases
      if (error.message.includes('Invalid credentials') || 
          error.message.includes('Account is deactivated')) {
        return res.status(401).json({
          success: false,
          message: error.message
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required'
        });
      }

      // Validate refresh token format
      if (typeof refreshToken !== 'string' || refreshToken.length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Invalid refresh token format'
        });
      }

      // Check JWT_SECRET configuration
      if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
        logger.error('JWT_SECRET is missing or empty');
        return res.status(500).json({
          success: false,
          message: 'Server configuration error'
        });
      }

      const result = await authService.refreshToken(refreshToken);

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          user: result.user,
          tokens: result.tokens,
        },
      });
    } catch (error) {
      logger.error('Refresh token controller error:', error);
      
      // Handle invalid refresh token
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired refresh token"
        });
      }
      
      // Handle JWT signing errors
      if (error.message.includes('secret') || error.message.includes('sign')) {
        return res.status(500).json({
          success: false,
          message: 'Server configuration error'
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async logout(req, res, next) {
    try {
      const accessToken = req.headers.authorization?.split(' ')[1];
      const { refreshToken } = req.body;

      // Validate tokens
      if (!accessToken && !refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'At least one token is required for logout'
        });
      }

      await authService.logout(accessToken, refreshToken);

      // Log successful logout
      logger.info('User logged out successfully', { userId: req.user?.id });

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      logger.error('Logout controller error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async verifyEmail(req, res, next) {
    try {
      const { token } = req.query;

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Verification token is required'
        });
      }

      // Validate token format
      if (typeof token !== 'string' || token.length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Invalid verification token format'
        });
      }

      const user = await authService.verifyEmail(token);

      // Log successful verification
      logger.info(`Email verified for user: ${user.email}`, { userId: user.id });

      res.json({
        success: true,
        message: 'Email verified successfully',
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      logger.error('Verify email controller error:', error);
      
      // Handle invalid or expired token
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification token"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async requestPasswordReset(req, res, next) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      await authService.requestPasswordReset(email);

      // Log password reset request
      logger.info(`Password reset requested for: ${email}`);

      res.json({
        success: true,
        message: 'Password reset instructions sent to your email',
      });
    } catch (error) {
      logger.error('Request password reset controller error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async resetPassword(req, res, next) {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Token and new password are required'
        });
      }

      // Validate token format
      if (typeof token !== 'string' || token.length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Invalid reset token format'
        });
      }

      // Only require minimum length
      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters long'
        });
      }

      await authService.resetPassword(token, newPassword);

      // Log successful password reset
      logger.info('Password reset successful');

      res.json({
        success: true,
        message: 'Password reset successful',
      });
    } catch (error) {
      logger.error('Reset password controller error:', error);
      
      // Handle invalid or expired token
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired reset token"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async validateToken(req, res, next) {
    try {
      const token = req.headers.authorization?.split(' ')[1];

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Token is required'
        });
      }

      // Check JWT_SECRET configuration
      if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
        logger.error('JWT_SECRET is missing or empty');
        return res.status(500).json({
          success: false,
          data: {
            valid: false,
            error: 'Server configuration error'
          }
        });
      }

      const decoded = await authService.validateToken(token);

      res.json({
        success: true,
        data: {
          valid: true,
          decoded,
        },
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        data: {
          valid: false,
          error: error.message,
        },
      });
    }
  }

  async getCurrentUser(req, res, next) {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized"
        });
      }

      // Create sanitized user object with avatar
      const sanitizedUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar || null,
        bio: user.bio || null,
        phone: user.phone || null,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
        isVerified: user.isVerified || false,
        status: user.status || 'offline',
        lastSeen: user.lastSeen,
        settings: user.settings || {},
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };

      res.json({
        success: true,
        data: {
          user: sanitizedUser
        }
      });
    } catch (error) {
      logger.error('Get current user controller error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('invalid token')) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
  
  // ============================================================================
  // HELPER METHOD: Clean up old login attempts (for memory management)
  // ============================================================================
  static cleanupOldAttempts() {
    const now = Date.now();
    const oneHourAgo = now - 3600000; // 1 hour
    
    for (const [key, attempt] of loginAttemptsStore.entries()) {
      if (attempt.lastAttempt < oneHourAgo) {
        loginAttemptsStore.delete(key);
      }
    }
    
    logger.info(`Cleaned up old login attempts. Remaining: ${loginAttemptsStore.size}`);
  }
}

// Start periodic cleanup of old login attempts
setInterval(() => {
  AuthController.cleanupOldAttempts();
}, 3600000); // Run every hour

module.exports = new AuthController();