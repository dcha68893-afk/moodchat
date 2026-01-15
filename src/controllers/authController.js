const authService = require('../services/authService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const validator = require('validator');

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

      // Validate password strength
      if (password.length < 8) {
        throw new AppError('Password must be at least 8 characters long', 400);
      }

      // Validate username format (alphanumeric with underscores)
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        throw new AppError('Username can only contain letters, numbers, and underscores', 400);
      }

      const result = await authService.register({
        username,
        email,
        password,
        firstName,
        lastName,
        profile,
      });

      // Log successful registration for debugging
      logger.info(`User registered successfully: ${email}`, { userId: result.user.id });

      res.status(201).json({
        success: true,
        message: 'Registration successful. Please check your email for verification.',
        data: {
          user: result.user,
          tokens: result.tokens,
        },
      });
    } catch (error) {
      logger.error('Registration controller error:', error);
      
      // Handle duplicate email/username errors specifically
      if (error.message.includes('duplicate') || error.code === 11000) {
        return next(new AppError('Email or username already exists', 409));
      }
      
      next(error);
    }
  }

  async login(req, res, next) {
    try {
      const { email, password } = req.body;

      // Validate required fields
      if (!email || !password) {
        throw new AppError('Email and password are required', 400);
      }

      const result = await authService.login(email, password);

      // Log successful login for debugging
      logger.info(`User logged in: ${email}`, { userId: result.user.id });

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: result.user,
          tokens: result.tokens,
        },
      });
    } catch (error) {
      logger.error('Login controller error:', error);
      
      // Handle invalid credentials specifically
      if (error.message.includes('Invalid credentials') || error.message.includes('not found')) {
        return next(new AppError('Invalid email or password', 401));
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
      next(error);
    }
  }

  async logout(req, res, next) {
    try {
      const accessToken = req.headers.authorization?.split(' ')[1];
      const { refreshToken } = req.body;

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

      // Validate password strength
      if (newPassword.length < 8) {
        throw new AppError('Password must be at least 8 characters long', 400);
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
      res.json({
        success: true,
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
        throw new AppError('User not found', 404);
      }

      res.json({
        success: true,
        data: {
          user,
        },
      });
    } catch (error) {
      logger.error('Get current user controller error:', error);
      next(error);
    }
  }
}

module.exports = new AuthController();