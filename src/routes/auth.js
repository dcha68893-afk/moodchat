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

// Health endpoint - RELATIVE PATH: /health (becomes /api/auth/health when mounted)
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Auth service is healthy',
    timestamp: new Date().toISOString(),
  });
});

// Register endpoint - RELATIVE PATH: /register (becomes /api/auth/register when mounted)
router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { username, email, password } = req.body;

      // 1. Validate required fields
      if (!email || !username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email, username, and password are required',
          timestamp: new Date().toISOString()
        });
      }

      // 2. Check database connection
      const models = req.app.locals.models;
      const dbConnected = req.app.locals.dbConnected || false;
      
      if (!dbConnected) {
        return res.status(503).json({
          success: false,
          message: 'Database not available. Registration requires PostgreSQL connection.',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Get User model
      const UserModel = models.User || models.Users;
      if (!UserModel) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }

      // 4. Check if user exists
      const existingUser = await UserModel.findOne({ 
        where: { email: email.toLowerCase() } 
      });
      
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User already exists',
          timestamp: new Date().toISOString()
        });
      }

      // 5. Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // 6. Create user
      const user = await UserModel.create({
        email: email.toLowerCase(),
        username: username,
        password: hashedPassword,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
      });

      // 7. Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          username: user.username 
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // 8. Return success response
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          createdAt: user.createdAt
        },
        timestamp: new Date().toISOString(),
        storage: 'PostgreSQL (Permanent)'
      });
      
    } catch (dbError) {
      console.error('Database registration error:', dbError.message);
      return res.status(500).json({
        success: false,
        message: 'Registration failed - database error',
        error: !IS_PRODUCTION ? dbError.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// Login endpoint - RELATIVE PATH: /login (becomes /api/auth/login when mounted)
router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { email, password } = req.body;

      // 1. Validate required fields
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email and password are required',
          timestamp: new Date().toISOString()
        });
      }

      // 2. Check database connection
      const models = req.app.locals.models;
      const dbConnected = req.app.locals.dbConnected || false;
      
      if (!dbConnected) {
        return res.status(503).json({
          success: false,
          message: 'Database not available. Please try again later.',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Get User model
      const UserModel = models.User || models.Users;
      if (!UserModel) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }

      // 4. Find user by email or username
      let user;
      if (email.includes('@')) {
        user = await UserModel.findOne({ where: { email: email.toLowerCase() } });
      } else {
        user = await UserModel.findOne({ where: { username: email } });
      }

      // 5. If user not found
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          timestamp: new Date().toISOString()
        });
      }

      // 6. Compare passwords
      const validPassword = await bcrypt.compare(password, user.password);
      
      // 7. If password is invalid
      if (!validPassword) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          timestamp: new Date().toISOString()
        });
      }

      // 8. Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          username: user.username 
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // 9. Return success response
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          createdAt: user.createdAt
        },
        timestamp: new Date().toISOString(),
        storage: 'PostgreSQL (Permanent)'
      });
      
    } catch (dbError) {
      console.error('Database login error:', dbError.message);
      return res.status(500).json({
        success: false,
        message: 'Login failed - database error',
        error: !IS_PRODUCTION ? dbError.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// Refresh token endpoint - RELATIVE PATH: /refresh-token
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

// Logout endpoint - RELATIVE PATH: /logout
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

// Profile endpoint - RELATIVE PATH: /me
router.get(
  '/me',
  authenticate,
  apiLimiter,
  asyncHandler(async (req, res) => {
    try {
      // Check if models are available from app.locals
      const models = req.app.locals.models;
      if (!models || !models.User) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }

      const UserModel = models.User;

      const user = await UserModel.findByPk(req.user.id, {
        attributes: { 
          exclude: ['password'] 
        }
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (error) {
      console.error('Error fetching user profile:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user profile'
      });
    }
  })
);

// Test database connection endpoint - RELATIVE PATH: /test-db
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

// Export the router
module.exports = router;