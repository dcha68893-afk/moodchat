// src/routes/auth.js - THIS FILE IS A ROUTER — NOT A SEQUELIZE MODEL
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const router = express.Router();

console.log('✅ Auth ROUTER initialized (NOT a Sequelize model)');
console.log('✅ POST /login route available at /api/auth/login');
console.log('✅ POST /register route available at /api/auth/register');

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

// IMPORT MODELS SAFELY FROM MODELS/INDEX.JS
let db;
try {
  db = require('../models');
  if (!db || !db.models) {
    throw new Error('Models not properly loaded from models/index.js');
  }
  console.log('✅ Database models loaded in auth router');
} catch (error) {
  console.error('❌ Failed to load database models in auth router:', error.message);
  process.exit(1);
}

// IMPORT MIDDLEWARE WITH ERROR HANDLING
let authenticate, apiLimiter, authLimiter;
let AuthenticationError, ValidationError, ConflictError;

try {
  const authMiddleware = require('../middleware/auth');
  if (authMiddleware && authMiddleware.authenticate) {
    authenticate = authMiddleware.authenticate;
    console.log('✅ Auth middleware loaded in auth.js');
  } else {
    console.warn('⚠️ Auth middleware exists but authenticate method not found');
    authenticate = (req, res, next) => next();
  }
} catch (error) {
  console.warn('⚠️ Could not load auth middleware:', error.message);
  authenticate = (req, res, next) => next();
}

try {
  const rateLimiterMiddleware = require('../middleware/rateLimiter');
  if (rateLimiterMiddleware) {
    authLimiter = rateLimiterMiddleware.authLimiter || ((req, res, next) => next());
    apiLimiter = rateLimiterMiddleware.apiRateLimiter || rateLimiterMiddleware.apiLimiter || ((req, res, next) => next());
    console.log('✅ Rate limiter middleware loaded in auth.js');
  }
} catch (error) {
  console.warn('⚠️ Could not load rate limiter middleware:', error.message);
  authLimiter = (req, res, next) => next();
  apiLimiter = (req, res, next) => next();
}

try {
  const errorHandler = require('../middleware/errorHandler');
  if (errorHandler) {
    AuthenticationError = errorHandler.AuthenticationError;
    ValidationError = errorHandler.ValidationError;
    ConflictError = errorHandler.ConflictError;
    console.log('✅ Error handler middleware loaded in auth.js');
  }
} catch (error) {
  console.warn('⚠️ Could not load error handler middleware:', error.message);
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

// ===== HEALTH ENDPOINT =====
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Auth service is healthy',
    timestamp: new Date().toISOString(),
    routes: {
      login: 'POST /login',
      register: 'POST /register',
      refreshToken: 'POST /refresh-token',
      logout: 'POST /logout',
      me: 'GET /me',
      testDb: 'GET /test-db'
    }
  });
});

// ===== REGISTER ENDPOINT - USING Users MODEL =====
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
      const models = db.models;
      const dbConnected = req.app.locals.dbConnected || false;
      
      if (!dbConnected) {
        return res.status(503).json({
          success: false,
          message: 'Database not available. Registration requires PostgreSQL connection.',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Get Users model (using Users, not User)
      const UsersModel = models.Users;
      if (!UsersModel) {
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
          timestamp: new Date().toISOString()
        });
      }

      // 4. Check if user exists by email
      const existingUserByEmail = await UsersModel.findOne({ 
        where: { email: email.toLowerCase() } 
      });
      
      if (existingUserByEmail) {
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists',
          timestamp: new Date().toISOString()
        });
      }

      // 5. Check if user exists by username
      const existingUserByUsername = await UsersModel.findOne({ 
        where: { username: username } 
      });
      
      if (existingUserByUsername) {
        return res.status(400).json({
          success: false,
          message: 'Username already taken',
          timestamp: new Date().toISOString()
        });
      }

      // 6. Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // 7. Create user in Users table
      const user = await UsersModel.create({
        email: email.toLowerCase(),
        username: username,
        password: hashedPassword,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`,
        status: 'offline',
        isActive: true,
        isVerified: false,
        role: 'user'
      });

      // 8. Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          username: user.username,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // 9. Return success response
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          status: user.status,
          role: user.role,
          isVerified: user.isVerified,
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

// ===== LOGIN ENDPOINT - USING Users MODEL =====
router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { identifier, password } = req.body;

      // 1. Validate required fields
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email/username) and password are required',
          timestamp: new Date().toISOString()
        });
      }

      // 2. Check database connection
      const models = db.models;
      const dbConnected = req.app.locals.dbConnected || false;
      
      if (!dbConnected) {
        return res.status(503).json({
          success: false,
          message: 'Database not available. Please try again later.',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Get Users model
      const UsersModel = models.Users;
      if (!UsersModel) {
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
          timestamp: new Date().toISOString()
        });
      }

      // 4. Find user by email or username
      let user;
      if (identifier.includes('@')) {
        // Search by email
        user = await UsersModel.findOne({ 
          where: { 
            email: identifier.toLowerCase().trim(),
            isActive: true
          } 
        });
      } else {
        // Search by username
        user = await UsersModel.findOne({ 
          where: { 
            username: identifier.trim(),
            isActive: true
          } 
        });
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
          username: user.username,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // 9. Update user's last seen and status
      await user.update({
        lastSeen: new Date(),
        status: 'online'
      });

      // 10. Return success response
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status,
          role: user.role,
          isVerified: user.isVerified,
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

// ===== SUPPORTING AUTH ROUTES =====

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
      const models = db.models;
      if (!models || !models.Token) {
        throw new Error('Token model not available');
      }

      const TokenModel = models.Token;
      const { Op } = db.sequelize.Sequelize;

      const tokenRecord = await TokenModel.findOne({
        where: {
          token: refreshToken,
          tokenType: 'refresh',
          isRevoked: false,
          expiresAt: { [Op.gt]: new Date() }
        }
      });

      if (!tokenRecord) {
        throw new AuthenticationError('Invalid or expired refresh token');
      }

      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      
      const UsersModel = models.Users;
      const user = await UsersModel.findByPk(decoded.userId);

      if (!user) {
        throw new AuthenticationError('User not found');
      }

      // Generate new access token
      const newAccessToken = jwt.sign(
        { 
          userId: user.id, 
          username: user.username, 
          email: user.email,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: JWT_ACCESS_EXPIRES_IN }
      );

      // Generate new refresh token
      const newRefreshToken = jwt.sign(
        { userId: user.id },
        JWT_SECRET,
        { expiresIn: JWT_REFRESH_EXPIRES_IN }
      );

      // Update refresh token in database
      await tokenRecord.update({
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      // Set cookie
      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: IS_PRODUCTION,
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error refreshing token:', error);
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to refresh token',
        timestamp: new Date().toISOString()
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
      const models = db.models;
      if (refreshToken && models && models.Token) {
        // Revoke the refresh token
        const tokenRecord = await models.Token.findOne({
          where: { token: refreshToken, tokenType: 'refresh' }
        });
        
        if (tokenRecord) {
          await tokenRecord.update({ isRevoked: true });
        }
      }

      // Update user status
      if (models && models.Users && req.user) {
        const user = await models.Users.findByPk(req.user.userId);
        if (user) {
          await user.update({
            status: 'offline',
            lastSeen: new Date()
          });
        }
      }

      // Clear cookie
      res.clearCookie('refreshToken');

      res.status(200).json({
        success: true,
        message: 'Logged out successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error logging out:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to logout',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// Profile endpoint
router.get(
  '/me',
  authenticate,
  apiLimiter,
  asyncHandler(async (req, res) => {
    try {
      // Check if models are available from app.locals
      const models = db.models;
      if (!models || !models.Users) {
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
          timestamp: new Date().toISOString()
        });
      }

      const UsersModel = models.Users;

      const user = await UsersModel.findByPk(req.user.userId, {
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
        success: true,
        data: { user },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching user profile:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch user profile',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// Test database connection endpoint
router.get('/test-db', asyncHandler(async (req, res) => {
  try {
    const models = db.models;
    if (!models) {
      throw new Error('Models not available');
    }
    
    // Test Users model
    const userCount = await models.Users.count();
    
    // Test Messages model if exists
    let messageCount = 0;
    if (models.Message) {
      messageCount = await models.Message.count();
    }
    
    res.status(200).json({
      success: true,
      message: 'Database connection test successful',
      data: {
        userCount,
        messageCount,
        database: 'PostgreSQL (Render)',
        timestamp: new Date().toISOString(),
        modelsAvailable: Object.keys(models).filter(key => 
          key !== 'sequelize' && key !== 'Sequelize' && key !== 'syncTables' && key !== 'testConnection'
        )
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Database connection test failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}));

// ===== ADDITIONAL AUTH ENDPOINTS =====

// Verify token endpoint
router.post('/verify-token', asyncHandler(async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required',
        timestamp: new Date().toISOString()
      });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Check if user still exists
      const models = db.models;
      if (models && models.Users) {
        const user = await models.Users.findByPk(decoded.userId, {
          attributes: { exclude: ['password'] }
        });
        
        if (!user || !user.isActive) {
          return res.status(401).json({
            success: false,
            message: 'User not found or inactive',
            timestamp: new Date().toISOString()
          });
        }
        
        return res.status(200).json({
          success: true,
          message: 'Token is valid',
          user: user,
          expiresIn: decoded.exp - Math.floor(Date.now() / 1000),
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Token is valid',
        user: decoded,
        expiresIn: decoded.exp - Math.floor(Date.now() / 1000),
        timestamp: new Date().toISOString()
      });
      
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        error: jwtError.message,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify token',
      timestamp: new Date().toISOString()
    });
  }
}));

// Change password endpoint
router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password and new password are required',
          timestamp: new Date().toISOString()
        });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 6 characters',
          timestamp: new Date().toISOString()
        });
      }
      
      const models = db.models;
      if (!models || !models.Users) {
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      const UsersModel = models.Users;
      const user = await UsersModel.findByPk(req.user.userId);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }
      
      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect',
          timestamp: new Date().toISOString()
        });
      }
      
      // Hash and update password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await user.update({ password: hashedPassword });
      
      res.status(200).json({
        success: true,
        message: 'Password changed successfully',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to change password',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// CRITICAL: Export the router ONLY - MUST BE EXPORTED AS EXPRESS ROUTER
module.exports = router;