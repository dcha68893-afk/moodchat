// src/routes/auth.js - THIS FILE IS A ROUTER — NOT A SEQUELIZE MODEL
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../services/authService');  // ← ADD THIS

const asyncHandler = require('express-async-handler');

// CRITICAL FIX: Import the shared auth middleware with proper path
let authenticateToken;
try {
  authenticateToken = require('../middleware/auth').authenticateToken;
} catch (error) {
  console.warn('⚠️ Shared auth middleware not found, using local version');
  // Define local middleware as fallback
  authenticateToken = (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader && authHeader.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ 
          success: false, 
          message: 'Access token required',
          errorCode: 'TOKEN_REQUIRED'
        });
      }

      jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).json({ 
            success: false, 
            message: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token',
            errorCode: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'
          });
        }
        
        req.user = {
          userId: decoded.userId || decoded.id || decoded.sub,
          id: decoded.userId || decoded.id || decoded.sub,
          email: decoded.email || null,
          username: decoded.username || null,
          role: decoded.role || 'user'
        };
        
        next();
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Authentication failed',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  };
}

// Create router
const router = express.Router();

// Import database models
const db = require('../models');
const Users = db.User || db.Users;

console.log('✅ Auth ROUTER initialized (NOT a Sequelize model)');

// CRITICAL FIX: Use consistent JWT secret with env var priority
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || '3e78ab2d6cb698f95b3b8d510614058c';
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '24h';
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

// Helper to generate token (consistent with controller)
function generateToken(user) {
  return jwt.sign(
    { 
      userId: user.id, 
      id: user.id,
      email: user.email, 
      username: user.username,
      role: user.role || 'user'
    },
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRES_IN }
  );
}

// ===== HEALTH ENDPOINT =====
router.get('/health', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      success: false,
      message: 'Health check failed'
    });
  }
});

// ===== TEST ENDPOINT =====
router.get('/test', (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Auth router is working correctly',
      timestamp: new Date().toISOString(),
      endpoints: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        me: 'GET /api/auth/me',
        refreshToken: 'POST /api/auth/refresh-token',
        logout: 'POST /api/auth/logout'
      }
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({
      success: false,
      message: 'Test endpoint failed'
    });
  }
});

// ===== REGISTER ENDPOINT =====
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    try {
      const { username, email, password } = req.body;

      console.log('🔧 [AUTH] Register request received:', { username, email: email ? '***@***' : 'missing' });

      // 1. STRICT VALIDATION
      if (!email || !username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: email, username, and password are all required',
          errorCode: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 2. Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
          errorCode: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Validate password
      const passwordErrors = validatePassword(password);
      if (passwordErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Password validation failed',
          errorCode: 'VALIDATION_ERROR',
          errors: passwordErrors,
          timestamp: new Date().toISOString()
        });
      }

      // 4. Check if database models are available
      if (!db || !Users) {
        console.error('🔧 [AUTH] Models not available');
        return res.status(503).json({
          success: false,
          message: 'Database service not initialized',
          errorCode: 'SERVICE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }

      // 5. Get Sequelize instance
      const sequelizeInstance = db.sequelize;
      if (!sequelizeInstance) {
        console.error('🔧 [AUTH] Sequelize instance not available');
        return res.status(500).json({
          success: false,
          message: 'Database configuration error',
          errorCode: 'CONFIGURATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 6. Get Op operator
      const Op = db.Sequelize.Op || require('sequelize').Op;
      if (!Op) {
        console.error('🔧 [AUTH] Op operator not available');
        return res.status(500).json({
          success: false,
          message: 'Database query operator not available',
          errorCode: 'CONFIGURATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 7. Check if user exists
      const existingUser = await Users.findOne({
        where: {
          [Op.or]: [
            { email: email.toLowerCase() },
            { username: username }
          ]
        }
      });
      
      if (existingUser) {
        if (existingUser.email === email.toLowerCase()) {
          return res.status(409).json({
            success: false,
            message: 'User with this email already exists',
            errorCode: 'USER_EXISTS',
            timestamp: new Date().toISOString()
          });
        } else {
          return res.status(409).json({
            success: false,
            message: 'Username already taken',
            errorCode: 'USERNAME_TAKEN',
            timestamp: new Date().toISOString()
          });
        }
      }

   
// 8. Do NOT hash - let model hook handle it
// const hashedPassword = await bcrypt.hash(password, 10); // ← DON'T do this

// 9. Create user with plain password
const user = await Users.create({
  email: email.toLowerCase(),
  username: username,
  password: password,  // Pass plain text - model will hash
  avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`,
  status: 'offline',
  isActive: true,
  isVerified: false,
  role: 'user'
});

      if (!user) {
        return res.status(500).json({
          success: false,
          message: 'Failed to create user',
          errorCode: 'CREATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      console.log('🔧 [AUTH] User created successfully:', user.id);

      // 10. Generate JWT token
      let token;
      try {
        token = generateToken(user);
      } catch (jwtError) {
        console.error('🔧 [AUTH] JWT generation error:', jwtError.message);
        return res.status(500).json({
          success: false,
          message: 'Token generation failed',
          errorCode: 'TOKEN_GENERATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 11. Return success response with consistent format
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        token: token, // Direct token for frontend
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
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('🔧 [AUTH] Registration error:', {
        name: error.name,
        message: error.message
      });

      // Handle specific Sequelize errors
      if (error.name === 'SequelizeConnectionError' || 
          error.name === 'SequelizeDatabaseError' ||
          error.message.includes('timeout') ||
          error.message.includes('connection') ||
          error.message.includes('ECONNREFUSED')) {
        return res.status(503).json({
          success: false,
          message: 'Database service temporarily unavailable',
          errorCode: 'DATABASE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }
      
      // Handle unique constraint errors
      if (error.name === 'SequelizeUniqueConstraintError') {
        const field = error.errors && error.errors[0] ? error.errors[0].path : 'field';
        return res.status(409).json({
          success: false,
          message: field === 'email' ? 'User with this email already exists' : 'Username already taken',
          errorCode: field === 'email' ? 'USER_EXISTS' : 'USERNAME_TAKEN',
          timestamp: new Date().toISOString()
        });
      }
      
      // Handle validation errors
      if (error.name === 'SequelizeValidationError') {
        const errorMessages = error.errors ? error.errors.map(err => err.message) : ['Validation failed'];
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errorCode: 'VALIDATION_ERROR',
          errors: errorMessages,
          timestamp: new Date().toISOString()
        });
      }
      
      // Generic error response
      return res.status(500).json({
        success: false,
        message: 'Registration failed',
        errorCode: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== LOGIN ENDPOINT =====
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    try {
      const { identifier, password } = req.body;

      console.log('🔧 [AUTH] Login request received');

      // 1. VALIDATION
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email/username) and password are required',
          errorCode: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 2. Check if database models are available
      if (!db || !Users) {
        console.error('🔧 [AUTH] Models not available for login');
        return res.status(503).json({
          success: false,
          message: 'Database service not initialized',
          errorCode: 'SERVICE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Find user
      let user;
      try {
        if (identifier.includes('@')) {
          user = await Users.findOne({ 
            where: { 
              email: identifier.toLowerCase().trim(),
              isActive: true
            } 
          });
        } else {
          user = await Users.findOne({ 
            where: { 
              username: identifier.trim(),
              isActive: true
            } 
          });
        }
      } catch (dbError) {
        console.error('🔧 [AUTH] Database query error during login:', dbError.message);
        return res.status(503).json({
          success: false,
          message: 'Database service temporarily unavailable',
          errorCode: 'DATABASE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }

      // 4. If user not found
      if (!user) {
        console.log('🔧 [AUTH] Login failed: User not found');
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password',
          errorCode: 'INVALID_CREDENTIALS',
          timestamp: new Date().toISOString()
        });
      }

      // 5. Compare passwords
      let validPassword;
      try {
        console.log('🔧 [AUTH] Comparing password for user:', user.id);
        validPassword = await bcrypt.compare(password, user.password);
      } catch (bcryptError) {
        console.error('🔧 [AUTH] Password comparison error:', bcryptError.message);
        return res.status(500).json({
          success: false,
          message: 'Authentication failed',
          errorCode: 'AUTHENTICATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }
      
      // 6. If password is invalid
      if (!validPassword) {
        console.log('🔧 [AUTH] Login failed: Invalid password for user:', user.id);
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password',
          errorCode: 'INVALID_CREDENTIALS',
          timestamp: new Date().toISOString()
        });
      }

      // 7. Generate JWT token
      let token;
      try {
        console.log('🔧 [AUTH] Generating JWT token for user:', user.id);
        token = generateToken(user);
      } catch (jwtError) {
        console.error('🔧 [AUTH] JWT generation error during login:', jwtError.message);
        return res.status(500).json({
          success: false,
          message: 'Token generation failed',
          errorCode: 'TOKEN_GENERATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // 8. Update user's last seen and status
      try {
        console.log('🔧 [AUTH] Updating user status to online:', user.id);
        await user.update({
          lastSeen: new Date(),
          status: 'online'
        });
      } catch (updateError) {
        console.error('🔧 [AUTH] User update error during login:', updateError.message);
        // Continue even if update fails
      }

      // 9. Return success response with consistent format
      console.log('🔧 [AUTH] Login successful for user:', user.id);
      
      const userResponse = {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        firstName: user.firstName,
        lastName: user.lastName,
        status: 'online',
        role: user.role,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      };

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        token: token, // Direct token for frontend
        user: userResponse,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('🔧 [AUTH] Login error:', error.message);

      // Handle specific Sequelize errors
      if (error.name === 'SequelizeConnectionError' || 
          error.name === 'SequelizeDatabaseError' ||
          error.message.includes('timeout') ||
          error.message.includes('connection') ||
          error.message.includes('ECONNREFUSED')) {
        return res.status(503).json({
          success: false,
          message: 'Database service temporarily unavailable',
          errorCode: 'DATABASE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }
      
      // Generic error response
      return res.status(500).json({
        success: false,
        message: 'Login failed',
        errorCode: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== /auth/me ENDPOINT =====
router.get(
  '/me',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      console.log('🔧 [AUTH /me] Endpoint called');
      
      // Verify authentication
      if (!req.user || !req.user.userId) {
        console.error('🔧 [AUTH /me] Authentication failed');
        return res.status(401).json({
          success: false,
          message: 'Authentication required',
          errorCode: 'AUTHENTICATION_FAILED',
          timestamp: new Date().toISOString()
        });
      }
      
      const userId = req.user.userId;
      console.log('🔧 [AUTH /me] User authenticated, userId:', userId);
      
      // Check if database models are available
      if (!db || !Users) {
        console.error('🔧 [AUTH /me] Models not available');
        return res.status(200).json({
          success: true,
          message: 'User authenticated (database temporarily unavailable)',
          user: {
            id: userId,
            email: req.user.email || null,
            username: req.user.username || null,
            role: req.user.role || 'user',
            status: 'online'
          },
          timestamp: new Date().toISOString(),
          authValidated: true,
          tokenValid: true,
          databaseAvailable: false
        });
      }

      console.log('🔧 [AUTH /me] Fetching user from database:', userId);
      
      // Fetch user from database
      let user;
      try {
        user = await Users.findByPk(userId, {
          attributes: { 
            exclude: [
              'password',
              'resetPasswordToken',
              'resetPasswordExpires',
              'emailVerificationToken',
              'verificationToken'
            ] 
          }
        });
      } catch (dbError) {
        console.error('🔧 [AUTH /me] Database query error:', dbError.message);
        return res.status(200).json({
          success: true,
          message: 'User authenticated (database query failed)',
          user: {
            id: userId,
            email: req.user.email || null,
            username: req.user.username || null,
            role: req.user.role || 'user',
            status: 'online'
          },
          timestamp: new Date().toISOString(),
          authValidated: true,
          tokenValid: true,
          databaseAvailable: false
        });
      }

      if (!user) {
        console.warn('🔧 [AUTH /me] User not found in database:', userId);
        return res.status(404).json({
          success: false,
          message: 'User account not found',
          errorCode: 'USER_NOT_FOUND',
          timestamp: new Date().toISOString(),
          authValidated: true,
          tokenValid: true
        });
      }
      
      if (!user.isActive) {
        console.warn('🔧 [AUTH /me] User account is inactive:', userId);
        return res.status(403).json({
          success: false,
          message: 'Account is inactive',
          errorCode: 'ACCOUNT_INACTIVE',
          timestamp: new Date().toISOString()
        });
      }
      
      console.log('🔧 [AUTH /me] ✅ User found, preparing response');
      
      const userResponse = {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        displayName: user.displayName || user.username,
        status: user.status || 'offline',
        role: user.role || 'user',
        isVerified: user.isVerified || false,
        isActive: user.isActive || true,
        lastSeen: user.lastSeen || null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        bio: user.bio || '',
        location: user.location || '',
        website: user.website || '',
        birthdate: user.birthdate || null,
        gender: user.gender || null
      };
      
      console.log('🔧 [AUTH /me] ✅ Successfully returning user data for:', user.email);

      return res.status(200).json({
        success: true,
        message: 'User profile retrieved successfully',
        user: userResponse,
        timestamp: new Date().toISOString(),
        authValidated: true,
        tokenValid: true,
        databaseAvailable: true
      });
      
    } catch (error) {
      console.error('🔧 [AUTH /me] 🚨 Unexpected error:', error.message);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch user profile',
        errorCode: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== REFRESH TOKEN ENDPOINT =====
router.post(
  '/refresh-token',
  asyncHandler(async (req, res) => {
    try {
      const { refreshToken } = req.cookies || req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token required',
          errorCode: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // Check if models are available
      if (!db || !db.Token) {
        console.error('🔧 [AUTH] Token model not available for refresh');
        return res.status(500).json({
          success: false,
          message: 'Token model not available',
          errorCode: 'MODEL_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }

      const TokenModel = db.Token;
      
      // Get Sequelize instance
      const sequelizeInstance = db.sequelize;
      if (!sequelizeInstance) {
        console.error('🔧 [AUTH] Sequelize instance not available for refresh');
        return res.status(500).json({
          success: false,
          message: 'Database configuration error',
          errorCode: 'CONFIGURATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      // Get Op operator
      const Op = db.Sequelize.Op || require('sequelize').Op;
      if (!Op) {
        console.error('🔧 [AUTH] Op operator not available for refresh');
        return res.status(500).json({
          success: false,
          message: 'Database query operator not available',
          errorCode: 'CONFIGURATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }

      const tokenRecord = await TokenModel.findOne({
        where: {
          token: refreshToken,
          tokenType: 'refresh',
          isRevoked: false,
          expiresAt: { [Op.gt]: new Date() }
        }
      });

      if (!tokenRecord) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired refresh token',
          errorCode: 'INVALID_REFRESH_TOKEN',
          timestamp: new Date().toISOString()
        });
      }

      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      
      const user = await Users.findByPk(decoded.userId);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User not found',
          errorCode: 'USER_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
      }

      // Generate new access token
      const newAccessToken = generateToken(user);

      // Generate new refresh token
      const newRefreshToken = jwt.sign(
        { userId: user.id, id: user.id },
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
        token: newAccessToken,
        refreshToken: newRefreshToken,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('🔧 [AUTH] Error refreshing token:', error.message);
      
      let statusCode = 500;
      let errorCode = 'INTERNAL_ERROR';
      
      if (error.name === 'JsonWebTokenError') {
        statusCode = 401;
        errorCode = 'INVALID_TOKEN';
      } else if (error.name === 'TokenExpiredError') {
        statusCode = 401;
        errorCode = 'TOKEN_EXPIRED';
      }
      
      res.status(statusCode).json({
        success: false,
        message: 'Failed to refresh token',
        errorCode: errorCode,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== LOGOUT ENDPOINT =====
router.post(
  '/logout',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const { refreshToken } = req.cookies || req.body;

      // Check if models are available
      if (refreshToken && db && db.Token) {
        try {
          const tokenRecord = await db.Token.findOne({
            where: { token: refreshToken, tokenType: 'refresh' }
          });
          
          if (tokenRecord) {
            await tokenRecord.update({ isRevoked: true });
          }
        } catch (dbError) {
          console.error('Token revoke error during logout:', dbError.message);
        }
      }

      // Update user status
      if (db && Users && req.user && req.user.userId) {
        try {
          const user = await Users.findByPk(req.user.userId);
          if (user) {
            await user.update({
              status: 'offline',
              lastSeen: new Date()
            });
          }
        } catch (updateError) {
          console.error('User update error during logout:', updateError.message);
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
      console.error('🔧 [AUTH] Error logging out:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to logout',
        errorCode: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== TEST DATABASE CONNECTION ENDPOINT =====
router.get('/test-db', asyncHandler(async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: 'Models not available',
        errorCode: 'SERVICE_UNAVAILABLE',
        timestamp: new Date().toISOString()
      });
    }
    
    // Test Users model
    const userCount = await Users.count();
    
    // Test Messages model if exists
    let messageCount = 0;
    if (db.Message) {
      messageCount = await db.Message.count();
    }
    
    res.status(200).json({
      success: true,
      message: 'Database connection test successful',
      data: {
        userCount,
        messageCount,
        database: 'PostgreSQL',
        timestamp: new Date().toISOString(),
        modelsAvailable: Object.keys(db).filter(key => 
          key !== 'sequelize' && key !== 'Sequelize'
        )
      }
    });
  } catch (error) {
    console.error('🔧 [AUTH] Database connection test error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Database connection test failed',
      errorCode: 'DATABASE_ERROR',
      timestamp: new Date().toISOString()
    });
  }
}));

// ===== VERIFY TOKEN ENDPOINT =====
router.post('/verify-token', asyncHandler(async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required',
        errorCode: 'VALIDATION_ERROR',
        timestamp: new Date().toISOString()
      });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Check if user still exists
      if (db && Users) {
        const user = await Users.findByPk(decoded.userId, {
          attributes: { exclude: ['password'] }
        });
        
        if (!user || !user.isActive) {
          return res.status(401).json({
            success: false,
            message: 'User not found or inactive',
            errorCode: 'USER_INACTIVE',
            timestamp: new Date().toISOString(),
            authValidated: false
          });
        }
        
        return res.status(200).json({
          success: true,
          message: 'Token is valid',
          user: user,
          expiresIn: decoded.exp - Math.floor(Date.now() / 1000),
          timestamp: new Date().toISOString(),
          authValidated: true
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Token is valid',
        user: decoded,
        expiresIn: decoded.exp - Math.floor(Date.now() / 1000),
        timestamp: new Date().toISOString(),
        authValidated: true
      });
      
    } catch (jwtError) {
      console.error('🔧 [AUTH] JWT verification error:', jwtError.message);
      
      let errorCode = 'TOKEN_ERROR';
      if (jwtError.name === 'TokenExpiredError') {
        errorCode = 'TOKEN_EXPIRED';
      } else if (jwtError.name === 'JsonWebTokenError') {
        errorCode = 'INVALID_TOKEN';
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        errorCode: errorCode,
        timestamp: new Date().toISOString(),
        authValidated: false
      });
    }
  } catch (error) {
    console.error('🔧 [AUTH] Token verification error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to verify token',
      errorCode: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
      authValidated: false
    });
  }
}));

// ===== CHANGE PASSWORD ENDPOINT =====
router.post(
  '/change-password',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password and new password are required',
          errorCode: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 6 characters',
          errorCode: 'VALIDATION_ERROR',
          timestamp: new Date().toISOString()
        });
      }
      
      if (!db || !Users) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          errorCode: 'MODEL_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
      }
      
      const user = await Users.findByPk(req.user.userId);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          errorCode: 'USER_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
      }
      
      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect',
          errorCode: 'INVALID_CREDENTIALS',
          timestamp: new Date().toISOString()
        });
      }
      
      // Hash and update password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await user.update({ password: hashedPassword });
      
      res.status(200).json({
        success: true,
        message: 'Password changed successfully',
        timestamp: new Date().toISOString(),
        authValidated: true
      });
      
    } catch (error) {
      console.error('🔧 [AUTH] Change password error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to change password',
        errorCode: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== DEBUG ENDPOINT TO CHECK AUTH STATUS =====
router.get('/debug-auth', authenticateToken, asyncHandler(async (req, res) => {
  try {
    let userData = null;
    if (db && Users && req.user && req.user.userId) {
      userData = await Users.findByPk(req.user.userId, {
        attributes: { exclude: ['password'] }
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Auth debug information',
      debug: {
        tokenValid: true,
        middlewareUsed: 'authenticateToken',
        reqUser: req.user,
        databaseModelsAvailable: !!db,
        userModelAvailable: !!(db && Users),
        userFromDatabase: userData ? {
          id: userData.id,
          email: userData.email,
          username: userData.username
        } : null,
        headers: {
          authorization: req.headers.authorization ? 'Present' : 'Missing',
          origin: req.headers.origin || 'Not set'
        }
      },
      timestamp: new Date().toISOString(),
      authValidated: true
    });
  } catch (error) {
    console.error('🔧 [AUTH] Debug auth error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Debug endpoint error',
      errorCode: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString()
    });
  }
}));

// ===== CLIENT-SIDE AUTH HELPER ENDPOINT =====
router.get('/client-setup', (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Client-side authentication setup guide',
      instructions: {
        localStorageSetup: `
          // After login/register success
          function handleAuthSuccess(token, userData) {
            localStorage.setItem('moodchat_token', token);
            localStorage.setItem('accessToken', token);
            window.accessToken = token;
            window.currentUser = userData;
            
            if (window.axios) {
              window.axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
            }
            
            console.log('✅ Token stored in localStorage');
            console.log('✅ User data loaded globally');
          }
        `,
        tokenPersistence: `
          // On page load - check for existing tokens
          function initializeAuth() {
            const token = localStorage.getItem('moodchat_token');
            
            if (token) {
              window.accessToken = token;
              
              if (window.axios) {
                window.axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
              }
              
              fetchCurrentUser();
            }
          }
        `
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Client setup error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get client setup guide'
    });
  }
});

// ===== CLIENT-SIDE AUTH SCRIPT ENDPOINT =====
router.get('/client-auth.js', (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
      // Client-side Authentication Manager for MoodChat
      class AuthManager {
        constructor() {
          this.tokenKey = 'moodchat_token';
          this.accessTokenKey = 'accessToken';
          this.currentUser = null;
          this.isInitialized = false;
          
          this.initialize();
        }
        
        initialize() {
          if (this.isInitialized) return;
          
          const token = localStorage.getItem(this.tokenKey);
          
          if (token) {
            this.setGlobalToken(token);
            this.loadCurrentUser();
          }
          
          this.setupRequestInterceptors();
          this.isInitialized = true;
          
          console.log('🔧 AuthManager initialized');
        }
        
        setGlobalToken(token) {
          localStorage.setItem(this.tokenKey, token);
          localStorage.setItem(this.accessTokenKey, token);
          window.accessToken = token;
          
          if (window.axios) {
            window.axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
          }
          
          console.log('✅ Token stored globally');
        }
        
        async loadCurrentUser() {
          if (window.currentUser) {
            this.currentUser = window.currentUser;
            return { success: true, user: this.currentUser };
          }
          
          const token = localStorage.getItem(this.tokenKey);
          if (!token) {
            return { success: false, error: 'No token found' };
          }
          
          const maxRetries = 3;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const response = await fetch('/api/auth/me', {
                headers: {
                  'Authorization': 'Bearer ' + token
                }
              });
              
              if (response.status === 401) {
                this.clearAuth();
                return { success: false, error: 'Invalid token' };
              }
              
              const data = await response.json();
              
              if (data.success && data.user) {
                this.currentUser = data.user;
                window.currentUser = data.user;
                
                console.log('✅ User data loaded successfully');
                return { success: true, user: this.currentUser };
              } else {
                console.warn('⚠️ Failed to load user data:', data.message);
                
                if (attempt < maxRetries) {
                  console.log('🔄 Retrying... attempt', attempt + 1);
                  await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                  continue;
                }
                
                return { success: false, error: data.message || 'Failed to load user' };
              }
            } catch (error) {
              console.error('❌ Error loading user:', error.message);
              
              if (attempt < maxRetries) {
                console.log('🔄 Retrying... attempt', attempt + 1);
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                continue;
              }
              
              return { success: false, error: error.message };
            }
          }
          
          return { success: false, error: 'Max retries reached' };
        }
        
        setupRequestInterceptors() {
          const originalFetch = window.fetch;
          window.fetch = async function(resource, options = {}) {
            const token = localStorage.getItem('moodchat_token');
            
            if (token && resource && typeof resource === 'string') {
              if (resource.startsWith('/api/') || resource.includes('localhost') || 
                  resource.startsWith(window.location.origin + '/api')) {
                options.headers = {
                  ...options.headers,
                  'Authorization': 'Bearer ' + token
                };
              }
            }
            
            const response = await originalFetch.call(this, resource, options);
            
            return response;
          };
          
          console.log('🔧 Request interceptors configured');
        }
        
        async login(identifier, password) {
          try {
            console.log('🔧 Attempting login...');
            
            const response = await fetch('/api/auth/login', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ identifier, password })
            });
            
            const data = await response.json();
            
            if (!data.success) {
              console.error('❌ Login failed:', data.message);
              return {
                success: false,
                message: data.message,
                errors: data.errors
              };
            }
            
            if (data.token) {
              console.log('✅ Login successful, token received');
              
              this.setGlobalToken(data.token);
              
              const userResult = await this.loadCurrentUser();
              
              if (userResult.success) {
                console.log('✅ User data loaded after login');
                
                this.dispatchAuthEvent('login', {
                  user: userResult.user,
                  token: data.token
                });
                
                return {
                  success: true,
                  token: data.token,
                  user: userResult.user,
                  message: data.message
                };
              } else {
                console.warn('⚠️ Login succeeded but user data loading failed');
                return {
                  success: false,
                  message: 'Logged in but failed to load user data',
                  token: data.token
                };
              }
            }
            
            return {
              success: false,
              message: 'No token received from server'
            };
            
          } catch (error) {
            console.error('❌ Login error:', error.message);
            return {
              success: false,
              message: 'Login failed: ' + error.message
            };
          }
        }
        
        async register(userDetails) {
          try {
            console.log('🔧 Attempting registration...');
            
            const response = await fetch('/api/auth/register', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(userDetails)
            });
            
            const data = await response.json();
            
            if (!data.success) {
              console.error('❌ Registration failed:', data.message);
              return {
                success: false,
                message: data.message,
                errors: data.errors
              };
            }
            
            if (data.token) {
              console.log('✅ Registration successful, token received');
              
              this.setGlobalToken(data.token);
              
              const userResult = await this.loadCurrentUser();
              
              if (userResult.success) {
                console.log('✅ User data loaded after registration');
                
                this.dispatchAuthEvent('register', {
                  user: userResult.user,
                  token: data.token
                });
                
                return {
                  success: true,
                  token: data.token,
                  user: userResult.user,
                  message: data.message
                };
              } else {
                console.warn('⚠️ Registration succeeded but user data loading failed');
                return {
                  success: false,
                  message: 'Registered but failed to load user data',
                  token: data.token
                };
              }
            }
            
            return {
              success: false,
              message: 'No token received from server'
            };
            
          } catch (error) {
            console.error('❌ Registration error:', error.message);
            return {
              success: false,
              message: 'Registration failed: ' + error.message
            };
          }
        }
        
        async logout() {
          const token = localStorage.getItem(this.tokenKey);
          
          if (token) {
            try {
              await fetch('/api/auth/logout', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + token
                }
              });
            } catch (error) {
              console.warn('⚠️ Server logout failed, but local data will be cleared');
            }
          }
          
          this.clearAuth();
          
          console.log('✅ Logout completed');
          
          this.dispatchAuthEvent('logout', {});
          
          return { success: true };
        }
        
        clearAuth() {
          localStorage.removeItem(this.tokenKey);
          localStorage.removeItem(this.accessTokenKey);
          delete window.accessToken;
          delete window.currentUser;
          this.currentUser = null;
          
          if (window.axios) {
            delete window.axios.defaults.headers.common['Authorization'];
          }
          
          console.log('🔧 Auth data cleared');
        }
        
        isAuthenticated() {
          const token = localStorage.getItem(this.tokenKey);
          return !!token && !!this.currentUser;
        }
        
        getToken() {
          return localStorage.getItem(this.tokenKey);
        }
        
        getUser() {
          return this.currentUser || window.currentUser;
        }
        
        dispatchAuthEvent(type, detail) {
          const event = new CustomEvent('auth:' + type, {
            detail: detail,
            bubbles: true
          });
          
          window.dispatchEvent(event);
        }
        
        async waitForAuth() {
          if (this.isAuthenticated()) {
            return { success: true, user: this.getUser() };
          }
          
          const token = this.getToken();
          if (token) {
            const result = await this.loadCurrentUser();
            if (result.success) {
              return { success: true, user: result.user };
            }
          }
          
          return { success: false, isAuthenticated: false };
        }
      }
      
      window.AuthManager = new AuthManager();
      
      document.addEventListener('DOMContentLoaded', function() {
        console.log('🔧 AuthManager auto-initialized');
      });
      
      if (typeof module !== 'undefined' && module.exports) {
        module.exports = window.AuthManager;
      }
    `);
  } catch (error) {
    console.error('Client auth script error:', error);
    res.status(500).send('// Error generating auth script');
  }
});

// Export the router
module.exports = router;