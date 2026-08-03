const _slog = (...a) => { if (process.env.DEBUG_SERVER) console.log(...a); };
// controllers/authController.js - COMPLETE FIXED VERSION
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { Op } = require('sequelize');
const tokenService = require('../services/tokenService');
// P1 FIX (Forensic Audit): bcrypt truncates at 72 bytes — pre-hash with SHA-256 first
const { hashPassword, comparePassword } = require('../utils/passwordUtils');

// SECURITY FIX #1: Crash fast if secret is absent — never fall through to a hardcoded literal.
// FIX (Forensic Audit P0): Use JWT_ACCESS_SECRET first to match tokenService.js signing order.
// Previously used JWT_SECRET first, causing verify failures when both env vars are set differently.
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET or JWT_ACCESS_SECRET env variable is not set. Server will not start.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

const loginAttemptsStore = new Map();

class AuthController {
  // SECURITY FIX #2: Removed generateToken() — it signed with raw JWT_SECRET which differs
  // from tokenService's JWT_ACCESS_SECRET, causing verification failures in auth middleware.
  // All token generation now delegates exclusively to tokenService (single source of truth).

  // Generates a long-lived refresh token via tokenService (7 days)
  generateRefreshToken(user) {
    return tokenService.generateRefreshToken(user);
  }

  // Builds the standard auth response object (ensures token + refreshToken + user always present)
  _buildAuthResponse(user, token, refreshToken) {
    return {
      success:      true,
      token:        token,
      accessToken:  token,          // alias for compatibility
      refreshToken: refreshToken || null,
      expiresIn:    24 * 60 * 60,   // seconds
      expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      user: {
        id:       user.id,
        username: user.username,
        email:    user.email,
        avatar:   user.avatar   || null,
        role:     user.role     || 'user',
        status:   user.status   || 'online'
      }
    };
  }

  async register(req, res, next) {
    try {
      _slog("📝 [AuthController] Registration request received");
      
      const { username, email, password, firstName, lastName } = req.body;

      // Validate all required fields
      if (!email || !password || !username) {
        return res.status(400).json({
          success: false,
          message: 'Email, username, and password are required',
          errorCode: 'VALIDATION_ERROR'
        });
      }

      // Validate password is not empty
      if (!password || password.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Password cannot be empty',
          errorCode: 'VALIDATION_ERROR'
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
          errorCode: 'VALIDATION_ERROR'
        });
      }

      _slog("🔧 [AuthController] Checking for existing user...");

      // Check if user already exists in database
      let existingUser = null;
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          existingUser = await UsersModel.findOne({
            where: {
              [Op.or]: [
                { email: email.toLowerCase().trim() },
                { username: username.trim() }
              ]
            }
          });
        } catch (dbError) {
          console.error('Database check error:', dbError);
          return res.status(500).json({
            success: false,
            message: 'Database error occurred',
            errorCode: 'DATABASE_ERROR'
          });
        }
      }

      // If database not available, check in-memory
      if (!existingUser && req.app.locals.users) {
        existingUser = req.app.locals.users.find(u => 
          u.email === email.toLowerCase().trim() || 
          u.username === username.trim()
        );
      }

      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: 'User already exists with this email or username',
          errorCode: 'USER_EXISTS'
        });
      }

      // Hash password with bcrypt
      const hashedPassword = await hashPassword(password);
      
      // Create avatar URL
      const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`;

      let user;
      
      // Try to save to database first
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.create({
            email: email.toLowerCase().trim(),
            username: username.trim(),
            password: hashedPassword,
            avatar: avatar,
            firstName: firstName || null,
            lastName: lastName || null,
            status: 'online',
            isActive: true,
            isVerified: false
          });
          _slog("✅ User saved to database");
        } catch (dbError) {
          console.error('Database save error:', dbError);
          return res.status(500).json({
            success: false,
            message: 'Failed to create user in database',
            errorCode: 'DATABASE_ERROR'
          });
        }
      }

      // If database save failed or not available, use in-memory
      if (!user && req.app.locals.users) {
        user = {
          id: Date.now().toString(),
          email: email.toLowerCase().trim(),
          username: username.trim(),
          password: hashedPassword,
          avatar: avatar,
          firstName: firstName || null,
          lastName: lastName || null,
          status: 'online',
          isActive: true,
          isVerified: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        req.app.locals.users.push(user);
        _slog("✅ User saved to in-memory storage");
      }

      if (!user) {
        return res.status(500).json({
          success: false,
          message: 'Failed to create user in any storage',
          errorCode: 'STORAGE_ERROR'
        });
      }

      // ── ADMIN BOOTSTRAP (reads admin identity from .env for security) ──────
      // Same promotion as login: if this brand-new account matches
      // ADMIN_EMAIL/ADMIN_USERNAME in .env, mark it admin immediately.
      try {
        const adminEmail    = (process.env.ADMIN_EMAIL    || '').toLowerCase().trim();
        const adminUsername = (process.env.ADMIN_USERNAME || '').toLowerCase().trim();
        const userEmail     = (user.email    || '').toLowerCase().trim();
        const userUsername  = (user.username || '').toLowerCase().trim();
        const matchesAdminEnv =
          (adminEmail    && userEmail    && userEmail    === adminEmail) ||
          (adminUsername && userUsername && userUsername === adminUsername);
        if (matchesAdminEnv && user.role !== 'admin' && typeof user.update === 'function') {
          await user.update({ role: 'admin' });
        }
      } catch (adminBootstrapError) {
        console.error('[Auth] Admin bootstrap check failed:', adminBootstrapError.message);
      }

      // Generate JWT tokens using tokenService
      const accessToken = tokenService.generateAccessToken(user);
      const refreshToken = tokenService.generateRefreshToken(user);
      
      // Store refresh token
      await tokenService.storeRefreshToken(refreshToken, user.id, 7 * 24 * 60 * 60 * 1000, {
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || null
      });

      // Save token to database if available
      if (req.app.locals.models && req.app.locals.models.Token) {
        try {
          await req.app.locals.models.Token.create({
            userId: user.id,
            token: accessToken,
            tokenType: 'access',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
        } catch (tokenError) {
          console.error('Token save error:', tokenError);
          // Don't fail registration if token save fails
        }
      }

      _slog("✅ [AuthController] Registration successful for user:", user.id);

      // CRITICAL FIX: Return consistent token format that frontend expects
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        accessToken: accessToken,
        refreshToken: refreshToken,
        token: accessToken, // Direct token property for frontend
        user: { // Direct user object for frontend
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status,
          role: user.role || 'user',
          isActive: user.isActive,
          isVerified: user.isVerified,
          createdAt: user.createdAt || new Date().toISOString()
        }
      });
      
    } catch (error) {
      console.error('❌ [AuthController] Registration error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during registration',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }

  async login(req, res, next) {
    try {
      _slog("📝 [AuthController] Login request received");
      
      const { identifier, password } = req.body;

      // Validate required fields
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email or username) and password are required',
          errorCode: 'VALIDATION_ERROR'
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
            errorCode: 'RATE_LIMITED'
          });
        } else {
          // Reset after block time expires
          attempts.count = 0;
        }
      }

      _slog("🔧 [AuthController] Looking up user...");

      let user = null;
      
      // Try database first
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          if (validator.isEmail(identifier)) {
            user = await UsersModel.findOne({
              where: { email: identifier.toLowerCase().trim() } 
            });
          } else {
            user = await UsersModel.findOne({
              where: { username: identifier.trim() } 
            });
          }
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return res.status(500).json({
            success: false,
            message: 'Database error occurred',
            errorCode: 'DATABASE_ERROR'
          });
        }
      }

      // If database not available or user not found, check in-memory
      if (!user && req.app.locals.users) {
        if (validator.isEmail(identifier)) {
          user = req.app.locals.users.find(u => u.email === identifier.toLowerCase().trim());
        } else {
          user = req.app.locals.users.find(u => u.username === identifier.trim());
        }
      }

      if (!user) {
        // Increment failed attempts
        attempts.count++;
        attempts.lastAttempt = Date.now();
        loginAttemptsStore.set(attemptKey, attempts);
        
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          errorCode: 'INVALID_CREDENTIALS'
        });
      }

      // Check password using bcrypt compare
      const validPassword = await comparePassword(password, user.password);
      
      if (!validPassword) {
        // Increment failed attempts
        attempts.count++;
        attempts.lastAttempt = Date.now();
        loginAttemptsStore.set(attemptKey, attempts);
        
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          errorCode: 'INVALID_CREDENTIALS'
        });
      }

      // Reset attempts on successful login
      loginAttemptsStore.delete(attemptKey);

      // ── ADMIN BOOTSTRAP (reads admin identity from .env for security) ──────
      // FIX (admin-features-not-recognized): previously nothing anywhere ever
      // read an admin email/username from .env — role only ever came from
      // whatever was already sitting in the users table (default 'user'), so
      // saving admin credentials in Render's env panel had no effect at all.
      // Whoever logs in with the identifier matching ADMIN_EMAIL or
      // ADMIN_USERNAME in .env is promoted to role='admin' right here, before
      // the JWT (which embeds role) is generated.
      try {
        const adminEmail    = (process.env.ADMIN_EMAIL    || '').toLowerCase().trim();
        const adminUsername = (process.env.ADMIN_USERNAME || '').toLowerCase().trim();
        const userEmail     = (user.email    || '').toLowerCase().trim();
        const userUsername  = (user.username || '').toLowerCase().trim();
        const matchesAdminEnv =
          (adminEmail    && userEmail    && userEmail    === adminEmail) ||
          (adminUsername && userUsername && userUsername === adminUsername);
        if (matchesAdminEnv && user.role !== 'admin' && typeof user.update === 'function') {
          await user.update({ role: 'admin' });
          _slog(`[Auth] Promoted ${user.email || user.username} to admin role (matched ADMIN_EMAIL/ADMIN_USERNAME in .env)`);
        }
      } catch (adminBootstrapError) {
        console.error('[Auth] Admin bootstrap check failed:', adminBootstrapError.message);
      }

      // Generate JWT tokens using tokenService
      const accessToken = tokenService.generateAccessToken(user);
      const refreshToken = tokenService.generateRefreshToken(user);
      
      // Store refresh token
      await tokenService.storeRefreshToken(refreshToken, user.id, 7 * 24 * 60 * 60 * 1000, {
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || null
      });

      // Save token to database if available
      if (req.app.locals.models && req.app.locals.models.Token) {
        try {
          await req.app.locals.models.Token.create({
            userId: user.id,
            token: accessToken,
            tokenType: 'access',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
        } catch (tokenError) {
          console.error('Token save error:', tokenError);
          // Don't fail login if token save fails
        }
      }

      // Update user status
      if (user.update) {
        try {
          await user.update({
            status: 'online',
            lastSeen: new Date()
          });
        } catch (updateError) {
          console.error('User status update error:', updateError.message);
        }
      }

      _slog("✅ [AuthController] Login successful for user:", user.id);

      // CRITICAL FIX: Return consistent token format that frontend expects
      return res.status(200).json({
        success: true,
        message: 'Login successful',
        accessToken: accessToken,
        refreshToken: refreshToken,
        token: accessToken, // Direct token property for frontend
        user: { // Direct user object for frontend
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          firstName: user.firstName,
          lastName: user.lastName,
          status: 'online',
          role: user.role || 'user',
          isActive: user.isActive,
          isVerified: user.isVerified,
          createdAt: user.createdAt || new Date().toISOString()
        }
      });
      
    } catch (error) {
      console.error('❌ [AuthController] Login error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during login',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }

  async refreshToken(req, res, next) {
    try {
      _slog("📝 [AuthController] Refresh token request received");
      
      const refreshToken = tokenService.extractRefreshTokenFromRequest(req);
      
      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required',
          errorCode: 'REFRESH_TOKEN_REQUIRED'
        });
      }
      
      // Verify refresh token
      const verification = tokenService.verifyRefreshToken(refreshToken);
      
      if (!verification.valid) {
        return res.status(401).json({
          success: false,
          message: verification.error === 'REFRESH_TOKEN_EXPIRED' 
            ? 'Refresh token expired. Please login again.' 
            : 'Invalid refresh token',
          errorCode: verification.error
        });
      }
      
      // Verify stored refresh token
      const storedCheck = await tokenService.validateStoredRefreshToken(refreshToken);
      if (!storedCheck.valid) {
        return res.status(401).json({
          success: false,
          message: 'Invalid refresh token',
          errorCode: 'INVALID_REFRESH_TOKEN'
        });
      }
      
      const userId = verification.decoded.userId;
      
      // Get user from database
      let user = null;
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
        user = await UsersModel.findByPk(userId);
      }
      
      if (!user && req.app.locals.users) {
        user = req.app.locals.users.find(u => u.id === userId);
      }
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          errorCode: 'USER_NOT_FOUND'
        });
      }
      
      // Generate new tokens
      const newAccessToken = tokenService.generateAccessToken(user);
      const newRefreshToken = tokenService.generateRefreshToken(user);
      
      // Invalidate old refresh token and store new one
      await tokenService.invalidateRefreshToken(refreshToken);
      await tokenService.storeRefreshToken(newRefreshToken, user.id, 7 * 24 * 60 * 60 * 1000, {
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || null
      });
      
      _slog("✅ [AuthController] Refresh token successful for user:", userId);
      
      return res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        token: newAccessToken
      });
      
    } catch (error) {
      console.error('❌ [AuthController] Refresh token error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during token refresh',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }

  // CRITICAL FIX: Updated validateToken to match the format that frontend expects
  async validateToken(req, res, next) {
    _slog('=' .repeat(60));
    _slog('🔵🔵🔵 AUTHCONTROLLER.JS validateToken method CALLED 🔵🔵🔵');
    _slog('=' .repeat(60));
    
    try {
      // Extract token from request
      let token = null;
      
      if (req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
          token = parts[1];
          _slog('[CONTROLLER] Token from Authorization header');
        }
      }
      
      if (!token && req.body.token) {
        token = req.body.token;
        _slog('[CONTROLLER] Token from body');
      }
      
      if (!token) {
        _slog('[CONTROLLER] ❌ No token');
        return res.status(401).json({
          success: false,
          valid: false,
          authValidated: false,
          message: 'Token is required'
        });
      }
      
      // CRITICAL FIX: Use tokenService for verification (single source of truth)
      const verification = tokenService.verifyAccessToken(token);
      
      if (!verification.valid) {
        _slog('[CONTROLLER] ❌ Token verification failed:', verification.error);
        return res.status(401).json({
          success: false,
          valid: false,
          authValidated: false,
          message: verification.error === 'TOKEN_EXPIRED' ? 'Token has expired' : 'Invalid token',
          errorCode: verification.error
        });
      }
      
      const decoded = verification.decoded;
      const userId = decoded.userId || decoded.id;
      
      _slog('[CONTROLLER] ✅ Token verified for user:', userId);
      
      // CRITICAL FIX: Fetch user from database if available
      let user = null;
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(userId, {
            attributes: { exclude: ['password'] }
          });
        } catch (dbError) {
          console.error('[CONTROLLER] Database lookup error:', dbError.message);
        }
      }
      
      // CRITICAL FIX: Return the SAME format as routes/auth.js validate-token endpoint
      return res.status(200).json({
        success: true,           // ← MUST BE TRUE
        valid: true,             // ← MUST BE TRUE
        authValidated: true,     // ← MUST BE TRUE
        message: 'Token is valid',
        user: user ? {
          id: user.id,
          userId: user.id,
          email: user.email,
          username: user.username,
          role: user.role || 'user',
          avatar: user.avatar,
          isVerified: user.isVerified,
          status: user.status
        } : {
          id: userId,
          userId: userId,
          email: decoded.email || null,
          username: decoded.username || null,
          role: decoded.role || 'user'
        },
        userId: userId,
        expiresIn: decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 86400,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('[CONTROLLER] ❌ Error:', error);
      return res.status(500).json({
        success: false,
        valid: false,
        authValidated: false,
        message: 'Failed to validate token',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }

  async logout(req, res, next) {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      
      if (token && req.app.locals.models && req.app.locals.models.Token) {
        try {
          // Revoke token in database
          await req.app.locals.models.Token.update(
            { isRevoked: true },
            { where: { token: token } }
          );
        } catch (dbError) {
          console.error('Token revoke error:', dbError);
          // Continue with logout even if token revoke fails
        }
      }
      
      // Get refresh token and invalidate it
      const refreshToken = tokenService.extractRefreshTokenFromRequest(req);
      if (refreshToken) {
        await tokenService.invalidateRefreshToken(refreshToken);
      }
      
      // Update user status if user exists
      if (req.user && req.user.userId && req.app.locals.models) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          if (UsersModel) {
            await UsersModel.update(
              { status: 'offline', lastSeen: new Date() },
              { where: { id: req.user.userId } }
            );
          }
        } catch (updateError) {
          console.error('User status update error:', updateError.message);
        }
      }
      
      // Clear cookies
      res.clearCookie('refreshToken');
      res.clearCookie('accessToken');
      
      return res.status(200).json({
        success: true,
        message: 'Logged out successfully'
      });
      
    } catch (error) {
      console.error('Logout error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during logout',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }

  async getCurrentUser(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Not authenticated",
          errorCode: 'NOT_AUTHENTICATED'
        });
      }

      let user = null;
      
      // Try database first
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(req.user.userId, {
            attributes: { exclude: ['password'] }
          });
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          // Don't fail, try to use in-memory or token data
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        user = req.app.locals.users.find(u => u.id === req.user.userId);
      }

      // If still no user, use data from token
      if (!user) {
        return res.status(200).json({
          success: true,
          message: 'User profile retrieved from token',
          user: {
            id: req.user.userId,
            email: req.user.email,
            username: req.user.username,
            role: req.user.role || 'user',
            status: 'online'
          }
        });
      }

      // Return sanitized user data
      const sanitizedUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        avatar: user.avatar || null,
        status: user.status || 'offline',
        role: user.role || 'user',
        isActive: user.isActive !== undefined ? user.isActive : true,
        isVerified: user.isVerified !== undefined ? user.isVerified : false,
        lastSeen: user.lastSeen || null,
        createdAt: user.createdAt || new Date().toISOString()
      };

      return res.status(200).json({
        success: true,
        message: 'User profile retrieved successfully',
        user: sanitizedUser
      });
      
    } catch (error) {
      console.error('Get current user error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error fetching user data',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }
  
  async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      let user = null;
      
      // Try database first
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findOne({
            where: { email: email.toLowerCase().trim() }
          });
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return res.status(500).json({
            success: false,
            message: 'Database error occurred',
            errorCode: 'DATABASE_ERROR'
          });
        }
      }
      
      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        user = req.app.locals.users.find(u => u.email === email.toLowerCase().trim());
      }
      
      // Generate reset token if user exists
      if (user) {
        const resetToken = jwt.sign(
          { userId: user.id, email: user.email, type: 'reset' },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
        
        // Store reset token
        if (user.update) {
          try {
            await user.update({
              resetToken: resetToken,
              resetTokenExpiry: new Date(Date.now() + 3600000)
            });
          } catch (updateError) {
            console.error('Reset token save error:', updateError.message);
          }
        }
        
        _slog(`📧 Password reset token for ${email}: ${resetToken}`);
      }
      
      // Always return success for security (don't reveal if user exists)
      return res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent'
      });
      
    } catch (error) {
      console.error('Forgot password error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during password reset',
        errorCode: 'INTERNAL_ERROR'
      });
    }
  }
  
  async resetPassword(req, res, next) {
    try {
      const { token, newPassword, confirmPassword } = req.body;
      
      if (!token || !newPassword || !confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'Token, new password, and confirm password are required',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'Passwords do not match',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      // Validate password
      if (!newPassword || newPassword.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Password cannot be empty',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 6 characters',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type !== 'reset') {
          return res.status(401).json({
            success: false,
            message: 'Invalid reset token',
            errorCode: 'INVALID_TOKEN'
          });
        }
      } catch (jwtError) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired reset token',
          errorCode: 'INVALID_TOKEN'
        });
      }
      
      // Find user
      let user = null;
      if (req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findOne({
            where: {
              id: decoded.userId,
              resetToken: token,
              resetTokenExpiry: { [Op.gt]: new Date() }
            }
          });
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return res.status(500).json({
            success: false,
            message: 'Database error occurred',
            errorCode: 'DATABASE_ERROR'
          });
        }
      }
      
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired reset token',
          errorCode: 'INVALID_TOKEN'
        });
      }
      
      // Hash new password
      const hashedPassword = await hashPassword(newPassword);
      
      // Update password
      await user.update({
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
        updatedAt: new Date()
      });
      
      return res.status(200).json({
        success: true,
        message: 'Password has been reset successfully'
      });
      
    } catch (error) {
      console.error('Reset password error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during password reset',
        errorCode: 'INTERNAL_ERROR'
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
    
    _slog(`🧹 [AuthController] Cleaned up old login attempts. Remaining: ${loginAttemptsStore.size}`);
  }
}

// Start periodic cleanup of old login attempts
setInterval(() => {
  AuthController.cleanupOldAttempts();
}, 3600000);

// Export all controller functions as named exports
const authController = new AuthController();

module.exports = {
  register: authController.register.bind(authController),
  login: authController.login.bind(authController),
  logout: authController.logout.bind(authController),
  refreshToken: authController.refreshToken.bind(authController),
  validateToken: authController.validateToken.bind(authController),
  getCurrentUser: authController.getCurrentUser.bind(authController),
  getCurrentUserSimple: authController.getCurrentUser.bind(authController),
  forgotPassword: authController.forgotPassword.bind(authController),
  resetPassword: authController.resetPassword.bind(authController)
};