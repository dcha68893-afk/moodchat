
const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User, Profile } = require('../models');
const logger = require('../utils/logger');

class AuthService {
  // In-memory storage for development (replace with Redis in production)
  static tokenStore = new Map();
  static verificationStore = new Map();
  static resetStore = new Map();
  static blacklistStore = new Map();

  async register(userData) {
    try {
      console.log("🔧 [AuthService] Register called with:", { 
        username: userData.username, 
        email: userData.email,
        hasFirstName: !!userData.firstName,
        hasLastName: !!userData.lastName 
      });

      // Validate required fields
      if (!userData.username || !userData.email || !userData.password) {
        throw new Error('Username, email, and password are required');
      }

      // Validate password is not empty
      if (!userData.password || userData.password.trim() === '') {
        throw new Error('Password cannot be empty');
      }

      // Check if user already exists
      const existingUser = await User.findOne({
        where: {
          [Op.or]: [
            { email: userData.email.toLowerCase().trim() }, 
            { username: userData.username.trim() }
          ],
        },
      });

      if (existingUser) {
        const errorMsg = existingUser.email === userData.email.toLowerCase().trim()
          ? 'Email already registered'
          : 'Username already taken';
        console.log("❌ [AuthService] User exists:", errorMsg);
        throw new Error(errorMsg);
      }

      // Create user
      console.log("🔧 [AuthService] Creating user...");
      const user = await User.create({
        username: userData.username.trim(),
        email: userData.email.toLowerCase().trim(),
        password: userData.password,
        firstName: userData.firstName || null,
        lastName: userData.lastName || null,
        isActive: true,
        isVerified: process.env.NODE_ENV === 'development', // Auto-verify in dev
      });

      console.log("✅ [AuthService] User created with ID:", user.id);

      // Skip Profile creation if model doesn't exist
      try {
        if (userData.profile) {
          await Profile.create({
            userId: user.id,
            ...userData.profile,
          });
          console.log("✅ [AuthService] Profile created");
        }
      } catch (profileError) {
        console.log("⚠️ [AuthService] Profile not created:", profileError.message);
        // Continue without profile - it's optional
      }

      // Generate verification token (store in memory for dev)
      const verificationToken = crypto.randomBytes(32).toString('hex');
      AuthService.verificationStore.set(verificationToken, {
        userId: user.id,
        expires: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
      });

      console.log("🔧 [AuthService] Verification token generated");

      // Skip email sending in development
      if (process.env.NODE_ENV !== 'development') {
        try {
          const { sendEmail } = require('../utils/helpers');
          await sendEmail({
            to: user.email,
            subject: 'Verify your MoodChat account',
            template: 'verification',
            context: {
              name: user.username,
              verificationLink: `${process.env.FRONTEND_URL || 'http://localhost:5500'}/verify-email?token=${verificationToken}`,
            },
          });
          console.log("✅ [AuthService] Verification email sent");
        } catch (emailError) {
          console.log("⚠️ [AuthService] Email not sent:", emailError.message);
        }
      }

      // Generate tokens
      const tokens = this.generateTokens(user.id);
      console.log("✅ [AuthService] Tokens generated");

      // Store refresh token in memory
      AuthService.tokenStore.set(tokens.refreshToken, {
        userId: user.id,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      // Clean old tokens periodically
      this.cleanupOldTokens();

      return {
        user: user.toJSON(),
        tokens,
        verificationToken: process.env.NODE_ENV === 'development' ? verificationToken : undefined
      };
    } catch (error) {
      console.error('❌ [AuthService] Registration error:', error.message);
      console.error('Stack:', error.stack);
      throw error;
    }
  }

  async login(email, password) {
    try {
      console.log("🔧 [AuthService] Login attempt for email:", email);

      // Find user by email or username
      let user;
      if (email.includes('@')) {
        user = await User.findOne({ 
          where: { 
            email: email.toLowerCase().trim() 
          } 
        });
      } else {
        user = await User.findOne({ 
          where: { 
            username: email.trim() 
          } 
        });
      }

      if (!user) {
        console.log("❌ [AuthService] User not found");
        throw new Error('Invalid credentials');
      }

      console.log("✅ [AuthService] User found:", user.id);

      // Check password using User model's validatePassword method
      const isValidPassword = await user.validatePassword(password);
      if (!isValidPassword) {
        console.log("❌ [AuthService] Invalid password");
        throw new Error('Invalid credentials');
      }

      // Check if user is active
      if (!user.isActive) {
        console.log("❌ [AuthService] Account deactivated");
        throw new Error('Account is deactivated');
      }

      // Update last seen
      user.lastSeen = new Date();
      await user.save();

      // Generate tokens
      const tokens = this.generateTokens(user.id);

      // Store refresh token in memory
      AuthService.tokenStore.set(tokens.refreshToken, {
        userId: user.id,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      console.log("✅ [AuthService] Login successful for user:", user.id);

      return {
        user: user.toJSON(),
        tokens,
      };
    } catch (error) {
      console.error('❌ [AuthService] Login error:', error.message);
      throw error;
    }
  }

  async refreshToken(refreshToken) {
    try {
      console.log("🔧 [AuthService] Refreshing token");

      // Check if refresh token exists
      const tokenData = AuthService.tokenStore.get(refreshToken);
      if (!tokenData || tokenData.expires < Date.now()) {
        throw new Error('Invalid or expired refresh token');
      }

      // Verify JWT
      let decoded;
      try {
        decoded = jwt.verify(refreshToken, process.env.JWT_SECRET || 'dev-secret');
      } catch (jwtError) {
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
      AuthService.tokenStore.delete(refreshToken);

      // Store new refresh token
      AuthService.tokenStore.set(tokens.refreshToken, {
        userId: user.id,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
      });

      return {
        user: user.toJSON(),
        tokens,
      };
    } catch (error) {
      console.error('❌ [AuthService] Refresh token error:', error.message);
      throw error;
    }
  }

  async logout(accessToken, refreshToken) {
    try {
      console.log("🔧 [AuthService] Logout");

      // Add access token to blacklist
      if (accessToken) {
        let decoded;
        try {
          decoded = jwt.decode(accessToken);
        } catch (e) {
          decoded = null;
        }
        
        if (decoded && decoded.exp) {
          const ttl = decoded.exp * 1000 - Date.now();
          if (ttl > 0) {
            AuthService.blacklistStore.set(accessToken, {
              expires: Date.now() + ttl
            });
          }
        }
      }

      // Remove refresh token
      if (refreshToken) {
        AuthService.tokenStore.delete(refreshToken);
      }

      return true;
    } catch (error) {
      console.error('❌ [AuthService] Logout error:', error.message);
      throw error;
    }
  }

  async verifyEmail(token) {
    try {
      console.log("🔧 [AuthService] Verifying email with token");

      // Get from memory store
      const tokenData = AuthService.verificationStore.get(token);
      if (!tokenData || tokenData.expires < Date.now()) {
        throw new Error('Invalid or expired verification token');
      }

      // Update user
      const user = await User.findByPk(tokenData.userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.isVerified) {
        return user.toJSON();
      }

      user.isVerified = true;
      await user.save();

      // Delete verification token
      AuthService.verificationStore.delete(token);

      return user.toJSON();
    } catch (error) {
      console.error('❌ [AuthService] Email verification error:', error.message);
      throw error;
    }
  }

  async requestPasswordReset(email) {
    try {
      console.log("🔧 [AuthService] Password reset requested for:", email);

      const user = await User.findOne({ 
        where: { 
          email: email.toLowerCase().trim() 
        } 
      });
      
      if (!user) {
        // Don't reveal that user doesn't exist for security
        return true;
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');

      // Store in memory
      AuthService.resetStore.set(resetToken, {
        userId: user.id,
        expires: Date.now() + 60 * 60 * 1000 // 1 hour
      });

      // In development, log the token instead of emailing
      if (process.env.NODE_ENV === 'development') {
        console.log(`📧 [DEV] Password reset token for ${user.email}: ${resetToken}`);
        console.log(`🔗 Reset link: http://localhost:5500/reset-password?token=${resetToken}`);
      } else {
        try {
          const { sendEmail } = require('../utils/helpers');
          await sendEmail({
            to: user.email,
            subject: 'Reset your MoodChat password',
            template: 'password-reset',
            context: {
              name: user.username,
              resetLink: `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`,
            },
          });
        } catch (emailError) {
          console.log("⚠️ [AuthService] Email not sent:", emailError.message);
        }
      }

      return true;
    } catch (error) {
      console.error('❌ [AuthService] Password reset request error:', error.message);
      throw error;
    }
  }

  async resetPassword(token, newPassword) {
    try {
      console.log("🔧 [AuthService] Resetting password");

      // Get from memory store
      const tokenData = AuthService.resetStore.get(token);
      if (!tokenData || tokenData.expires < Date.now()) {
        throw new Error('Invalid or expired reset token');
      }

      // Update user password
      const user = await User.findByPk(tokenData.userId);
      if (!user) {
        throw new Error('User not found');
      }

      user.password = newPassword;
      await user.save();

      // Delete reset token
      AuthService.resetStore.delete(token);

      return user.toJSON();
    } catch (error) {
      console.error('❌ [AuthService] Password reset error:', error.message);
      throw error;
    }
  }

  generateTokens(userId) {
    console.log("🔧 [AuthService] Generating tokens for user:", userId);
    
    const secret = process.env.JWT_SECRET || 'dev-secret-change-in-production';
    const issuer = process.env.JWT_ISSUER || 'moodchat-backend';
    const audience = process.env.JWT_AUDIENCE || 'moodchat-client';

    const accessToken = jwt.sign(
      { 
        userId, 
        type: 'access',
        iat: Math.floor(Date.now() / 1000)
      }, 
      secret,
      {
        expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
        issuer,
        audience,
      }
    );

    const refreshToken = jwt.sign(
      { 
        userId, 
        type: 'refresh',
        iat: Math.floor(Date.now() / 1000)
      }, 
      secret,
      {
        expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
        issuer,
        audience,
      }
    );

    return { 
      accessToken, 
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 15 * 60 // 15 minutes in seconds
    };
  }

  async validateToken(token) {
    try {
      console.log("🔧 [AuthService] Validating token");

      // Check blacklist
      if (AuthService.blacklistStore.has(token)) {
        throw new Error('Token has been invalidated');
      }

      const secret = process.env.JWT_SECRET || 'dev-secret-change-in-production';
      const decoded = jwt.verify(token, secret, {
        issuer: process.env.JWT_ISSUER || 'moodchat-backend',
        audience: process.env.JWT_AUDIENCE || 'moodchat-client',
      });

      return decoded;
    } catch (error) {
      console.error('❌ [AuthService] Token validation error:', error.message);
      throw error;
    }
  }

  // Cleanup old tokens from memory stores
  cleanupOldTokens() {
    const now = Date.now();
    
    // Clean token store
    for (const [token, data] of AuthService.tokenStore.entries()) {
      if (data.expires < now) {
        AuthService.tokenStore.delete(token);
      }
    }
    
    // Clean verification store
    for (const [token, data] of AuthService.verificationStore.entries()) {
      if (data.expires < now) {
        AuthService.verificationStore.delete(token);
      }
    }
    
    // Clean reset store
    for (const [token, data] of AuthService.resetStore.entries()) {
      if (data.expires < now) {
        AuthService.resetStore.delete(token);
      }
    }
    
    // Clean blacklist store
    for (const [token, data] of AuthService.blacklistStore.entries()) {
      if (data.expires < now) {
        AuthService.blacklistStore.delete(token);
      }
    }
  }
}

// Run cleanup every hour
setInterval(() => {
  const instance = new AuthService();
  instance.cleanupOldTokens();
}, 60 * 60 * 1000);

module.exports = new AuthService();
