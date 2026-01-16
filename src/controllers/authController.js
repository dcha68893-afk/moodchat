const authService = require('../services/authService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const validator = require('validator');
const jwt = require('jsonwebtoken');

class AuthController {
  async register(req, res, next) {
    try {
      const { username, email, password, firstName, lastName, profile } = req.body;

      // Validate all required fields
      if (!email || !password || !username) {
        throw new AppError('Email, username, and password are required', 400);
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        throw new AppError('Invalid email format', 400);
      }

      // Validate email domain (basic example)
      const emailDomain = email.split('@')[1];
      if (!emailDomain || !validator.isFQDN(emailDomain)) {
        throw new AppError('Invalid email domain', 400);
      }

      // Validate password strength
      if (password.length < 8) {
        throw new AppError('Password must be at least 8 characters long', 400);
      }
      
      // Additional password complexity (optional)
      if (!/[A-Z]/.test(password)) {
        throw new AppError('Password must contain at least one uppercase letter', 400);
      }
      if (!/[a-z]/.test(password)) {
        throw new AppError('Password must contain at least one lowercase letter', 400);
      }
      if (!/[0-9]/.test(password)) {
        throw new AppError('Password must contain at least one number', 400);
      }

      // Validate username format (alphanumeric with underscores, 3-30 chars)
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        throw new AppError('Username must be 3-30 characters and can only contain letters, numbers, and underscores', 400);
      }

      // Trim and validate optional fields
      const sanitizedData = {
        username: username.trim(),
        email: email.toLowerCase().trim(),
        password,
        firstName: firstName ? firstName.trim() : null,
        lastName: lastName ? lastName.trim() : null,
        profile: profile || null
      };

      // Additional validation for optional fields
      if (sanitizedData.firstName && sanitizedData.firstName.length > 50) {
        throw new AppError('First name cannot exceed 50 characters', 400);
      }
      if (sanitizedData.lastName && sanitizedData.lastName.length > 50) {
        throw new AppError('Last name cannot exceed 50 characters', 400);
      }

      const result = await authService.register(sanitizedData);

      // Generate JWT token
      const token = jwt.sign(
        { userId: result.user.id },
        process.env.JWT_SECRET || 'your-jwt-secret',
        { expiresIn: '24h' }
      );

      // Create sanitized user object (avatar field included)
      const sanitizedUser = {
        id: result.user.id,
        username: result.user.username,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        profile: result.user.profile,
        avatar: result.user.profile?.avatar || result.user.avatar || null, // Include avatar field
        displayName: `${result.user.firstName || ''} ${result.user.lastName || ''}`.trim() || result.user.username
      };

      // Log successful registration for debugging
      logger.info(`User registered successfully: ${email}`, { userId: result.user.id });

      res.status(201).json({
        success: true,
        token: token,
        user: sanitizedUser,
        message: 'Registration successful. Please check your email for verification.'
      });
    } catch (error) {
      logger.error('Registration controller error:', error);
      
      // Handle duplicate email/username errors specifically
      if (error.message.includes('duplicate') || error.code === 11000 || error.message.includes('already exists')) {
        const field = error.message.includes('email') ? 'Email' : 'Username';
        return next(new AppError(`${field} already exists`, 409));
      }
      
      next(error);
    }
  }

  async login(req, res, next) {
    try {
      const { identifier, password } = req.body;

      // Validate required fields
      if (!identifier || !password) {
        throw new AppError('Identifier (email or username) and password are required', 400);
      }

      // Validate identifier format (either email or username)
      let isEmail = false;
      let isUsername = false;
      
      if (validator.isEmail(identifier)) {
        isEmail = true;
      } else if (/^[a-zA-Z0-9_]{3,30}$/.test(identifier)) {
        isUsername = true;
      } else {
        throw new AppError('Identifier must be a valid email or username (3-30 characters, letters, numbers, underscores only)', 400);
      }

      const result = await authService.login(identifier, password, isEmail);

      // Generate JWT token
      const token = jwt.sign(
        { userId: result.user.id },
        process.env.JWT_SECRET || 'your-jwt-secret',
        { expiresIn: '24h' }
      );

      // Create sanitized user object with avatar field
      const sanitizedUser = {
        id: result.user.id,
        username: result.user.username,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        profile: result.user.profile,
        avatar: result.user.profile?.avatar || result.user.avatar || null, // Include avatar field
        displayName: `${result.user.firstName || ''} ${result.user.lastName || ''}`.trim() || result.user.username
      };

      // Log successful login for debugging
      logger.info(`User logged in: ${result.user.email}`, { userId: result.user.id });

      res.status(200).json({
        token: token,
        user: sanitizedUser
      });
    } catch (error) {
      logger.error('Login controller error:', error);
      
      // Handle invalid credentials specifically
      if (error.message.includes('Invalid credentials') || 
          error.message.includes('not found') ||
          error.message.includes('incorrect password')) {
        return res.status(401).json({
          error: "Invalid credentials"
        });
      }
      
      // Handle email not verified
      if (error.message.includes('not verified') || error.message.includes('verify')) {
        return res.status(403).json({
          error: "Please verify your email address before logging in"
        });
      }
      
      next(error);
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        throw new AppError('Refresh token is required', 400);
      }

      // Validate refresh token format
      if (typeof refreshToken !== 'string' || refreshToken.length < 10) {
        throw new AppError('Invalid refresh token format', 400);
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
          error: "Invalid or expired refresh token"
        });
      }
      
      next(error);
    }
  }

  async logout(req, res, next) {
    try {
      const accessToken = req.headers.authorization?.split(' ')[1];
      const { refreshToken } = req.body;

      // Validate tokens
      if (!accessToken && !refreshToken) {
        throw new AppError('At least one token is required for logout', 400);
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
      next(error);
    }
  }

  async verifyEmail(req, res, next) {
    try {
      const { token } = req.query;

      if (!token) {
        throw new AppError('Verification token is required', 400);
      }

      // Validate token format
      if (typeof token !== 'string' || token.length < 10) {
        throw new AppError('Invalid verification token format', 400);
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
          error: "Invalid or expired verification token"
        });
      }
      
      next(error);
    }
  }

  async requestPasswordReset(req, res, next) {
    try {
      const { email } = req.body;

      if (!email) {
        throw new AppError('Email is required', 400);
      }

      // Validate email format
      if (!validator.isEmail(email)) {
        throw new AppError('Invalid email format', 400);
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
      next(error);
    }
  }

  async resetPassword(req, res, next) {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        throw new AppError('Token and new password are required', 400);
      }

      // Validate token format
      if (typeof token !== 'string' || token.length < 10) {
        throw new AppError('Invalid reset token format', 400);
      }

      // Validate password strength
      if (newPassword.length < 8) {
        throw new AppError('Password must be at least 8 characters long', 400);
      }
      
      // Additional password complexity
      if (!/[A-Z]/.test(newPassword)) {
        throw new AppError('Password must contain at least one uppercase letter', 400);
      }
      if (!/[a-z]/.test(newPassword)) {
        throw new AppError('Password must contain at least one lowercase letter', 400);
      }
      if (!/[0-9]/.test(newPassword)) {
        throw new AppError('Password must contain at least one number', 400);
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
          error: "Invalid or expired reset token"
        });
      }
      
      next(error);
    }
  }

  async validateToken(req, res, next) {
    try {
      const token = req.headers.authorization?.split(' ')[1];

      if (!token) {
        throw new AppError('Token is required', 400);
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
          error: "Unauthorized"
        });
      }

      // Create sanitized user object with avatar
      const sanitizedUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profile: user.profile,
        avatar: user.profile?.avatar || user.avatar || null,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
        emailVerified: user.emailVerified || false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };

      res.json({
        user: sanitizedUser
      });
    } catch (error) {
      logger.error('Get current user controller error:', error);
      
      if (error.message.includes('Unauthorized') || error.message.includes('invalid token')) {
        return res.status(401).json({
          error: "Unauthorized"
        });
      }
      
      next(error);
    }
  }
}

module.exports = new AuthController();