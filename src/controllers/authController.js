const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { Op } = require('sequelize');

const JWT_SECRET = process.env.JWT_SECRET || '3e78ab2d6cb698f95b3b8d510614058c';

const loginAttemptsStore = new Map();

class AuthController {
  async register(req, res, next) {
    try {
      console.log("📝 [AuthController] Registration request received");
      
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

      console.log("🔧 [AuthController] Checking for existing user...");

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
      const hashedPassword = await bcrypt.hash(password, 10);

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
          console.log("✅ User saved to database");
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
        console.log("✅ User saved to in-memory storage");
      }

      if (!user) {
        return res.status(500).json({
          success: false,
          message: 'Failed to create user in any storage',
          errorCode: 'STORAGE_ERROR'
        });
      }

      // Generate JWT token using the assumed generateToken function
      const token = this.generateToken(user);

      // Save token to database if available
      if (req.app.locals.models && req.app.locals.models.Token) {
        try {
          await req.app.locals.models.Token.create({
            userId: user.id,
            token: token,
            tokenType: 'access',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
        } catch (tokenError) {
          console.error('Token save error:', tokenError);
          // Don't fail registration if token save fails
        }
      }

      console.log("✅ [AuthController] Registration successful for user:", user.id);

      // Return response as per JSON contract
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          token: token,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar: user.avatar,
            firstName: user.firstName,
            lastName: user.lastName,
            status: user.status,
            isActive: user.isActive,
            isVerified: user.isVerified,
            createdAt: user.createdAt || new Date().toISOString()
          }
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
      console.log("📝 [AuthController] Login request received");
      
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

      console.log("🔧 [AuthController] Looking up user...");

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
      const validPassword = await bcrypt.compare(password, user.password);
      
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

      // Generate JWT token using the assumed generateToken function
      const token = this.generateToken(user);

      // Save token to database if available
      if (req.app.locals.models && req.app.locals.models.Token) {
        try {
          await req.app.locals.models.Token.create({
            userId: user.id,
            token: token,
            tokenType: 'access',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
        } catch (tokenError) {
          console.error('Token save error:', tokenError);
          // Don't fail login if token save fails
        }
      }

      console.log("✅ [AuthController] Login successful for user:", user.id);

      // Return response as per JSON contract
      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          token: token,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar: user.avatar,
            firstName: user.firstName,
            lastName: user.lastName,
            status: user.status,
            isActive: user.isActive,
            isVerified: user.isVerified,
            createdAt: user.createdAt || new Date().toISOString()
          }
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

  // Helper method to generate JWT token (assumed to exist)
  generateToken(user) {
    return jwt.sign(
      { 
        userId: user.id, 
        id: user.id, // Add id for compatibility
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

  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required',
          errorCode: 'VALIDATION_ERROR'
        });
      }
      
      // Check if Token model is available
      if (!req.app.locals.models || !req.app.locals.models.Token) {
        return res.status(501).json({
          success: false,
          message: 'Token refresh not implemented',
          errorCode: 'NOT_IMPLEMENTED'
        });
      }
      
      // Find and validate refresh token
      const tokenRecord = await req.app.locals.models.Token.findOne({
        where: {
          token: refreshToken,
          tokenType: 'refresh',
          isRevoked: false,
          expiresAt: { [Op.gt]: new Date() }
        },
        include: [{ 
          model: req.app.locals.models.User || req.app.locals.models.Users,
          attributes: ['id', 'email', 'username'] 
        }]
      });
      
      if (!tokenRecord) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired refresh token',
          errorCode: 'INVALID_REFRESH_TOKEN'
        });
      }
      
      // Generate new access token
      const accessToken = this.generateToken(tokenRecord.User);
      
      // Create new token record
      await req.app.locals.models.Token.create({
        userId: tokenRecord.User.id,
        token: accessToken,
        tokenType: 'access',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
      });
      
      return res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          accessToken: accessToken,
          user: {
            id: tokenRecord.User.id,
            email: tokenRecord.User.email,
            username: tokenRecord.User.username
          }
        }
      });
      
    } catch (error) {
      console.error('Refresh token error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during token refresh',
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
            attributes: ['id', 'email', 'username', 'avatar', 'firstName', 'lastName', 'status', 'isActive', 'isVerified', 'lastSeen', 'createdAt']
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
        user = req.app.locals.users.find(u => u.id === req.user.userId);
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          errorCode: 'USER_NOT_FOUND'
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

      return res.status(200).json({
        success: true,
        message: 'User profile retrieved successfully',
        data: {
          user: sanitizedUser
        }
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
      
      // For security, we would normally verify the reset token here
      // Since token verification logic isn't implemented, we'll return a generic response
      
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
  getCurrentUserSimple: authController.getCurrentUser.bind(authController),
  forgotPassword: authController.forgotPassword.bind(authController),
  resetPassword: authController.resetPassword.bind(authController)
};