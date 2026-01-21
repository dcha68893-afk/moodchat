// src/routes/auth.js - UPDATED FOR RENDER POSTGRESQL
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const router = express.Router();

console.log('✅ Auth routes initialized');

// JWT configuration from .env
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'default-secret';
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// Password validation from .env
const PASSWORD_MIN_LENGTH = parseInt(process.env.PASSWORD_MIN_LENGTH) || 6;
const PASSWORD_REQUIRE_UPPERCASE = process.env.PASSWORD_REQUIRE_UPPERCASE === 'true';
const PASSWORD_REQUIRE_LOWERCASE = process.env.PASSWORD_REQUIRE_LOWERCASE === 'true';
const PASSWORD_REQUIRE_NUMBERS = process.env.PASSWORD_REQUIRE_NUMBERS === 'true';
const PASSWORD_REQUIRE_SYMBOLS = process.env.PASSWORD_REQUIRE_SYMBOLS === 'true';

// Environment
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

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

// Password validation helper function
function validatePassword(password) {
  const errors = [];
  
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  
  if (PASSWORD_REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (PASSWORD_REQUIRE_LOWERCASE && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (PASSWORD_REQUIRE_NUMBERS && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (PASSWORD_REQUIRE_SYMBOLS && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  return errors;
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

      // Validate password using .env rules
      const passwordErrors = validatePassword(password);
      if (passwordErrors.length > 0) {
        throw new ValidationError(passwordErrors.join(', '));
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        throw new ValidationError('Invalid email format');
      }

      // Check if models are available from app.locals
      const models = req.app.locals.models;
      if (!models || !models.User) {
        throw new Error('Database models not available');
      }

      const UserModel = models.User;
      const { Op } = models.sequelize.Sequelize;

      const existingUser = await UserModel.findOne({
        where: {
          [Op.or]: [
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

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user
      const user = await UserModel.create({
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        password: hashedPassword,
        firstName: firstName || null,
        lastName: lastName || null,
        avatar: avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`,
        status: 'offline',
        isActive: true,
        isVerified: false,
      });

      const accessToken = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        JWT_SECRET,
        { expiresIn: JWT_ACCESS_EXPIRES_IN }
      );

      const refreshToken = jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: JWT_REFRESH_EXPIRES_IN }
      );

      // Create token record if Token model exists
      if (models.Token) {
        await models.Token.create({
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
        secure: IS_PRODUCTION,
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

      // Check if models are available from app.locals
      const models = req.app.locals.models;
      if (!models || !models.User) {
        throw new Error('Database models not available');
      }

      const UserModel = models.User;
      const { Op } = models.sequelize.Sequelize;

      const user = await UserModel.findOne({
        where: {
          [Op.or]: [
            { email: identifier.toLowerCase() },
            { username: identifier.toLowerCase() }
          ]
        }
      });

      if (!user) {
        throw new AuthenticationError('Invalid credentials');
      }

      // Validate password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        throw new AuthenticationError('Invalid credentials');
      }

      const accessToken = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        JWT_SECRET,
        { expiresIn: JWT_ACCESS_EXPIRES_IN }
      );

      const refreshToken = jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: JWT_REFRESH_EXPIRES_IN }
      );

      // Create token record if Token model exists
      if (models.Token) {
        await models.Token.create({
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
        secure: IS_PRODUCTION,
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

      // Check if models are available from app.locals
      const models = req.app.locals.models;
      if (!models || !models.Token) {
        throw new Error('Token model not available');
      }

      const TokenModel = models.Token;
      const { Op } = models.sequelize.Sequelize;

      const tokenRecord = await TokenModel.findOne({
        where: {
          token: refreshToken,
          type: 'refresh',
          expiresAt: { [Op.gt]: new Date() }
        }
      });

      if (!tokenRecord) {
        throw new AuthenticationError('Invalid or expired refresh token');
      }

      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      
      const UserModel = models.User;
      const user = await UserModel.findByPk(decoded.id);

      if (!user) {
        throw new AuthenticationError('User not found');
      }

      const newAccessToken = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        JWT_SECRET,
        { expiresIn: JWT_ACCESS_EXPIRES_IN }
      );

      const newRefreshToken = jwt.sign(
        { id: user.id },
        JWT_SECRET,
        { expiresIn: JWT_REFRESH_EXPIRES_IN }
      );

      await tokenRecord.update({
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: IS_PRODUCTION,
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

      // Check if models are available from app.locals
      const models = req.app.locals.models;
      if (refreshToken && models && models.Token) {
        await models.Token.destroy({
          where: { token: refreshToken, type: 'refresh' }
        });
      }

      // Update user status
      if (models && models.User && req.user) {
        const user = await models.User.findByPk(req.user.id);
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
      // Check if models are available from app.locals
      const models = req.app.locals.models;
      if (!models || !models.User) {
        throw new Error('Database models not available');
      }

      const UserModel = models.User;

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

// Test database connection endpoint
router.get('/test-db', asyncHandler(async (req, res) => {
  try {
    const models = req.app.locals.models;
    if (!models) {
      throw new Error('Models not available');
    }
    
    // Test User model
    const userCount = await models.User.count();
    
    res.status(200).json({
      status: 'success',
      message: 'Database connection test successful',
      data: {
        userCount,
        database: 'PostgreSQL (Render)',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Database connection test failed',
      error: error.message
    });
  }
}));

module.exports = router;