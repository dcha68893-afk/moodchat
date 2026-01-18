
const authService = require('../services/authService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const validator = require('validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { User, Token, LoginAttempt } = require('../models');

// In-memory store for login attempts
const loginAttemptsStore = new Map();

class AuthController {
  async register(req, res, next) {
    try {
      console.log("📝 [AuthController] Registration request received");
      console.log("Request body:", { 
        username: req.body.username, 
        email: req.body.email,
        hasPassword: !!req.body.password 
      });
      
      const { username, email, password, firstName, lastName } = req.body;

      // Validate all required fields
      if (!email || !password || !username) {
        return res.status(400).json({
          success: false,
          message: 'Email, username, and password are required'
        });
      }

      // Validate password is not empty
      if (!password || password.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Password cannot be empty'
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      console.log("🔧 [AuthController] Calling authService.register...");

      // Call authService.register
      const result = await authService.register({
        username: username.trim(),
        email: email.toLowerCase().trim(),
        password: password,
        firstName: firstName,
        lastName: lastName
      });

      console.log("✅ [AuthController] Registration successful for user:", result.user.id);

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
      console.error('❌ [AuthController] Registration error:', error.message);
      console.error('Error stack:', error.stack);
      
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
      if (error.message.includes('Validation error') || 
          error.message.includes('Invalid email') ||
          error.message.includes('Password cannot be empty')) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }
      
      // Handle database errors
      if (error.message.includes('Database error') || 
          error.name === 'SequelizeDatabaseError' || 
          error.name === 'SequelizeUniqueConstraintError') {
        return res.status(500).json({
          success: false,
          message: 'Database error occurred. Please try again.'
        });
      }
      
      // Default internal server error
      return res.status(500).json({
        success: false,
        message: 'Internal server error: ' + error.message
      });
    }
  }

  async login(req, res, next) {
    try {
      console.log("📝 [AuthController] Login request received");
      console.log("Request body:", { 
        identifier: req.body.identifier,
        hasPassword: !!req.body.password 
      });
      
      const { identifier, password } = req.body;

      // Validate required fields
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email or username) and password are required'
        });
      }

      // Rate limiting for login attempts
      const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      const attemptKey = `${identifier}_${clientIp}`;
      
      let attempts = loginAttemptsStore.get(attemptKey) || { count: 0, lastAttempt: null };
      const maxAttempts = 5;
      
      if (attempts.count >= maxAttempts) {
        const blockTime = 15 * 60 * 1000; // 15 minutes
        const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
        
        if (timeSinceLastAttempt < blockTime) {
          const remainingTime = Math.ceil((blockTime - timeSinceLastAttempt) / 1000 / 60); // in minutes
          
          return res.status(429).json({
            success: false,
            message: `Too many login attempts. Please wait ${remainingTime} minutes before trying again.`,
            blockTime: blockTime,
            remainingTime: remainingTime
          });
        } else {
          // Reset after block time expires
          attempts.count = 0;
        }
      }

      console.log("🔧 [AuthController] Calling authService.login...");

      // Call authService.login (which now uses validatePassword internally)
      let result;
      if (validator.isEmail(identifier)) {
        result = await authService.login(identifier.toLowerCase().trim(), password);
      } else {
        // For username login
        result = await authService.login(identifier.trim(), password);
      }

      // Reset attempts on successful login
      loginAttemptsStore.delete(attemptKey);

      console.log("✅ [AuthController] Login successful for user:", result.user.id);

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
      console.error('❌ [AuthController] Login error:', error.message);
      
      // Handle specific error cases
      if (error.message.includes('Invalid credentials') || 
          error.message.includes('Account is deactivated')) {
        
        // Increment failed attempts
        const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const attemptKey = `${req.body.identifier}_${clientIp}`;
        let attempts = loginAttemptsStore.get(attemptKey) || { count: 0, lastAttempt: null };
        attempts.count++;
        attempts.lastAttempt = Date.now();
        loginAttemptsStore.set(attemptKey, attempts);
        
        return res.status(401).json({
          success: false,
          message: error.message,
          attemptCount: attempts.count,
          maxAttempts: 5
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
      console.error('Refresh token controller error:', error);
      
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired refresh token"
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

      if (!accessToken && !refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'At least one token is required for logout'
        });
      }

      await authService.logout(accessToken, refreshToken);

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      console.error('Logout controller error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
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
      console.error('Get current user controller error:', error);
      
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
  
  // Helper method to clean up old login attempts
  static cleanupOldAttempts() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    
    for (const [key, attempt] of loginAttemptsStore.entries()) {
      if (attempt.lastAttempt < oneHourAgo) {
        loginAttemptsStore.delete(key);
      }
    }
    
    console.log(`🧹 [AuthController] Cleaned up old login attempts. Remaining: ${loginAttemptsStore.size}`);
  }
}

// Start periodic cleanup of old login attempts
setInterval(() => {
  AuthController.cleanupOldAttempts();
}, 3600000);

module.exports = new AuthController();
