// src/routes/auth.js - THIS FILE IS A ROUTER — NOT A SEQUELIZE MODEL
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');

// Create router
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

      // 5. Get Users model (using Users, not User)
      const UsersModel = models.Users;
      if (!UsersModel) {
        console.error('🔧 [AUTH] Users model not found in models:', Object.keys(models));
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
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

      // 11. Generate JWT token
      let token;
      try {
        token = jwt.sign(
          { 
            userId: user.id, 
            email: user.email, 
            username: user.username,
            role: user.role
          },
          JWT_SECRET,
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

      // 12. Return success response
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        userId: user.id,
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

      // 3. Get Users model
      const UsersModel = models.Users;
      if (!UsersModel) {
        console.error('🔧 [AUTH] Users model not found for login');
        return res.status(500).json({
          success: false,
          message: 'Users model not available',
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

      // 8. Generate JWT token
      let token;
      try {
        console.log('🔧 [AUTH] Generating JWT token for user:', user.id);
        token = jwt.sign(
          { 
            userId: user.id, 
            email: user.email, 
            username: user.username,
            role: user.role
          },
          JWT_SECRET,
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

// ===== AUTHENTICATION MIDDLEWARE FOR ROUTER =====
function authenticateTokenRouter(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required',
      timestamp: new Date().toISOString()
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('🔧 [AUTH] JWT Verification Error:', {
        name: err.name,
        message: err.message,
        stack: err.stack
      });
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token',
        error: !IS_PRODUCTION ? err.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
    req.user = user;
    next();
  });
}

// ===== PROFILE ENDPOINT =====
router.get(
  '/me',
  authenticateTokenRouter,
  asyncHandler(async (req, res) => {
    try {
      // Check if models are available
      const models = req.app.locals.models;
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
      console.error('🔧 [AUTH] Error fetching user profile:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      res.status(500).json({
        success: false,
        message: 'Failed to fetch user profile',
        error: !IS_PRODUCTION ? error.message : undefined,
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
          timestamp: new Date().toISOString()
        });
      }

      // Check if models are available from app.locals
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

      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      
      const UsersModel = models.Users;
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

      // Check if models are available from app.locals
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
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Check if user still exists
      const models = req.app.locals.models;
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
      console.error('🔧 [AUTH] JWT verification error:', {
        name: jwtError.name,
        message: jwtError.message,
        stack: jwtError.stack
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        error: !IS_PRODUCTION ? jwtError.message : undefined,
        timestamp: new Date().toISOString()
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
      timestamp: new Date().toISOString()
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

// CRITICAL: Export the router ONLY
module.exports = router;