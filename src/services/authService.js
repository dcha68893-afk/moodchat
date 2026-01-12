const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User, Profile } = require('../models');
const jwtConfig = require('../config/jwt');
const redisClient = require('../utils/redisClient');
const logger = require('../utils/logger');
const { sendEmail } = require('../utils/helpers');

class AuthService {
  async register(userData) {
    try {
      // Check if user already exists
      const existingUser = await User.findOne({
        where: {
          [Op.or]: [{ email: userData.email }, { username: userData.username }],
        },
      });

      if (existingUser) {
        throw new Error(
          existingUser.email === userData.email
            ? 'Email already registered'
            : 'Username already taken'
        );
      }

      // Create user
      const user = await User.create({
        username: userData.username,
        email: userData.email,
        password: userData.password,
        firstName: userData.firstName,
        lastName: userData.lastName,
      });

      // Create profile
      await Profile.create({
        userId: user.id,
        ...userData.profile,
      });

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');

      // Store verification token in Redis
      await redisClient.setex(
        `verification:${verificationToken}`,
        24 * 60 * 60, // 24 hours
        user.id.toString()
      );

      // Send verification email
      await sendEmail({
        to: user.email,
        subject: 'Verify your MoodChat account',
        template: 'verification',
        context: {
          name: user.username,
          verificationLink: `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`,
        },
      });

      // Generate tokens
      const tokens = this.generateTokens(user.id);

      // Store refresh token in Redis
      await redisClient.setex(
        `refresh:${tokens.refreshToken}`,
        7 * 24 * 60 * 60, // 7 days
        user.id.toString()
      );

      return {
        user: user.toJSON(),
        tokens,
      };
    } catch (error) {
      logger.error('Registration error:', error);
      throw error;
    }
  }

  async login(email, password) {
    try {
      // Find user
      const user = await User.findOne({ where: { email } });
      if (!user) {
        throw new Error('Invalid credentials');
      }

      // Check password
      const isValidPassword = await user.validatePassword(password);
      if (!isValidPassword) {
        throw new Error('Invalid credentials');
      }

      // Check if user is active
      if (!user.isActive) {
        throw new Error('Account is deactivated');
      }

      // Update last seen
      user.lastSeen = new Date();
      await user.save();

      // Generate tokens
      const tokens = this.generateTokens(user.id);

      // Store refresh token in Redis
      await redisClient.setex(
        `refresh:${tokens.refreshToken}`,
        7 * 24 * 60 * 60, // 7 days
        user.id.toString()
      );

      return {
        user: user.toJSON(),
        tokens,
      };
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  }

  async refreshToken(refreshToken) {
    try {
      // Verify refresh token
      const decoded = jwt.verify(refreshToken, jwtConfig.secret, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      });

      // Check if refresh token exists in Redis
      const userId = await redisClient.get(`refresh:${refreshToken}`);
      if (!userId || parseInt(userId) !== decoded.userId) {
        throw new Error('Invalid refresh token');
      }

      // Get user
      const user = await User.findByPk(decoded.userId, {
        attributes: { exclude: ['password'] },
      });

      if (!user || !user.isActive) {
        throw new Error('User not found or inactive');
      }

      // Generate new tokens
      const tokens = this.generateTokens(user.id);

      // Delete old refresh token
      await redisClient.del(`refresh:${refreshToken}`);

      // Store new refresh token
      await redisClient.setex(
        `refresh:${tokens.refreshToken}`,
        7 * 24 * 60 * 60, // 7 days
        user.id.toString()
      );

      return {
        user: user.toJSON(),
        tokens,
      };
    } catch (error) {
      logger.error('Refresh token error:', error);
      throw error;
    }
  }

  async logout(accessToken, refreshToken) {
    try {
      // Add access token to blacklist
      const decoded = jwt.decode(accessToken);
      if (decoded && decoded.exp) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await redisClient.setex(`blacklist:${accessToken}`, ttl, '1');
        }
      }

      // Remove refresh token
      if (refreshToken) {
        await redisClient.del(`refresh:${refreshToken}`);
      }

      return true;
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }
  }

  async verifyEmail(token) {
    try {
      // Get user ID from Redis
      const userId = await redisClient.get(`verification:${token}`);
      if (!userId) {
        throw new Error('Invalid or expired verification token');
      }

      // Update user
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.isVerified) {
        return user;
      }

      user.isVerified = true;
      await user.save();

      // Delete verification token
      await redisClient.del(`verification:${token}`);

      // Send welcome email
      await sendEmail({
        to: user.email,
        subject: 'Welcome to MoodChat!',
        template: 'welcome',
        context: {
          name: user.username,
        },
      });

      return user;
    } catch (error) {
      logger.error('Email verification error:', error);
      throw error;
    }
  }

  async requestPasswordReset(email) {
    try {
      const user = await User.findOne({ where: { email } });
      if (!user) {
        // Don't reveal that user doesn't exist
        return true;
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');

      // Store reset token in Redis
      await redisClient.setex(
        `reset:${resetToken}`,
        60 * 60, // 1 hour
        user.id.toString()
      );

      // Send reset email
      await sendEmail({
        to: user.email,
        subject: 'Reset your MoodChat password',
        template: 'password-reset',
        context: {
          name: user.username,
          resetLink: `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`,
        },
      });

      return true;
    } catch (error) {
      logger.error('Password reset request error:', error);
      throw error;
    }
  }

  async resetPassword(token, newPassword) {
    try {
      // Get user ID from Redis
      const userId = await redisClient.get(`reset:${token}`);
      if (!userId) {
        throw new Error('Invalid or expired reset token');
      }

      // Update user password
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      user.password = newPassword;
      await user.save();

      // Delete reset token
      await redisClient.del(`reset:${token}`);

      // Send confirmation email
      await sendEmail({
        to: user.email,
        subject: 'Password reset successful',
        template: 'password-reset-success',
        context: {
          name: user.username,
        },
      });

      return user;
    } catch (error) {
      logger.error('Password reset error:', error);
      throw error;
    }
  }

  generateTokens(userId) {
    const accessToken = jwt.sign({ userId, type: 'access' }, jwtConfig.secret, {
      expiresIn: jwtConfig.accessToken.expiresIn,
      issuer: jwtConfig.issuer,
      audience: jwtConfig.audience,
      algorithm: jwtConfig.accessToken.algorithm,
    });

    const refreshToken = jwt.sign({ userId, type: 'refresh' }, jwtConfig.secret, {
      expiresIn: jwtConfig.refreshToken.expiresIn,
      issuer: jwtConfig.issuer,
      audience: jwtConfig.audience,
      algorithm: jwtConfig.refreshToken.algorithm,
    });

    return { accessToken, refreshToken };
  }

  async validateToken(token) {
    try {
      const decoded = jwt.verify(token, jwtConfig.secret, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      });

      // Check if token is blacklisted
      const isBlacklisted = await redisClient.get(`blacklist:${token}`);
      if (isBlacklisted) {
        throw new Error('Token has been invalidated');
      }

      return decoded;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new AuthService();