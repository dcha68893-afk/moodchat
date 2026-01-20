// src/routes/auth.js - COMPLETE FIXED VERSION
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const router = express.Router();
const { Users, Tokens } = require('../models'); // CHANGED: 'User' → 'Users', 'Token' → 'Tokens'
const config = require('../config/index');

console.log('✅ Auth routes initialized');

// IMPORT MIDDLEWARE WITH CORRECT NAMES
let authenticate, apiLimiter, authLimiter;
let AuthenticationError, ValidationError, ConflictError;

try {
  // Import auth middleware
  const authMiddleware = require('../middleware/auth');
  if (authMiddleware && authMiddleware.authenticate) {
    authenticate = authMiddleware.authenticate;
  }
} catch (error) {
  console.warn('⚠️  Could not load auth middleware:', error.message);
  authenticate = (req, res, next) => next(); // Fallback
}

try {
  // Import rate limiter middleware
  const rateLimiterMiddleware = require('../middleware/rateLimiter');
  if (rateLimiterMiddleware) {
    authLimiter = rateLimiterMiddleware.authLimiter || ((req, res, next) => next());
    apiLimiter = rateLimiterMiddleware.apiRateLimiter || rateLimiterMiddleware.apiLimiter || ((req, res, next) => next());
  }
} catch (error) {
  console.warn('⚠️  Could not load rate limiter middleware:', error.message);
  authLimiter = (req, res, next) => next();
  apiLimiter = (req, res, next) => next();
}

try {
  // Import error classes
  const errorHandler = require('../middleware/errorHandler');
  if (errorHandler) {
    AuthenticationError = errorHandler.AuthenticationError;
    ValidationError = errorHandler.ValidationError;
    ConflictError = errorHandler.ConflictError;
  }
} catch (error) {
  console.warn('⚠️  Could not load error handler middleware:', error.message);
  // Create fallback error classes
  class AuthenticationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AuthenticationError';
      this.statusCode = 401;
    }
  }
  class ValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ValidationError';
      this.statusCode = 400;
    }
  }
  class ConflictError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ConflictError';
      this.statusCode = 409;
    }
  }
}

// Health endpoint
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Auth service is healthy',
    timestamp: new Date().toISOString(),
  });
});

// Register endpoint - FIXED: Using authLimiter (not authRateLimiter)
router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { username, email, password, firstName, lastName, avatar } = req.body;

      if (!username || !email || !password) {
        throw new ValidationError('Username, email and password are required');
      }

      if (username.length < 3 || username.length > 30) {
        throw new ValidationError('Username must be between 3 and 30 characters');
      }

      if (password.length < 6) {
        throw new ValidationError('Password must be at least 6 characters');
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        throw new ValidationError('Invalid email format');
      }

      // Check if models are available
      const models = req.app.locals.models;
      if (!models || !models.Users) { // CHANGED: 'User' → 'Users'
        throw new Error('Database models not available');
      }

      const UserModel = models.Users; // CHANGED: 'User' → 'Users'

      const existingUser = await UserModel.findOne({
        where: {
          [require('sequelize').Op.or]: [
            { username: username.toLowerCase() },
            { email: email.toLowerCase() }
          ]
        }
      });

      if (existingUser) {
        if (existingUser.username === username.toLowerCase()) {
          throw new ConflictError('Username already taken');
        } else {
          throw new ConflictError('Email already registered');
        }
      }

      // Create user - password will be hashed by User model hooks
      const user = await UserModel.create({
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        password: password, // Will be hashed by beforeCreate hook
        firstName: firstName || null,
        lastName: lastName || null,
        avatar: avatar || null,
        status: 'offline',
        isActive: true,
        isVerified: false,
      });

      const accessToken = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        config.jwt.secret || 'default-secret',
        { expiresIn: config.jwt.accessExpiresIn || '15m' }
      );

      const refreshToken = jwt.sign(
        { id: user.id },
        config.jwt.secret || 'default-secret',
        { expiresIn: config.jwt.refreshExpiresIn || '7d' }
      );

      // Create token record if Token model exists
      if (models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        await models.Tokens.create({ // CHANGED: 'Token' → 'Tokens'
          userId: user.id,
          token: refreshToken,
          type: 'refresh',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
      }

      const userResponse = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        status: user.status,
        lastSeen: user.lastSeen,
        createdAt: user.createdAt,
      };

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.status(201).json({
        status: 'success',
        message: 'User registered successfully',
        data: {
          user: userResponse,
          accessToken,
          refreshToken,
        },
      });
    } catch (error) {
      console.error('Error registering user:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to register user'
      });
    }
  })
);

// Login endpoint - FIXED: Using authLimiter (not authRateLimiter)
router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { identifier, password } = req.body;

      if (!identifier || !password) {
        throw new ValidationError('Identifier and password are required');
      }

      // Check if models are available
      const models = req.app.locals.models;
      if (!models || !models.Users) { // CHANGED: 'User' → 'Users'
        throw new Error('Database models not available');
      }

      const UserModel = models.Users; // CHANGED: 'User' → 'Users'

      const user = await UserModel.findOne({
        where: {
          [require('sequelize').Op.or]: [
            { email: identifier.toLowerCase() },
            { username: identifier.toLowerCase() }
          ]
        }
      });

      if (!user) {
        throw new AuthenticationError('Invalid credentials');
      }

      // Validate password using User model method
      const isValidPassword = await user.validatePassword(password);
      if (!isValidPassword) {
        throw new AuthenticationError('Invalid credentials');
      }

      const accessToken = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        config.jwt.secret || 'default-secret',
        { expiresIn: config.jwt.accessExpiresIn || '15m' }
      );

      const refreshToken = jwt.sign(
        { id: user.id },
        config.jwt.secret || 'default-secret',
        { expiresIn: config.jwt.refreshExpiresIn || '7d' }
      );

      // Create token record if Token model exists
      if (models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        await models.Tokens.create({ // CHANGED: 'Token' → 'Tokens'
          userId: user.id,
          token: refreshToken,
          type: 'refresh',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
      }

      // Update user status
      await user.update({
        status: 'online',
        lastSeen: new Date(),
      });

      const userResponse = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        status: user.status,
        lastSeen: user.lastSeen,
        createdAt: user.createdAt,
      };

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.status(200).json({
        status: 'success',
        message: 'Login successful',
        data: {
          user: userResponse,
          accessToken,
          refreshToken,
        },
      });
    } catch (error) {
      console.error('Error logging in:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to login'
      });
    }
  })
);

// Refresh token endpoint
router.post(
  '/refresh-token',
  asyncHandler(async (req, res) => {
    try {
      const { refreshToken } = req.cookies || req.body;

      if (!refreshToken) {
        throw new AuthenticationError('Refresh token required');
      }

      // Check if models are available
      const models = req.app.locals.models;
      if (!models || !models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        throw new Error('Token model not available');
      }

      const TokenModel = models.Tokens; // CHANGED: 'Token' → 'Tokens'

      const tokenRecord = await TokenModel.findOne({
        where: {
          token: refreshToken,
          type: 'refresh',
          expiresAt: { [require('sequelize').Op.gt]: new Date() }
        }
      });

      if (!tokenRecord) {
        throw new AuthenticationError('Invalid or expired refresh token');
      }

      const decoded = jwt.verify(refreshToken, config.jwt.secret || 'default-secret');
      
      const UserModel = models.Users; // CHANGED: 'User' → 'Users'
      const user = await UserModel.findByPk(decoded.id);

      if (!user) {
        throw new AuthenticationError('User not found');
      }

      const newAccessToken = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        config.jwt.secret || 'default-secret',
        { expiresIn: config.jwt.accessExpiresIn || '15m' }
      );

      const newRefreshToken = jwt.sign(
        { id: user.id },
        config.jwt.secret || 'default-secret',
        { expiresIn: config.jwt.refreshExpiresIn || '7d' }
      );

      await tokenRecord.update({
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.status(200).json({
        status: 'success',
        message: 'Token refreshed successfully',
        data: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        },
      });
    } catch (error) {
      console.error('Error refreshing token:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to refresh token'
      });
    }
  })
);

// Logout endpoint
router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    try {
      const { refreshToken } = req.cookies || req.body;

      // Check if models are available
      const models = req.app.locals.models;
      if (refreshToken && models && models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        await models.Tokens.destroy({ // CHANGED: 'Token' → 'Tokens'
          where: { token: refreshToken, type: 'refresh' }
        });
      }

      // Update user status
      if (models && models.Users && req.user) { // CHANGED: 'User' → 'Users'
        const user = await models.Users.findByPk(req.user.id); // CHANGED: 'User' → 'Users'
        if (user) {
          await user.update({
            status: 'offline',
          });
        }
      }

      res.clearCookie('refreshToken');

      res.status(200).json({
        status: 'success',
        message: 'Logged out successfully',
      });
    } catch (error) {
      console.error('Error logging out:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to logout'
      });
    }
  })
);

// Profile endpoint - FIXED: Using apiLimiter (not apiRateLimiter)
router.get(
  '/me',
  authenticate,
  apiLimiter,
  asyncHandler(async (req, res) => {
    try {
      // Check if models are available
      const models = req.app.locals.models;
      if (!models || !models.Users) { // CHANGED: 'User' → 'Users'
        throw new Error('Database models not available');
      }

      const UserModel = models.Users; // CHANGED: 'User' → 'Users'

      const user = await UserModel.findByPk(req.user.id, {
        attributes: { 
          exclude: ['password'] 
        }
      });

      if (!user) {
        throw new AuthenticationError('User not found');
      }

      res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (error) {
      console.error('Error fetching user profile:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to fetch user profile'
      });
    }
  })
);

module.exports = router;