// src/routes/auth.js - THIS FILE IS A ROUTER — NOT A SEQUELIZE MODEL
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');

// Import the shared auth middleware
const { authenticateToken } = require('../middleware/auth');

// Create router
const router = express.Router();

console.log('✅ Auth ROUTER initialized (NOT a Sequelize model)');
console.log('✅ POST /login route available at /api/auth/login');
console.log('✅ POST /register route available at /api/auth/register');
console.log('✅ GET /me route available at /api/auth/me');

// JWT configuration from .env - FIXED: Use JWT_SECRET consistently
const JWT_SECRET = process.env.JWT_SECRET || '3e78ab2d6cb698f95b3b8d510614058c'; // Using your .env value
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '24h'; // Changed from 15m to 24h
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

// ===== TEST ENDPOINT =====
router.get('/test', (req, res) => {
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
});

// ===== REGISTER ENDPOINT - USING Users MODEL =====
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    try {
      const { username, email, password } = req.body;

      console.log('🔧 [AUTH] Register request received:', { username, email: email ? '***@***' : 'missing' });

      // 1. STRICT VALIDATION - EXACT FIELDS REQUIRED
      if (!email || !username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: email, username, and password are all required',
          timestamp: new Date().toISOString(),
          database: {
            connected: req.app.locals.dbConnected || false,
            initialized: req.app.locals.databaseInitialized || false
          }
        });
      }

      // 2. Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
          timestamp: new Date().toISOString()
        });
      }

      // 3. Validate password
      const passwordErrors = validatePassword(password);
      if (passwordErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Password validation failed',
          errors: passwordErrors,
          timestamp: new Date().toISOString()
        });
      }

      // 4. Check if database models are available
      const models = req.app.locals.models;
      
      if (!models) {
        console.error('🔧 [AUTH] Models not available in app.locals');
        return res.status(503).json({
          success: false,
          message: 'Database service not initialized',
          timestamp: new Date().toISOString(),
          database: {
            connected: false,
            initialized: false
          }
        });
      }

      // 5. Get Users model (using Users, not User) - FIXED: Use User (singular) as per your models
      const UsersModel = models.User || models.Users; // Try both for compatibility
      if (!UsersModel) {
        console.error('🔧 [AUTH] User model not found in models:', Object.keys(models));
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString(),
          database: {
            connected: false,
            initialized: false
          }
        });
      }

      // 6. Get Sequelize instance and Op operator safely FROM APP.LOCALS
      const sequelizeInstance = req.app.locals.sequelize;
      if (!sequelizeInstance) {
        console.error('🔧 [AUTH] Sequelize instance not available in app.locals');
        return res.status(500).json({
          success: false,
          message: 'Database configuration error - Sequelize not available',
          timestamp: new Date().toISOString()
        });
      }

      // 7. Get Op operator safely from Sequelize instance
      let Op;
      try {
        // Try multiple ways to get Op (different Sequelize versions)
        Op = sequelizeInstance.Op || 
             sequelizeInstance.constructor.Op || 
             sequelizeInstance.Sequelize?.Op;
        
        if (!Op) {
          console.error('🔧 [AUTH] Op operator not available from Sequelize instance');
          return res.status(500).json({
            success: false,
            message: 'Database query operator not available',
            timestamp: new Date().toISOString()
          });
        }
      } catch (opError) {
        console.error('🔧 [AUTH] Failed to get Op operator:', opError.message);
        return res.status(500).json({
          success: false,
          message: 'Server configuration error: Sequelize operators unavailable',
          timestamp: new Date().toISOString()
        });
      }

      // 8. Single database query: Check if user exists by email OR username
      const existingUser = await UsersModel.findOne({
        where: {
          [Op.or]: [
            { email: email.toLowerCase() },
            { username: username }
          ]
        }
      });
      
      if (existingUser) {
        const statusCode = 409; // Consistent 409 for conflicts
        if (existingUser.email === email.toLowerCase()) {
          return res.status(statusCode).json({
            success: false,
            message: 'User with this email already exists',
            timestamp: new Date().toISOString()
          });
        } else {
          return res.status(statusCode).json({
            success: false,
            message: 'Username already taken',
            timestamp: new Date().toISOString()
          });
        }
      }

      // 9. Hash password
      let hashedPassword;
      try {
        hashedPassword = await bcrypt.hash(password, 10);
      } catch (hashError) {
        console.error('🔧 [AUTH] Password hashing error:', {
          name: hashError.name,
          message: hashError.message,
          stack: hashError.stack
        });
        return res.status(500).json({
          success: false,
          message: 'Password processing failed',
          error: IS_PRODUCTION ? undefined : hashError.message,
          timestamp: new Date().toISOString()
        });
      }

      // 10. Single database query: Create user in Users table
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

      console.log('🔧 [AUTH] User created successfully:', user.id);

      // 11. Generate JWT token - FIXED: Use JWT_SECRET consistently
      let token;
      try {
        token = jwt.sign(
          { 
            userId: user.id, 
            id: user.id, // Add id for compatibility
            email: user.email, 
            username: user.username,
            role: user.role
          },
          JWT_SECRET, // Using JWT_SECRET from .env
          { expiresIn: '24h' }
        );
      } catch (jwtError) {
        console.error('🔧 [AUTH] JWT generation error:', {
          name: jwtError.name,
          message: jwtError.message,
          stack: jwtError.stack
        });
        return res.status(500).json({
          success: false,
          message: 'Token generation failed',
          error: IS_PRODUCTION ? undefined : jwtError.message,
          timestamp: new Date().toISOString()
        });
      }

      // 12. Return success response with CLIENT-SIDE INSTRUCTIONS
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        userId: user.id,
        token,
        clientInstructions: {
          localStorageKeys: ['moodchat_token', 'accessToken'],
          globalVariables: ['window.accessToken', 'window.currentUser'],
          nextSteps: 'Call /auth/me endpoint to fetch user data'
        },
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
      
    } catch (error) {
      // Log detailed error information
      console.error('🔧 [AUTH] Registration error:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code,
        parent: error.parent,
        original: error.original,
        sql: error.sql
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
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString(),
          database: {
            connected: false,
            initialized: false
          }
        });
      }
      
      // Handle unique constraint errors
      if (error.name === 'SequelizeUniqueConstraintError') {
        const field = error.errors && error.errors[0] ? error.errors[0].path : 'field';
        return res.status(409).json({
          success: false,
          message: field === 'email' ? 'User with this email already exists' : 'Username already taken',
          timestamp: new Date().toISOString()
        });
      }
      
      // Handle validation errors
      if (error.name === 'SequelizeValidationError') {
        const errorMessages = error.errors ? error.errors.map(err => err.message) : ['Validation failed'];
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errorMessages,
          timestamp: new Date().toISOString()
        });
      }
      
      // Handle other Sequelize errors
      if (error.name && error.name.includes('Sequelize')) {
        return res.status(500).json({
          success: false,
          message: 'Database operation failed',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }

      // Generic error response
      return res.status(500).json({
        success: false,
        message: 'Registration failed. Please check server logs.',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== LOGIN ENDPOINT - USING Users MODEL =====
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    try {
      const { identifier, password } = req.body;

      console.log('🔧 [AUTH] Login request received (FIXED VERSION):', { identifier: identifier ? '***' : 'missing' });

      // 1. STRICT VALIDATION - EXACT FIELDS REQUIRED
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email/username) and password are required',
          timestamp: new Date().toISOString()
        });
      }

      // 2. Check if database models are available
      const models = req.app.locals.models;
      
      if (!models) {
        console.error('🔧 [AUTH] Models not available in app.locals for login');
        return res.status(503).json({
          success: false,
          message: 'Database service not initialized',
          timestamp: new Date().toISOString(),
          database: {
            connected: false,
            initialized: false
          }
        });
      }

      // 3. Get Users model - FIXED: Use User (singular) as per your models
      const UsersModel = models.User || models.Users; // Try both for compatibility
      if (!UsersModel) {
        console.error('🔧 [AUTH] User model not found for login');
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString(),
          database: {
            connected: false,
            initialized: false
          }
        });
      }

      // 4. Single database query: Find user by email or username with all needed data
      let user;
      try {
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
      } catch (dbError) {
        console.error('🔧 [AUTH] Database query error during login:', {
          name: dbError.name,
          message: dbError.message,
          stack: dbError.stack
        });
        return res.status(503).json({
          success: false,
          message: 'Database service temporarily unavailable',
          error: !IS_PRODUCTION ? dbError.message : undefined,
          timestamp: new Date().toISOString()
        });
      }

      // 5. If user not found - RETURN 401 FOR INVALID CREDENTIALS
      if (!user) {
        console.log('🔧 [AUTH] Login failed: User not found');
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password',
          timestamp: new Date().toISOString()
        });
      }

      // 6. Compare passwords
      let validPassword;
      try {
        console.log('🔧 [AUTH] Comparing password for user:', user.id);
        validPassword = await bcrypt.compare(password, user.password);
      } catch (bcryptError) {
        console.error('🔧 [AUTH] Password comparison error:', {
          name: bcryptError.name,
          message: bcryptError.message,
          stack: bcryptError.stack
        });
        return res.status(500).json({
          success: false,
          message: 'Authentication failed',
          error: IS_PRODUCTION ? undefined : bcryptError.message,
          timestamp: new Date().toISOString()
        });
      }
      
      // 7. If password is invalid - RETURN 401 FOR INVALID CREDENTIALS
      if (!validPassword) {
        console.log('🔧 [AUTH] Login failed: Invalid password for user:', user.id);
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password',
          timestamp: new Date().toISOString()
        });
      }

      // 8. Generate JWT token - FIXED: Use JWT_SECRET consistently
      let token;
      try {
        console.log('🔧 [AUTH] Generating JWT token for user:', user.id);
        token = jwt.sign(
          { 
            userId: user.id, 
            id: user.id, // Add id for compatibility
            email: user.email, 
            username: user.username,
            role: user.role
          },
          JWT_SECRET, // Using JWT_SECRET from .env
          { expiresIn: '24h' }
        );
      } catch (jwtError) {
        console.error('🔧 [AUTH] JWT generation error during login:', {
          name: jwtError.name,
          message: jwtError.message,
          stack: jwtError.stack
        });
        return res.status(500).json({
          success: false,
          message: 'Token generation failed',
          error: IS_PRODUCTION ? undefined : jwtError.message,
          timestamp: new Date().toISOString()
        });
      }

      // 9. Update user's last seen and status
      try {
        console.log('🔧 [AUTH] Updating user status to online:', user.id);
        await user.update({
          lastSeen: new Date(),
          status: 'online'
        });
      } catch (updateError) {
        console.error('🔧 [AUTH] User update error during login:', {
          name: updateError.name,
          message: updateError.message,
          stack: updateError.stack
        });
        // Continue even if update fails - don't break login
      }

      // 10. Return success response with all user data from the single query
      console.log('🔧 [AUTH] Login successful for user:', user.id);
      
      // Prepare user response object
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
        token: token,
        clientInstructions: {
          localStorageKeys: ['moodchat_token', 'accessToken'],
          globalVariables: ['window.accessToken', 'window.currentUser'],
          nextSteps: 'Call /auth/me endpoint to fetch user data'
        },
        user: userResponse,
        timestamp: new Date().toISOString(),
        storage: 'PostgreSQL (Permanent)'
      });
      
    } catch (error) {
      // Log detailed error information
      console.error('🔧 [AUTH] Login error (CAUGHT):', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code,
        parent: error.parent,
        original: error.original
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
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
      
      // Handle validation errors
      if (error.name === 'SequelizeValidationError') {
        const errorMessages = error.errors ? error.errors.map(err => err.message) : ['Validation failed'];
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errorMessages,
          timestamp: new Date().toISOString()
        });
      }
      
      // Handle other Sequelize errors
      if (error.name && error.name.includes('Sequelize')) {
        return res.status(500).json({
          success: false,
          message: 'Database operation failed',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }

      // Generic error response
      return res.status(500).json({
        success: false,
        message: 'Login failed. Please try again.',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== /auth/me ENDPOINT - NOW USING SHARED AUTH MIDDLEWARE =====
router.get(
  '/me',
  authenticateToken, // Use the shared auth middleware instead of inline verification
  asyncHandler(async (req, res) => {
    try {
      console.log('🔧 [AUTH /me] Endpoint called - USING SHARED MIDDLEWARE');
      
      // User is already authenticated by middleware, req.user is set
      if (!req.user || !req.user.userId) {
        console.error('🔧 [AUTH /me] Middleware did not set req.user properly');
        return res.status(401).json({
          success: false,
          message: 'Authentication failed',
          timestamp: new Date().toISOString(),
          authValidated: false
        });
      }
      
      const userId = req.user.userId;
      console.log('🔧 [AUTH /me] User authenticated via middleware, userId:', userId);
      
      // Check if database models are available
      const models = req.app.locals.models;
      if (!models || (!models.User && !models.Users)) {
        console.error('🔧 [AUTH /me] Models not available');
        
        // Even if database is down, return success with token data
        console.log('🔧 [AUTH /me] ⚠️ Database not available, but token is valid - returning token data');
        return res.status(200).json({
          success: true,
          message: 'User authenticated (database temporarily unavailable)',
          user: {
            id: userId,
            email: req.user.email || null,
            username: req.user.username || null,
            role: req.user.role || 'user',
            tokenIssuedAt: req.user.tokenIssuedAt || null,
            tokenExpiresAt: req.user.tokenExpiresAt || null
          },
          timestamp: new Date().toISOString(),
          authValidated: true,
          tokenValid: true,
          databaseAvailable: false
        });
      }

      const UsersModel = models.User || models.Users;
      
      console.log('🔧 [AUTH /me] Fetching user from database:', userId);
      
      // Fetch user from database
      let user;
      try {
        user = await UsersModel.findByPk(userId, {
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
        // Even if database query fails, token is still valid
        console.log('🔧 [AUTH /me] ⚠️ Database query failed, but token is valid - returning token data');
        return res.status(200).json({
          success: true,
          message: 'User authenticated (database query failed)',
          user: {
            id: userId,
            email: req.user.email || null,
            username: req.user.username || null,
            role: req.user.role || 'user',
            tokenIssuedAt: req.user.tokenIssuedAt || null,
            tokenExpiresAt: req.user.tokenExpiresAt || null
          },
          timestamp: new Date().toISOString(),
          authValidated: true,
          tokenValid: true,
          databaseError: !IS_PRODUCTION ? dbError.message : undefined
        });
      }

      if (!user) {
        console.warn('🔧 [AUTH /me] User not found in database:', userId);
        // User not found in database but token is valid
        // This might happen if user was deleted but token still exists
        return res.status(404).json({
          success: false,
          message: 'User account not found',
          timestamp: new Date().toISOString(),
          authValidated: true, // Token IS valid, but user doesn't exist
          tokenValid: true
        });
      }
      
      if (!user.isActive) {
        console.warn('🔧 [AUTH /me] User account is inactive:', userId);
        return res.status(403).json({
          success: false,
          message: 'Account is inactive',
          timestamp: new Date().toISOString(),
          authValidated: true, // Token IS valid
          tokenValid: true
        });
      }
      
      console.log('🔧 [AUTH /me] ✅ User found, preparing response');
      
      // Prepare complete user response
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
        gender: user.gender || null,
        // Add token metadata for client-side use
        tokenIssuedAt: req.user.tokenIssuedAt || null,
        tokenExpiresAt: req.user.tokenExpiresAt || null
      };
      
      console.log('🔧 [AUTH /me] ✅ Successfully returning user data for:', user.email);
      console.log('🔧 [AUTH /me] ✅ Auth validation: YES - Token is valid and user exists');

      // Return SUCCESS response with authValidated: true
      return res.status(200).json({
        success: true,
        message: 'User profile retrieved successfully',
        user: userResponse,
        timestamp: new Date().toISOString(),
        authValidated: true, // THIS IS THE KEY FIELD - SET TO TRUE
        tokenValid: true,
        databaseAvailable: true,
        tokenInfo: {
          issuedAt: req.user.tokenIssuedAt || null,
          expiresAt: req.user.tokenExpiresAt || null,
          expiresIn: req.user.tokenExpiresAt ? Math.max(0, Math.floor(req.user.tokenExpiresAt.getTime() / 1000) - Math.floor(Date.now() / 1000)) : null
        }
      });
      
    } catch (error) {
      console.error('🔧 [AUTH /me] 🚨 Unexpected error:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        path: req.path
      });
      
      // Handle database connection errors
      if (error.name === 'SequelizeConnectionError' || 
          error.name === 'SequelizeDatabaseError' ||
          error.message.includes('timeout') ||
          error.message.includes('connection') ||
          error.message.includes('ECONNREFUSED')) {
        return res.status(503).json({
          success: false,
          message: 'Database service temporarily unavailable',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString(),
          authValidated: false,
          database: {
            connected: false,
            initialized: false
          }
        });
      }
      
      // Handle other Sequelize errors
      if (error.name && error.name.includes('Sequelize')) {
        return res.status(500).json({
          success: false,
          message: 'Database operation failed',
          error: !IS_PRODUCTION ? error.message : undefined,
          timestamp: new Date().toISOString(),
          authValidated: false
        });
      }
      
      // Handle other errors
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch user profile',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString(),
        authValidated: false
      });
    }
  })
);

// ===== AUTHENTICATION MIDDLEWARE FOR ROUTER (KEPT FOR OTHER ROUTES IN THIS FILE) =====
function authenticateTokenRouter(req, res, next) {
  console.log('🔧 [Auth Router Middleware] Checking authentication for:', req.method, req.path);
  
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    console.log('🔧 [Auth Router Middleware] No token provided');
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required',
      timestamp: new Date().toISOString()
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error('🔧 [Auth Router Middleware] JWT Verification Error:', {
        name: err.name,
        message: err.message,
        path: req.path
      });
      
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          success: false, 
          message: 'Token expired',
          error: !IS_PRODUCTION ? err.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
      
      if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid token',
          error: !IS_PRODUCTION ? err.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token',
        error: !IS_PRODUCTION ? err.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
    
    // Ensure req.user is set with proper structure
    req.user = {
      userId: decoded.userId || decoded.id || decoded.sub,
      id: decoded.userId || decoded.id || decoded.sub,
      email: decoded.email || null,
      username: decoded.username || null,
      role: decoded.role || 'user',
      tokenIssuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null
    };
    
    console.log('🔧 [Auth Router Middleware] Authentication successful for user:', req.user.userId);
    next();
  });
}

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
          timestamp: new Date().toISOString()
        });
      }

      // Check if models are available from app.locals - FIXED: Use Token (singular)
      const models = req.app.locals.models;
      if (!models || !models.Token) {
        console.error('🔧 [AUTH] Token model not available for refresh');
        return res.status(500).json({
          success: false,
          message: 'Token model not available',
          timestamp: new Date().toISOString()
        });
      }

      const TokenModel = models.Token;
      
      // Get Sequelize instance FROM APP.LOCALS
      const sequelizeInstance = req.app.locals.sequelize;
      if (!sequelizeInstance) {
        console.error('🔧 [AUTH] Sequelize instance not available in app.locals for refresh');
        return res.status(500).json({
          success: false,
          message: 'Database configuration error',
          timestamp: new Date().toISOString()
        });
      }

      // Get Op operator safely from Sequelize instance
      let Op;
      try {
        Op = sequelizeInstance.Op || 
             sequelizeInstance.constructor.Op || 
             sequelizeInstance.Sequelize?.Op;
        
        if (!Op) {
          console.error('🔧 [AUTH] Op operator not available for refresh');
          return res.status(500).json({
            success: false,
            message: 'Database query operator not available',
            timestamp: new Date().toISOString()
          });
        }
      } catch (opError) {
        console.error('🔧 [AUTH] Failed to get Op operator for refresh:', opError.message);
        return res.status(500).json({
          success: false,
          message: 'Server configuration error: Sequelize operators unavailable',
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
          timestamp: new Date().toISOString()
        });
      }

      const decoded = jwt.verify(refreshToken, JWT_SECRET); // Using JWT_SECRET
      
      const UsersModel = models.User || models.Users; // FIXED: Use User (singular)
      const user = await UsersModel.findByPk(decoded.userId);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      // Generate new access token
      const newAccessToken = jwt.sign(
        { 
          userId: user.id, 
          id: user.id, // Add id for compatibility
          username: user.username, 
          email: user.email,
          role: user.role
        },
        JWT_SECRET, // Using JWT_SECRET
        { expiresIn: JWT_ACCESS_EXPIRES_IN }
      );

      // Generate new refresh token
      const newRefreshToken = jwt.sign(
        { userId: user.id, id: user.id }, // Add id for compatibility
        JWT_SECRET, // Using JWT_SECRET
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
        clientInstructions: {
          localStorageKeys: ['moodchat_token', 'accessToken'],
          globalVariables: ['window.accessToken', 'window.currentUser']
        },
        data: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('🔧 [AUTH] Error refreshing token:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to refresh token',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== LOGOUT ENDPOINT =====
router.post(
  '/logout',
  authenticateTokenRouter,
  asyncHandler(async (req, res) => {
    try {
      const { refreshToken } = req.cookies || req.body;

      // Check if models are available from app.locals - FIXED: Use Token (singular)
      const models = req.app.locals.models;
      if (refreshToken && models && models.Token) {
        // Revoke the refresh token
        const tokenRecord = await models.Token.findOne({
          where: { token: refreshToken, tokenType: 'refresh' }
        });
        
        if (tokenRecord) {
          await tokenRecord.update({ isRevoked: true });
        }
      }

      // Update user status - FIXED: Use User (singular)
      if (models && (models.User || models.Users) && req.user) {
        const UsersModel = models.User || models.Users;
        const user = await UsersModel.findByPk(req.user.userId);
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
        clientInstructions: {
          localStorageKeys: ['moodchat_token', 'accessToken'],
          globalVariables: ['window.accessToken', 'window.currentUser'],
          clearInstructions: 'Clear all localStorage entries and global variables'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('🔧 [AUTH] Error logging out:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      res.status(500).json({
        success: false,
        message: 'Failed to logout',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== TEST DATABASE CONNECTION ENDPOINT =====
router.get('/test-db', asyncHandler(async (req, res) => {
  try {
    const models = req.app.locals.models;
    if (!models) {
      throw new Error('Models not available');
    }
    
    // Test Users model - FIXED: Use User (singular)
    const UsersModel = models.User || models.Users;
    const userCount = await UsersModel.count();
    
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
    console.error('🔧 [AUTH] Database connection test error:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: 'Database connection test failed',
      error: error.message,
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
        timestamp: new Date().toISOString()
      });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET); // Using JWT_SECRET
      
      // Check if user still exists
      const models = req.app.locals.models;
      if (models && (models.User || models.Users)) {
        const UsersModel = models.User || models.Users;
        const user = await UsersModel.findByPk(decoded.userId, {
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
          timestamp: new Date().toISOString(),
          authValidated: true // ADDED
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Token is valid',
        user: decoded,
        expiresIn: decoded.exp - Math.floor(Date.now() / 1000),
        timestamp: new Date().toISOString(),
        authValidated: true // ADDED
      });
      
    } catch (jwtError) {
      console.error('🔧 [AUTH] JWT verification error:', {
        name: jwtError.name,
        message: jwtError.message,
        stack: jwtError.stack
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        error: !IS_PRODUCTION ? jwtError.message : undefined,
        timestamp: new Date().toISOString(),
        authValidated: false // ADDED
      });
    }
  } catch (error) {
    console.error('🔧 [AUTH] Token verification error:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: 'Failed to verify token',
      error: !IS_PRODUCTION ? error.message : undefined,
      timestamp: new Date().toISOString(),
      authValidated: false // ADDED
    });
  }
}));

// ===== CHANGE PASSWORD ENDPOINT =====
router.post(
  '/change-password',
  authenticateTokenRouter,
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
      
      const models = req.app.locals.models;
      if (!models || (!models.User && !models.Users)) {
        return res.status(500).json({
          success: false,
          message: 'User model not available',
          timestamp: new Date().toISOString()
        });
      }
      
      const UsersModel = models.User || models.Users;
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
        timestamp: new Date().toISOString(),
        authValidated: true // ADDED
      });
      
    } catch (error) {
      console.error('🔧 [AUTH] Change password error:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      res.status(500).json({
        success: false,
        message: 'Failed to change password',
        error: !IS_PRODUCTION ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  })
);

// ===== DEBUG ENDPOINT TO CHECK AUTH STATUS =====
router.get('/debug-auth', authenticateTokenRouter, asyncHandler(async (req, res) => {
  try {
    const models = req.app.locals.models;
    const UsersModel = models?.User || models?.Users;
    
    let userData = null;
    if (UsersModel && req.user.userId) {
      userData = await UsersModel.findByPk(req.user.userId, {
        attributes: { exclude: ['password'] }
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Auth debug information',
      debug: {
        tokenValid: true,
        middlewareUsed: 'authenticateTokenRouter',
        reqUser: req.user,
        databaseModelsAvailable: !!models,
        userModelAvailable: !!UsersModel,
        userFromDatabase: userData ? {
          id: userData.id,
          email: userData.email,
          username: userData.username
        } : null,
        appLocals: {
          dbConnected: req.app.locals.dbConnected || false,
          databaseInitialized: req.app.locals.databaseInitialized || false,
          hasModels: !!req.app.locals.models,
          modelsCount: req.app.locals.models ? Object.keys(req.app.locals.models).length : 0
        },
        headers: {
          authorization: req.headers.authorization ? 'Present' : 'Missing',
          origin: req.headers.origin || 'Not set'
        }
      },
      timestamp: new Date().toISOString(),
      authValidated: true // ADDED
    });
  } catch (error) {
    console.error('🔧 [AUTH] Debug auth error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Debug endpoint error',
      error: !IS_PRODUCTION ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
}));

// ===== CLIENT-SIDE AUTH HELPER ENDPOINT =====
router.get('/client-setup', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Client-side authentication setup guide',
    instructions: {
      localStorageSetup: `
        // After login/register success
        function handleAuthSuccess(token, userData) {
          // Save tokens to localStorage
          localStorage.setItem('moodchat_token', token);
          localStorage.setItem('accessToken', token);
          
          // Set global variables
          window.accessToken = token;
          window.currentUser = userData;
          
          // Configure API headers
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
            
            // Set up API headers
            if (window.axios) {
              window.axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
            }
            
            // Fetch current user
            fetchCurrentUser();
          }
        }
      `,
      apiHelperFunctions: `
        // Authentication helper functions
        const authHelpers = {
          login: async (identifier, password) => {
            try {
              const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier, password })
              });
              
              const data = await response.json();
              
              if (data.success && data.token) {
                // Save token and user data
                localStorage.setItem('moodchat_token', data.token);
                localStorage.setItem('accessToken', data.token);
                window.accessToken = data.token;
                
                // Fetch and set current user
                await fetchCurrentUser();
                
                return { success: true, data };
              }
              
              return { success: false, error: data.message };
            } catch (error) {
              return { success: false, error: error.message };
            }
          },
          
          register: async (userDetails) => {
            try {
              const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(userDetails)
              });
              
              const data = await response.json();
              
              if (data.success && data.token) {
                // Save token and user data
                localStorage.setItem('moodchat_token', data.token);
                localStorage.setItem('accessToken', data.token);
                window.accessToken = data.token;
                
                // Fetch and set current user
                await fetchCurrentUser();
                
                return { success: true, data };
              }
              
              return { success: false, error: data.message };
            } catch (error) {
              return { success: false, error: error.message };
            }
          },
          
          logout: async () => {
            try {
              const response = await fetch('/api/auth/logout', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + window.accessToken
                }
              });
              
              // Clear local storage regardless of server response
              localStorage.removeItem('moodchat_token');
              localStorage.removeItem('accessToken');
              delete window.accessToken;
              delete window.currentUser;
              
              // Clear API headers
              if (window.axios) {
                delete window.axios.defaults.headers.common['Authorization'];
              }
              
              return { success: true };
            } catch (error) {
              // Still clear local data even if server call fails
              localStorage.removeItem('moodchat_token');
              localStorage.removeItem('accessToken');
              delete window.accessToken;
              delete window.currentUser;
              
              return { success: false, error: error.message };
            }
          },
          
          getCurrentUser: async () => {
            if (window.currentUser) {
              return { success: true, user: window.currentUser };
            }
            
            const token = localStorage.getItem('moodchat_token');
            if (!token) {
              return { success: false, error: 'No token found' };
            }
            
            try {
              const response = await fetch('/api/auth/me', {
                headers: {
                  'Authorization': 'Bearer ' + token
                }
              });
              
              const data = await response.json();
              
              if (data.success && data.user) {
                window.currentUser = data.user;
                return { success: true, user: data.user };
              }
              
              return { success: false, error: data.message };
            } catch (error) {
              return { success: false, error: error.message };
            }
          }
        };
        
        // Auto-attach token to fetch requests
        const originalFetch = window.fetch;
        window.fetch = function(resource, options = {}) {
          const token = localStorage.getItem('moodchat_token');
          
          if (token && resource && typeof resource === 'string') {
            if (resource.startsWith('/api/') || resource.includes('localhost')) {
              options.headers = {
                ...options.headers,
                'Authorization': 'Bearer ' + token
              };
            }
          }
          
          return originalFetch.call(this, resource, options);
        };
        
        // Retry logic for /auth/me
        async function fetchCurrentUserWithRetry(retries = 3, delay = 1000) {
          for (let i = 0; i < retries; i++) {
            try {
              const result = await authHelpers.getCurrentUser();
              if (result.success) {
                console.log('✅ User data loaded successfully');
                return result;
              }
              
              if (i < retries - 1) {
                console.log('🔄 Retrying user data fetch...');
                await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
              }
            } catch (error) {
              if (i < retries - 1) {
                console.log('🔄 Retrying after error...');
                await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
              }
            }
          }
          
          console.error('❌ Failed to fetch user data after retries');
          return { success: false, error: 'Failed to load user data' };
        }
      `
    },
    timestamp: new Date().toISOString()
  });
});

// ===== CLIENT-SIDE AUTH SCRIPT ENDPOINT =====
router.get('/client-auth.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    // Client-side Authentication Manager for MoodChat
    // This script should be included in your HTML pages
    
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
        
        // Check for existing token
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
        // Store in localStorage
        localStorage.setItem(this.tokenKey, token);
        localStorage.setItem(this.accessTokenKey, token);
        
        // Set global variable
        window.accessToken = token;
        
        // Configure axios if available
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
        
        // Retry logic
        const maxRetries = 3;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const response = await fetch('/api/auth/me', {
              headers: {
                'Authorization': 'Bearer ' + token
              }
            });
            
            if (response.status === 401) {
              // Token is invalid, clear it
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
        // Intercept fetch requests
        const originalFetch = window.fetch;
        window.fetch = async function(resource, options = {}) {
          const token = localStorage.getItem('moodchat_token');
          
          if (token && resource && typeof resource === 'string') {
            // Only add token to API requests
            if (resource.startsWith('/api/') || resource.includes('localhost') || 
                resource.startsWith(window.location.origin + '/api')) {
              options.headers = {
                ...options.headers,
                'Authorization': 'Bearer ' + token
              };
            }
          }
          
          const response = await originalFetch.call(this, resource, options);
          
          // Handle token expiration
          if (response.status === 403 || response.status === 401) {
            try {
              const data = await response.clone().json();
              if (data.message && data.message.includes('token')) {
                console.warn('⚠️ Token expired or invalid');
                // Don't clear here - let the calling code handle it
              }
            } catch (e) {
              // Not JSON response
            }
          }
          
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
            
            // Store token
            this.setGlobalToken(data.token);
            
            // Load user data with retry
            const userResult = await this.loadCurrentUser();
            
            if (userResult.success) {
              console.log('✅ User data loaded after login');
              
              // Dispatch login event
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
            
            // Store token
            this.setGlobalToken(data.token);
            
            // Load user data with retry
            const userResult = await this.loadCurrentUser();
            
            if (userResult.success) {
              console.log('✅ User data loaded after registration');
              
              // Dispatch registration event
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
            // Try to call server logout endpoint
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
        
        // Clear all local data regardless of server response
        this.clearAuth();
        
        console.log('✅ Logout completed');
        
        // Dispatch logout event
        this.dispatchAuthEvent('logout', {});
        
        return { success: true };
      }
      
      clearAuth() {
        // Clear localStorage
        localStorage.removeItem(this.tokenKey);
        localStorage.removeItem(this.accessTokenKey);
        
        // Clear global variables
        delete window.accessToken;
        delete window.currentUser;
        this.currentUser = null;
        
        // Clear axios headers if available
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
      
      // Helper for pages to wait for auth initialization
      async waitForAuth() {
        if (this.isAuthenticated()) {
          return { success: true, user: this.getUser() };
        }
        
        // Check if we have a token but no user
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
    
    // Create global auth instance
    window.AuthManager = new AuthManager();
    
    // Auto-initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
      console.log('🔧 AuthManager auto-initialized');
    });
    
    // Export for module systems
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = window.AuthManager;
    }
  `);
});

// CRITICAL: Export the router ONLY
module.exports = router;