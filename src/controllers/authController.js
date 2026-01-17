const authService = require('../services/authService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const validator = require('validator');
const jwt = require('jsonwebtoken');
const { User, Token } = require('../models'); // Import User and Token models

class AuthController {
  async register(req, res, next) {
    try {
      console.log("AUTH BODY (Register):", req.body);
      
      const { username, email, password, firstName, lastName, profile } = req.body;

      logger.info(`Registration attempt for: ${email}`, { username });

      // Validate all required fields - middleware already validated, but double-check
      if (!email || !password || !username) {
        return res.status(400).json({
          success: false,
          message: 'Email, username, and password are required'
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Check if user already exists with this email or username
      const existingUser = await User.findOne({
        where: {
          [User.sequelize.Op.or]: [
            { email: email.toLowerCase().trim() },
            { username: username.trim() }
          ]
        }
      });

      if (existingUser) {
        const field = existingUser.email === email.toLowerCase().trim() ? 'Email' : 'Username';
        return res.status(409).json({
          success: false,
          message: `${field} already exists`
        });
      }

      // Trim and validate optional fields
      const sanitizedData = {
        username: username.trim(),
        email: email.toLowerCase().trim(),
        password,
        firstName: firstName ? firstName.trim() : null,
        lastName: lastName ? lastName.trim() : null,
        profile: profile || null,
        isActive: true,
        isVerified: true // Set to true so users can login immediately after registration
      };

      // Additional validation for optional fields
      if (sanitizedData.firstName && sanitizedData.firstName.length > 50) {
        return res.status(400).json({
          success: false,
          message: 'First name cannot exceed 50 characters'
        });
      }
      if (sanitizedData.lastName && sanitizedData.lastName.length > 50) {
        return res.status(400).json({
          success: false,
          message: 'Last name cannot exceed 50 characters'
        });
      }

      // Create user using User model directly
      const user = await User.create(sanitizedData);

      // Create access token for the new user
      const token = await Token.create({
        userId: user.id,
        token: Token.generateRandomToken(64),
        tokenType: 'access',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      });

      // Log successful registration
      logger.info(`User registered successfully: ${email}`, { 
        userId: user.id,
        username: user.username 
      });

      // Return JSON response with user and token
      return res.status(201).json({
        success: true,
        message: 'Registration successful',
        data: {
          user: user.toJSON(),
          token: token.token
        }
      });
    } catch (error) {
      logger.error('Registration controller error:', {
        error: error.message,
        stack: error.stack,
        email: req.body.email
      });
      
      // Handle duplicate email/username errors specifically
      if (error.name === 'SequelizeUniqueConstraintError') {
        const field = error.errors[0]?.path || 'field';
        return res.status(409).json({
          success: false,
          message: `${field} already exists`
        });
      }
      
      // Handle validation errors
      if (error.name === 'SequelizeValidationError') {
        const messages = error.errors.map(err => err.message);
        return res.status(400).json({
          success: false,
          message: messages.join(', ')
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async login(req, res, next) {
    try {
      console.log("AUTH BODY (Login):", req.body);
      
      const { identifier, password } = req.body;

      logger.info(`Login attempt for identifier: ${identifier}`);

      // Validate required fields
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: 'Identifier (email or username) and password are required'
        });
      }

      let user;
      const { Op } = User.sequelize.Sequelize;

      // Find user by email or username
      if (validator.isEmail(identifier)) {
        user = await User.findOne({ 
          where: { 
            email: identifier.toLowerCase().trim(),
            isActive: true 
          } 
        });
      } else {
        user = await User.findOne({ 
          where: { 
            username: identifier.trim(),
            isActive: true 
          } 
        });
      }

      // If user not found, return 401 Unauthorized
      if (!user) {
        logger.warn(`Login failed: User not found for identifier: ${identifier}`);
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // REMOVED email verification check so users can login immediately after registration
      // if (!user.isVerified) {
      //   logger.warn(`Login failed: Email not verified for user: ${user.email}`);
      //   return res.status(403).json({
      //     success: false,
      //     message: 'Please verify your email address before logging in'
      //   });
      // }

      // Validate password
      const isValid = await user.validatePassword(password);
      if (!isValid) {
        logger.warn(`Login failed: Invalid password for user: ${user.email}`);
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Revoke existing tokens for this user (optional security measure)
      await Token.revokeAllUserTokens(user.id);

      // Create a new access token for this user
      const token = await Token.create({
        userId: user.id,
        token: Token.generateRandomToken(64),
        tokenType: 'access',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      });

      // Update user's last seen timestamp
      user.lastSeen = new Date();
      await user.save();

      // Log successful login
      logger.info(`User logged in successfully: ${user.email}`, { 
        userId: user.id,
        username: user.username 
      });

      // Return JSON response with user and token
      return res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: user.toJSON(),
          token: token.token
        }
      });
    } catch (error) {
      logger.error('Login controller error:', {
        error: error.message,
        stack: error.stack,
        identifier: req.body.identifier
      });
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required'
        });
      }

      // Validate refresh token format
      if (typeof refreshToken !== 'string' || refreshToken.length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Invalid refresh token format'
        });
      }

      const result = await authService.refreshToken(refreshToken);

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          user: result.user,
          tokens: result.tokens,
        },
      });
    } catch (error) {
      logger.error('Refresh token controller error:', error);
      
      // Handle invalid refresh token
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired refresh token"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async logout(req, res, next) {
    try {
      const accessToken = req.headers.authorization?.split(' ')[1];
      const { refreshToken } = req.body;

      // Validate tokens
      if (!accessToken && !refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'At least one token is required for logout'
        });
      }

      await authService.logout(accessToken, refreshToken);

      // Log successful logout
      logger.info('User logged out successfully', { userId: req.user?.id });

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      logger.error('Logout controller error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async verifyEmail(req, res, next) {
    try {
      const { token } = req.query;

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Verification token is required'
        });
      }

      // Validate token format
      if (typeof token !== 'string' || token.length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Invalid verification token format'
        });
      }

      const user = await authService.verifyEmail(token);

      // Log successful verification
      logger.info(`Email verified for user: ${user.email}`, { userId: user.id });

      res.json({
        success: true,
        message: 'Email verified successfully',
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      logger.error('Verify email controller error:', error);
      
      // Handle invalid or expired token
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification token"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async requestPasswordReset(req, res, next) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      await authService.requestPasswordReset(email);

      // Log password reset request
      logger.info(`Password reset requested for: ${email}`);

      res.json({
        success: true,
        message: 'Password reset instructions sent to your email',
      });
    } catch (error) {
      logger.error('Request password reset controller error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async resetPassword(req, res, next) {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Token and new password are required'
        });
      }

      // Validate token format
      if (typeof token !== 'string' || token.length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Invalid reset token format'
        });
      }

      // Validate password strength
      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters long'
        });
      }
      
      // Additional password complexity
      if (!/[A-Z]/.test(newPassword)) {
        return res.status(400).json({
          success: false,
          message: 'Password must contain at least one uppercase letter'
        });
      }
      if (!/[a-z]/.test(newPassword)) {
        return res.status(400).json({
          success: false,
          message: 'Password must contain at least one lowercase letter'
        });
      }
      if (!/[0-9]/.test(newPassword)) {
        return res.status(400).json({
          success: false,
          message: 'Password must contain at least one number'
        });
      }

      await authService.resetPassword(token, newPassword);

      // Log successful password reset
      logger.info('Password reset successful');

      res.json({
        success: true,
        message: 'Password reset successful',
      });
    } catch (error) {
      logger.error('Reset password controller error:', error);
      
      // Handle invalid or expired token
      if (error.message.includes('invalid') || error.message.includes('expired')) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired reset token"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  async validateToken(req, res, next) {
    try {
      const token = req.headers.authorization?.split(' ')[1];

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Token is required'
        });
      }

      const decoded = await authService.validateToken(token);

      res.json({
        success: true,
        data: {
          valid: true,
          decoded,
        },
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        data: {
          valid: false,
          error: error.message,
        },
      });
    }
  }

  async getCurrentUser(req, res, next) {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized"
        });
      }

      // Create sanitized user object with avatar
      const sanitizedUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar || null,
        bio: user.bio || null,
        phone: user.phone || null,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
        isVerified: user.isVerified || false,
        status: user.status || 'offline',
        lastSeen: user.lastSeen,
        settings: user.settings || {},
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };

      res.json({
        success: true,
        data: {
          user: sanitizedUser
        }
      });
    } catch (error) {
      logger.error('Get current user controller error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('invalid token')) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized"
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
}

module.exports = new AuthController();