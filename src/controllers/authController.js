const authService = require('../services/authService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class AuthController {
  async register(req, res, next) {
    try {
      const { username, email, password, firstName, lastName, profile } = req.body;

      const result = await authService.register({
        username,
        email,
        password,
        firstName,
        lastName,
        profile,
      });

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
      next(error);
    }
  }

  async login(req, res, next) {
    try {
      const { email, password } = req.body;

      const result = await authService.login(email, password);

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

      await authService.requestPasswordReset(email);

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

      await authService.resetPassword(token, newPassword);

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
