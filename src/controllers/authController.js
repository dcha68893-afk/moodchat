const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { Users, Tokens } = require('../models'); // CHANGED: 'User' → 'Users', 'Token' → 'Tokens'
const { Op } = require('sequelize');

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';

// In-memory store for login attempts (fallback)
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
          message: 'Email, username, and password are required',
          timestamp: new Date().toISOString()
        });
      }

      // Validate password is not empty
      if (!password || password.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Password cannot be empty',
          timestamp: new Date().toISOString()
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
          timestamp: new Date().toISOString()
        });
      }

      console.log("🔧 [AuthController] Checking for existing user...");

      // Check if user already exists in database
      let existingUser = null;
      if (req.app.locals.models && req.app.locals.models.Users) { // CHANGED: 'User' → 'Users'
        try {
          existingUser = await req.app.locals.models.Users.findOne({ // CHANGED: 'User' → 'Users'
            where: {
              [Op.or]: [
                { email: email.toLowerCase().trim() },
                { username: username.trim() }
              ]
            }
          });
        } catch (dbError) {
          console.error('Database check error:', dbError);
          return next(dbError);
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
          timestamp: new Date().toISOString()
        });
      }

      // Hash password with bcrypt
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create avatar URL
      const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`;

      let user;
      
      // Try to save to database first
      if (req.app.locals.models && req.app.locals.models.Users) { // CHANGED: 'User' → 'Users'
        try {
          user = await req.app.locals.models.Users.create({ // CHANGED: 'User' → 'Users'
            email: email.toLowerCase().trim(),
            username: username.trim(),
            password: hashedPassword,
            avatar: avatar,
            firstName: firstName || null,
            lastName: lastName || null,
            status: 'online', // ADDED: Missing field
            isActive: true,   // ADDED: Missing field
            isVerified: false // ADDED: Missing field
          });
          console.log("✅ User saved to database");
        } catch (dbError) {
          console.error('Database save error:', dbError);
          return next(dbError);
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
          status: 'online', // ADDED
          isActive: true,   // ADDED
          isVerified: false, // ADDED
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        req.app.locals.users.push(user);
        console.log("✅ User saved to in-memory storage");
      }

      if (!user) {
        const error = new Error('Failed to create user in any storage');
        return next(error);
      }

      // Generate JWT token using the assumed generateToken function
      const token = this.generateToken(user);

      // Save token to database if available
      if (req.app.locals.models && req.app.locals.models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        try {
          await req.app.locals.models.Tokens.create({ // CHANGED: 'Token' → 'Tokens'
            userId: user.id,
            token: token,
            type: 'access', // CHANGED: 'tokenType' → 'type'
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
        } catch (tokenError) {
          console.error('Token save error:', tokenError);
          // Don't fail registration if token save fails
        }
      }

      console.log("✅ [AuthController] Registration successful for user:", user.id);

      // Return response as per example structure
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        token: token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status, // ADDED
          isActive: user.isActive, // ADDED
          isVerified: user.isVerified, // ADDED
          createdAt: user.createdAt || new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ [AuthController] Registration error:', error.message);
      console.error('Error stack:', error.stack);
      return next(error);
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
          message: 'Identifier (email or username) and password are required',
          timestamp: new Date().toISOString()
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
            remainingTime: remainingTime,
            timestamp: new Date().toISOString()
          });
        } else {
          // Reset after block time expires
          attempts.count = 0;
        }
      }

      console.log("🔧 [AuthController] Looking up user...");

      let user = null;
      
      // Try database first
      if (req.app.locals.models && req.app.locals.models.Users) { // CHANGED: 'User' → 'Users'
        try {
          if (validator.isEmail(identifier)) {
            user = await req.app.locals.models.Users.findOne({ // CHANGED: 'User' → 'Users'
              where: { email: identifier.toLowerCase().trim() } 
            });
          } else {
            user = await req.app.locals.models.Users.findOne({ // CHANGED: 'User' → 'Users'
              where: { username: identifier.trim() } 
            });
          }
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return next(dbError);
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
          attemptCount: attempts.count,
          maxAttempts: maxAttempts,
          timestamp: new Date().toISOString()
        });
      }

      // Check password using bcrypt compare
      const validPassword = await bcrypt.compare(password, user.password);
      
      if (!validPassword) {
        // Increment failed attempts
        attempts.count++;
        attempts.lastAttempt = Date.now();
        loginAttemptsStore.set(attemptKey, attempts);
        
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
          attemptCount: attempts.count,
          maxAttempts: maxAttempts,
          timestamp: new Date().toISOString()
        });
      }

      // Reset attempts on successful login
      loginAttemptsStore.delete(attemptKey);

      // Generate JWT token using the assumed generateToken function
      const token = this.generateToken(user);

      // Save token to database if available
      if (req.app.locals.models && req.app.locals.models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        try {
          await req.app.locals.models.Tokens.create({ // CHANGED: 'Token' → 'Tokens'
            userId: user.id,
            token: token,
            type: 'access', // CHANGED: 'tokenType' → 'type'
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
        } catch (tokenError) {
          console.error('Token save error:', tokenError);
          // Don't fail login if token save fails
        }
      }

      console.log("✅ [AuthController] Login successful for user:", user.id);

      // Return response as per example structure
      return res.json({
        success: true,
        message: 'Login successful',
        token: token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status, // ADDED
          isActive: user.isActive, // ADDED
          isVerified: user.isVerified, // ADDED
          createdAt: user.createdAt || new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ [AuthController] Login error:', error.message);
      return next(error);
    }
  }

  // Helper method to generate JWT token (assumed to exist)
  generateToken(user) {
    return jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
  }

  async logout(req, res, next) {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      
      if (token && req.app.locals.models && req.app.locals.models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        // Revoke token in database
        await req.app.locals.models.Tokens.update( // CHANGED: 'Token' → 'Tokens'
          { isRevoked: true },
          { where: { token: token } }
        );
      }
      
      return res.json({
        success: true,
        message: 'Logged out successfully',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Logout error:', error);
      return next(error);
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required',
          timestamp: new Date().toISOString()
        });
      }
      
      // Check if Token model is available
      if (!req.app.locals.models || !req.app.locals.models.Tokens) { // CHANGED: 'Token' → 'Tokens'
        return res.status(501).json({
          success: false,
          message: 'Token refresh not implemented',
          timestamp: new Date().toISOString()
        });
      }
      
      // Find and validate refresh token
      const tokenRecord = await req.app.locals.models.Tokens.findOne({ // CHANGED: 'Token' → 'Tokens'
        where: {
          token: refreshToken,
          type: 'refresh', // CHANGED: 'tokenType' → 'type'
          isRevoked: false,
          expiresAt: { [Op.gt]: new Date() }
        },
        include: [{ 
          model: req.app.locals.models.Users, // CHANGED: 'User' → 'Users'
          attributes: ['id', 'email', 'username'] 
        }]
      });
      
      if (!tokenRecord) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired refresh token',
          timestamp: new Date().toISOString()
        });
      }
      
      // Generate new access token
      const accessToken = this.generateToken(tokenRecord.User);
      
      // Create new token record
      await req.app.locals.models.Tokens.create({ // CHANGED: 'Token' → 'Tokens'
        userId: tokenRecord.User.id,
        token: accessToken,
        type: 'access', // CHANGED: 'tokenType' → 'type'
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
      });
      
      return res.json({
        success: true,
        message: 'Token refreshed successfully',
        accessToken: accessToken,
        user: {
          id: tokenRecord.User.id,
          email: tokenRecord.User.email,
          username: tokenRecord.User.username
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Refresh token error:', error);
      return next(error);
    }
  }

  async getCurrentUser(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Not authenticated",
          timestamp: new Date().toISOString()
        });
      }

      let user = null;
      
      // Try database first
      if (req.app.locals.models && req.app.locals.models.Users) { // CHANGED: 'User' → 'Users'
        try {
          user = await req.app.locals.models.Users.findByPk(req.user.userId, { // CHANGED: 'User' → 'Users'
            attributes: ['id', 'email', 'username', 'avatar', 'firstName', 'lastName', 'status', 'isActive', 'isVerified', 'lastSeen', 'createdAt']
          });
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        user = req.app.locals.users.find(u => u.id === req.user.userId);
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
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
        isActive: user.isActive !== undefined ? user.isActive : true,
        isVerified: user.isVerified !== undefined ? user.isVerified : false,
        lastSeen: user.lastSeen || null,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
        createdAt: user.createdAt || new Date().toISOString()
      };

      res.json({
        success: true,
        user: sanitizedUser,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Get current user error:', error);
      return next(error);
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

// Export all controller functions as named exports
const authController = new AuthController();

module.exports = {
  register: authController.register.bind(authController),
  login: authController.login.bind(authController),
  logout: authController.logout.bind(authController),
  refreshToken: authController.refreshToken.bind(authController),
  getCurrentUser: authController.getCurrentUser.bind(authController),
  getCurrentUserSimple: authController.getCurrentUser.bind(authController)
};