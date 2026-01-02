const authController = require('../../../src/controllers/authController');
const authService = require('../../../src/services/authService');
const jwt = require('../../../src/utils/jwt');
const { validationResult } = require('express-validator');

// Mock dependencies
jest.mock('../../../src/services/authService');
jest.mock('../../../src/utils/jwt');
jest.mock('express-validator');

describe('Auth Controller', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      body: {},
      headers: {},
      cookies: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis()
    };
    next = jest.fn();
    validationResult.mockReturnValue({
      isEmpty: jest.fn().mockReturnValue(true),
      array: jest.fn().mockReturnValue([])
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should register user successfully', async () => {
      const mockUser = {
        id: '123',
        email: 'test@example.com',
        username: 'testuser'
      };
      const mockTokens = {
        accessToken: 'access_token',
        refreshToken: 'refresh_token'
      };

      req.body = {
        email: 'test@example.com',
        username: 'testuser',
        password: 'Password123!',
        firstName: 'John',
        lastName: 'Doe'
      };

      authService.registerUser.mockResolvedValue(mockUser);
      jwt.generateTokenPair.mockReturnValue(mockTokens);
      authService.createSession.mockResolvedValue();

      await authController.register(req, res, next);

      expect(validationResult).toHaveBeenCalledWith(req);
      expect(authService.registerUser).toHaveBeenCalledWith({
        email: 'test@example.com',
        username: 'testuser',
        password: 'Password123!',
        firstName: 'John',
        lastName: 'Doe'
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          user: mockUser,
          tokens: mockTokens
        },
        message: 'Registration successful'
      });
    });

    it('should handle validation errors', async () => {
      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'email', message: 'Invalid email' }])
      });

      await authController.register(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Validation failed',
        details: [{ field: 'email', message: 'Invalid email' }]
      });
    });

    it('should handle duplicate email error', async () => {
      const error = new Error('Email already exists');
      error.code = 'DUPLICATE_EMAIL';

      authService.registerUser.mockRejectedValue(error);

      await authController.register(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Email already exists',
        code: 'DUPLICATE_EMAIL'
      });
    });

    it('should handle server error', async () => {
      const error = new Error('Database connection failed');
      authService.registerUser.mockRejectedValue(error);

      await authController.register(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Database connection failed',
        code: 'INTERNAL_ERROR'
      });
    });
  });

  describe('login', () => {
    it('should login user successfully', async () => {
      const mockUser = {
        id: '123',
        email: 'test@example.com',
        username: 'testuser'
      };
      const mockTokens = {
        accessToken: 'access_token',
        refreshToken: 'refresh_token'
      };

      req.body = {
        emailOrUsername: 'test@example.com',
        password: 'Password123!'
      };
      req.headers = { 'user-agent': 'Test Agent' };
      req.ip = '127.0.0.1';

      authService.authenticateUser.mockResolvedValue(mockUser);
      jwt.generateTokenPair.mockReturnValue(mockTokens);
      authService.createSession.mockResolvedValue();

      await authController.login(req, res, next);

      expect(authService.authenticateUser).toHaveBeenCalledWith(
        'test@example.com',
        'Password123!'
      );
      expect(authService.createSession).toHaveBeenCalledWith({
        userId: '123',
        token: 'access_token',
        refreshToken: 'refresh_token',
        deviceInfo: { userAgent: 'Test Agent' },
        ipAddress: '127.0.0.1'
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          user: mockUser,
          tokens: mockTokens
        },
        message: 'Login successful'
      });
    });

    it('should handle invalid credentials', async () => {
      const error = new Error('Invalid credentials');
      error.code = 'INVALID_CREDENTIALS';

      authService.authenticateUser.mockRejectedValue(error);

      await authController.login(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      });
    });

    it('should handle inactive account', async () => {
      const error = new Error('Account is disabled');
      error.code = 'ACCOUNT_DISABLED';

      authService.authenticateUser.mockRejectedValue(error);

      await authController.login(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Account is disabled',
        code: 'ACCOUNT_DISABLED'
      });
    });
  });

  describe('logout', () => {
    it('should logout user successfully', async () => {
      req.user = { id: '123' };
      req.token = 'access_token';

      authService.revokeSession.mockResolvedValue();

      await authController.logout(req, res, next);

      expect(authService.revokeSession).toHaveBeenCalledWith('access_token');
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Logout successful'
      });
    });

    it('should handle missing token', async () => {
      req.user = { id: '123' };
      req.token = null;

      await authController.logout(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'No token provided'
      });
    });
  });

  describe('refreshToken', () => {
    it('should refresh token successfully', async () => {
      const mockTokens = {
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token'
      };

      req.body = { refreshToken: 'old_refresh_token' };
      req.headers = { 'user-agent': 'Test Agent' };

      jwt.verifyRefreshToken.mockReturnValue({ userId: '123' });
      jwt.generateTokenPair.mockReturnValue(mockTokens);
      authService.updateSession.mockResolvedValue();

      await authController.refreshToken(req, res, next);

      expect(jwt.verifyRefreshToken).toHaveBeenCalledWith('old_refresh_token');
      expect(jwt.generateTokenPair).toHaveBeenCalledWith('123', {});
      expect(authService.updateSession).toHaveBeenCalledWith('old_refresh_token', {
        token: 'new_access_token',
        refreshToken: 'new_refresh_token',
        deviceInfo: { userAgent: 'Test Agent' }
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockTokens,
        message: 'Token refreshed successfully'
      });
    });

    it('should handle invalid refresh token', async () => {
      jwt.verifyRefreshToken.mockImplementation(() => {
        throw new Error('Invalid refresh token');
      });

      await authController.refreshToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid refresh token'
      });
    });
  });

  describe('forgotPassword', () => {
    it('should send reset email successfully', async () => {
      req.body = { email: 'test@example.com' };

      authService.initiatePasswordReset.mockResolvedValue();

      await authController.forgotPassword(req, res, next);

      expect(authService.initiatePasswordReset).toHaveBeenCalledWith('test@example.com');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Password reset email sent'
      });
    });

    it('should handle non-existent email', async () => {
      const error = new Error('User not found');
      authService.initiatePasswordReset.mockRejectedValue(error);

      await authController.forgotPassword(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'User not found'
      });
    });
  });

  describe('resetPassword', () => {
    it('should reset password successfully', async () => {
      req.body = {
        token: 'reset_token',
        newPassword: 'NewPassword123!',
        confirmPassword: 'NewPassword123!'
      };

      authService.resetPassword.mockResolvedValue();

      await authController.resetPassword(req, res, next);

      expect(authService.resetPassword).toHaveBeenCalledWith(
        'reset_token',
        'NewPassword123!'
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Password reset successful'
      });
    });

    it('should handle mismatched passwords', async () => {
      req.body = {
        token: 'reset_token',
        newPassword: 'NewPassword123!',
        confirmPassword: 'DifferentPassword123!'
      };

      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ 
          field: 'confirmPassword', 
          message: 'Passwords do not match' 
        }])
      });

      await authController.resetPassword(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle expired token', async () => {
      const error = new Error('Token has expired');
      error.code = 'TOKEN_EXPIRED';

      authService.resetPassword.mockRejectedValue(error);

      await authController.resetPassword(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Token has expired',
        code: 'TOKEN_EXPIRED'
      });
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user data', async () => {
      const mockUser = {
        id: '123',
        email: 'test@example.com',
        username: 'testuser',
        profile: { bio: 'Test bio' }
      };

      req.user = { id: '123' };
      authService.getUserWithProfile.mockResolvedValue(mockUser);

      await authController.getCurrentUser(req, res, next);

      expect(authService.getUserWithProfile).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockUser
      });
    });

    it('should handle user not found', async () => {
      const error = new Error('User not found');
      authService.getUserWithProfile.mockRejectedValue(error);

      await authController.getCurrentUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'User not found'
      });
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      req.user = { id: '123' };
      req.body = {
        currentPassword: 'OldPassword123!',
        newPassword: 'NewPassword123!',
        confirmPassword: 'NewPassword123!'
      };

      authService.changePassword.mockResolvedValue();

      await authController.changePassword(req, res, next);

      expect(authService.changePassword).toHaveBeenCalledWith(
        '123',
        'OldPassword123!',
        'NewPassword123!'
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Password changed successfully'
      });
    });

    it('should handle incorrect current password', async () => {
      const error = new Error('Current password is incorrect');
      authService.changePassword.mockRejectedValue(error);

      await authController.changePassword(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Current password is incorrect'
      });
    });
  });
});