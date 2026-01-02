import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import authService from '../../../src/services/authService';
import User from '../../../src/models/User';
import redisClient from '../../../src/config/redis';
import mailService from '../../../src/services/mailService';

// Mock dependencies
jest.mock('../../../src/models/User');
jest.mock('../../../src/config/redis');
jest.mock('../../../src/services/mailService');

describe('Auth Service', () => {
  let mockUser;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      email: 'test@example.com',
      password: 'hashedPassword123',
      username: 'testuser',
      isVerified: true,
      save: jest.fn().mockResolvedValue(true),
      toObject: jest.fn().mockReturnValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'test@example.com',
        username: 'testuser',
      }),
    };
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        email: 'new@example.com',
        password: 'password123',
        username: 'newuser',
      };

      User.findOne.mockResolvedValue(null);
      User.create.mockResolvedValue({
        ...mockUser,
        email: userData.email,
        username: userData.username,
      });
      bcrypt.hash.mockResolvedValue('hashedPassword123');
      mailService.sendVerificationEmail.mockResolvedValue(true);

      const result = await authService.register(userData);

      expect(User.findOne).toHaveBeenCalledWith({ email: userData.email });
      expect(bcrypt.hash).toHaveBeenCalledWith(userData.password, 10);
      expect(User.create).toHaveBeenCalled();
      expect(mailService.sendVerificationEmail).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
    });

    it('should fail when email already exists', async () => {
      const userData = {
        email: 'existing@example.com',
        password: 'password123',
        username: 'existinguser',
      };

      User.findOne.mockResolvedValue(mockUser);

      const result = await authService.register(userData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should handle database errors', async () => {
      const userData = {
        email: 'new@example.com',
        password: 'password123',
        username: 'newuser',
      };

      User.findOne.mockRejectedValue(new Error('Database error'));

      await expect(authService.register(userData)).rejects.toThrow('Database error');
    });
  });

  describe('login', () => {
    it('should login user successfully', async () => {
      const credentials = {
        email: 'test@example.com',
        password: 'password123',
      };

      User.findOne.mockResolvedValue(mockUser);
      bcrypt.compare.mockResolvedValue(true);
      jwt.sign.mockReturnValue('fake-jwt-token');
      redisClient.set.mockResolvedValue('OK');

      const result = await authService.login(credentials);

      expect(User.findOne).toHaveBeenCalledWith({ email: credentials.email });
      expect(bcrypt.compare).toHaveBeenCalledWith(credentials.password, mockUser.password);
      expect(jwt.sign).toHaveBeenCalled();
      expect(redisClient.set).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
    });

    it('should fail with invalid credentials', async () => {
      const credentials = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };

      User.findOne.mockResolvedValue(mockUser);
      bcrypt.compare.mockResolvedValue(false);

      const result = await authService.login(credentials);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid credentials');
    });

    it('should fail if user is not verified', async () => {
      const credentials = {
        email: 'test@example.com',
        password: 'password123',
      };

      User.findOne.mockResolvedValue({ ...mockUser, isVerified: false });

      const result = await authService.login(credentials);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Please verify your email');
    });
  });

  describe('verifyEmail', () => {
    it('should verify email successfully', async () => {
      const token = 'valid-verification-token';
      const userId = '507f1f77bcf86cd799439011';

      jwt.verify.mockReturnValue({ userId });
      User.findById.mockResolvedValue(mockUser);
      mockUser.save.mockResolvedValue(true);
      redisClient.del.mockResolvedValue(1);

      const result = await authService.verifyEmail(token);

      expect(jwt.verify).toHaveBeenCalledWith(token, expect.any(String));
      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.del).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail with invalid token', async () => {
      const token = 'invalid-token';

      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const result = await authService.verifyEmail(token);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid token');
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      const token = 'valid-token';
      const userId = '507f1f77bcf86cd799439011';

      jwt.verify.mockReturnValue({ userId });
      redisClient.del.mockResolvedValue(1);

      const result = await authService.logout(token);

      expect(redisClient.del).toHaveBeenCalledWith(`auth_${userId}`);
      expect(result.success).toBe(true);
    });

    it('should handle logout when token is invalid', async () => {
      const token = 'invalid-token';

      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const result = await authService.logout(token);

      expect(result.success).toBe(false);
    });
  });

  describe('refreshToken', () => {
    it('should refresh token successfully', async () => {
      const refreshToken = 'valid-refresh-token';
      const userId = '507f1f77bcf86cd799439011';

      jwt.verify.mockReturnValue({ userId, type: 'refresh' });
      User.findById.mockResolvedValue(mockUser);
      redisClient.get.mockResolvedValue(refreshToken);
      jwt.sign.mockReturnValue('new-access-token');

      const result = await authService.refreshToken(refreshToken);

      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
    });

    it('should fail with invalid refresh token', async () => {
      const refreshToken = 'invalid-token';

      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const result = await authService.refreshToken(refreshToken);

      expect(result.success).toBe(false);
    });
  });

  describe('forgotPassword', () => {
    it('should send reset email successfully', async () => {
      const email = 'test@example.com';

      User.findOne.mockResolvedValue(mockUser);
      jwt.sign.mockReturnValue('reset-token');
      redisClient.set.mockResolvedValue('OK');
      mailService.sendPasswordResetEmail.mockResolvedValue(true);

      const result = await authService.forgotPassword(email);

      expect(User.findOne).toHaveBeenCalledWith({ email });
      expect(jwt.sign).toHaveBeenCalled();
      expect(redisClient.set).toHaveBeenCalled();
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if user not found', async () => {
      const email = 'nonexistent@example.com';

      User.findOne.mockResolvedValue(null);

      const result = await authService.forgotPassword(email);

      expect(result.success).toBe(false);
    });
  });
});