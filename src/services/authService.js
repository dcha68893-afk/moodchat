const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class AuthService {
  // In-memory storage for development (fallback when database is unavailable)
  static tokenStore = new Map();
  static verificationStore = new Map();
  static resetStore = new Map();
  static blacklistStore = new Map();

  constructor() {
    this.db = null;
    this.User = null;
    this.initialized = false;
  }

  setDatabase(databaseService) {
    if (!databaseService) {
      console.warn('⚠️ [AuthService] No database service provided');
      return;
    }

    this.db = databaseService;
    this.User = databaseService.getUserModel();
    
    if (this.User) {
      this.initialized = true;
      console.log('✅ [AuthService] Connected to database User model');
    } else {
      console.warn('⚠️ [AuthService] User model not found in database');
    }
  }

  async register(userData, deviceInfo = {}) {
    try {
      console.log("🔧 [AuthService] Register called with:", { 
        username: userData.username, 
        email: userData.email
      });

      // Validate required fields
      if (!userData.username || !userData.email || !userData.password) {
        throw new Error('Username, email, and password are required');
      }

      // Check if database is available
      if (this.User) {
        try {
          // Check if user already exists in database
          const existingUser = await this.User.findOne({
            where: {
              [Op.or]: [
                { email: userData.email.toLowerCase().trim() },
                { username: userData.username.trim() }
              ]
            }
          });

          if (existingUser) {
            const errorMsg = existingUser.email === userData.email.toLowerCase().trim()
              ? 'Email already registered'
              : 'Username already taken';
            throw new Error(errorMsg);
          }

          // Create user in database - pass plain password, model will hash it
          const user = await this.User.create({
            username: userData.username.trim(),
            email: userData.email.toLowerCase().trim(),
            password: userData.password, // Model hook will hash it
            firstName: userData.firstName || null,
            lastName: userData.lastName || null,
            isActive: true,
            isVerified: process.env.NODE_ENV === 'development',
            status: 'online',
            avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(userData.username)}&background=random&color=fff`
          });

          console.log("✅ [AuthService] User created in database with ID:", user.id);

          // Generate tokens
          const tokens = this.generateTokens(user.id);

          // Store refresh token in central token service
          await require('../services/tokenService').storeRefreshToken(tokens.refreshToken, user.id);

          const userWithoutPassword = user.toJSON();
          delete userWithoutPassword.password;

          return {
            success: true,
            user: userWithoutPassword,
            tokens: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              tokenType: tokens.tokenType,
              expiresIn: tokens.expiresIn
            }
          };
        } catch (dbError) {
          console.error('❌ Database error during registration:', dbError.message);
          throw dbError;
        }
      } else {
        throw new Error('Database not available - User model not initialized');
      }
    } catch (error) {
      console.error('❌ [AuthService] Registration error:', error.message);
      throw error;
    }
  }

  async login(identifier, password, deviceInfo = {}) {
    try {
      console.log("🔧 [AuthService] Login attempt for:", identifier);

      // Check if database is available
      if (!this.User) {
        console.error('❌ [AuthService] User model not available');
        throw new Error('Service temporarily unavailable');
      }

      // Find user
      let user;
      if (identifier.includes('@')) {
        user = await this.User.findOne({ 
          where: { 
            email: identifier.toLowerCase().trim(),
            isActive: true
          } 
        });
      } else {
        user = await this.User.findOne({ 
          where: { 
            username: identifier.trim(),
            isActive: true
          } 
        });
      }

      if (!user) {
        console.log("❌ [AuthService] User not found");
        throw new Error('Invalid credentials');
      }

      console.log("✅ [AuthService] User found:", user.id);

      // Validate password using model method
      const isValidPassword = await user.validatePassword(password);
      
      if (!isValidPassword) {
        console.log("❌ [AuthService] Invalid password");
        throw new Error('Invalid credentials');
      }

      // Update last seen and status
      await user.update({
        lastSeen: new Date(),
        status: 'online'
      });

      // Generate tokens
      const tokens = this.generateTokens(user.id);

      // Store refresh token in central token service
      await require('../services/tokenService').storeRefreshToken(tokens.refreshToken, user.id);

      // Prepare response
      const userWithoutPassword = user.toJSON();
      delete userWithoutPassword.password;

      return {
        success: true,
        user: userWithoutPassword,
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenType: tokens.tokenType,
          expiresIn: tokens.expiresIn
        }
      };
    } catch (error) {
      console.error('❌ [AuthService] Login error:', error.message);
      throw error;
    }
  }

  // GOOGLE OAUTH FIX: verifies a Google ID token (from the frontend's Google
  // Identity Services button) and logs the user in, auto-creating an account
  // on first sign-in — mirrors register()/login()'s user-shape and token
  // issuance so the rest of the app (which only knows about local login)
  // doesn't need any special-casing for Google users.
  async loginWithGoogle(idToken) {
    try {
      if (!idToken) {
        throw new Error('Google credential is required');
      }
      if (!this.User) {
        throw new Error('Service temporarily unavailable');
      }

      const { OAuth2Client } = require('google-auth-library');
      const googleClientId = process.env.GOOGLE_CLIENT_ID;
      if (!googleClientId) {
        throw new Error('Google sign-in is not configured on the server');
      }
      const client = new OAuth2Client(googleClientId);

      let payload;
      try {
        const ticket = await client.verifyIdToken({ idToken, audience: googleClientId });
        payload = ticket.getPayload();
      } catch (verifyErr) {
        console.error('❌ [AuthService] Google token verification failed:', verifyErr.message);
        throw new Error('Invalid Google credential');
      }

      if (!payload || !payload.email) {
        throw new Error('Google account has no email on file');
      }
      if (payload.email_verified === false) {
        throw new Error('Google email is not verified');
      }

      const googleId = payload.sub;
      const email = payload.email.toLowerCase().trim();

      // Match an existing account by googleId first, then by email so a user
      // who registered with email/password can also sign in with Google.
      let user = await this.User.findOne({ where: { googleId } });
      if (!user) {
        user = await this.User.findOne({ where: { email } });
      }

      if (user) {
        const updates = { lastSeen: new Date(), status: 'online' };
        if (!user.googleId) updates.googleId = googleId;
        if (!user.isVerified) updates.isVerified = true;
        await user.update(updates);
      } else {
        // Derive a unique username from the Google profile since MoodChat
        // requires one; fall back to appending part of the Google id on collision.
        const base = (payload.given_name || email.split('@')[0])
          .toLowerCase().replace(/[^a-z0-9_]/g, '') || 'user';
        let username = base;
        let suffix = 0;
        // eslint-disable-next-line no-await-in-loop
        while (await this.User.findOne({ where: { username } })) {
          suffix += 1;
          username = `${base}${suffix}${crypto.randomBytes(1).toString('hex')}`;
        }

        // The model requires a password column; Google-only accounts get a
        // random one the user never sees/uses (they always sign in via Google).
        const randomPassword = crypto.randomBytes(32).toString('hex');

        user = await this.User.create({
          username,
          email,
          password: randomPassword, // hashed by the model's beforeCreate hook
          firstName: payload.given_name || null,
          lastName: payload.family_name || null,
          avatar: payload.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`,
          isActive: true,
          isVerified: true,
          status: 'online',
          googleId,
          authProvider: 'google'
        });

        console.log('✅ [AuthService] New user created via Google sign-in:', user.id);
      }

      const tokens = this.generateTokens(user.id);
      await require('../services/tokenService').storeRefreshToken(tokens.refreshToken, user.id);

      const userWithoutPassword = user.toJSON();
      delete userWithoutPassword.password;

      return {
        success: true,
        user: userWithoutPassword,
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenType: tokens.tokenType,
          expiresIn: tokens.expiresIn
        }
      };
    } catch (error) {
      console.error('❌ [AuthService] Google login error:', error.message);
      return { success: false, message: error.message, code: 'GOOGLE_AUTH_ERROR' };
    }
  }

  generateTokens(userId, userData = {}) {
    try {
      const tokenService = require('../services/tokenService');
      const user = {
        id: userId, userId: userId,
        email: userData.email || null,
        username: userData.username || null,
        role: userData.role || 'user'
      };
      const accessToken  = tokenService.generateAccessToken(user);
      const refreshToken = tokenService.generateRefreshToken(user);
      return {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn:  24 * 60 * 60,
        expiresAt:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };
    } catch(e) {
      throw new Error('Token service unavailable');
    }
  }

// SECURITY FIX #8: Removed this.JWT_SECRET (never set on instance) and replaced with
  // tokenService.verifyAccessToken() — single source of truth for verification.
  async verifyToken(token) {
    try {
      const tokenService = require('../services/tokenService');
      const result = tokenService.verifyAccessToken(token);
      if (result.valid) {
        return { success: true, data: result.decoded };
      }
      return { success: false, message: result.message || result.error };
    } catch (error) {
      console.error('Token verification error:', error.message);
      return { success: false, message: error.message };
    }
  }

async refreshToken(refreshToken) {
  try {
    const tokenService = require('../services/tokenService');
    const tokenData = await tokenService.validateStoredRefreshToken(refreshToken);
    if (!tokenData || !tokenData.valid) {
      throw new Error('Invalid or expired refresh token');
    }

    // SECURITY FIX: Use tokenService.verifyRefreshToken instead of raw jwt.verify with this.JWT_SECRET
    const verifyResult = tokenService.verifyRefreshToken(refreshToken);
    if (!verifyResult.valid) {
      throw new Error('Invalid or expired refresh token');
    }
    const decoded = verifyResult.decoded;
    
    // Generate new tokens
    const tokens = this.generateTokens(decoded.userId);

    // Delete old refresh token
    await tokenService.invalidateRefreshToken(refreshToken);

    // Store new refresh token
    await tokenService.storeRefreshToken(tokens.refreshToken, decoded.userId);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn
    };
  } catch (error) {
    console.error('Refresh token error:', error.message);
    return { success: false, message: error.message };
  }
}

  async logout(userId) {
    try {
      console.log('Logout for user:', userId);
      return { success: true };
    } catch (error) {
      console.error('Logout error:', error.message);
      return { success: false, message: error.message };
    }
  }

  async getCurrentUser(userId) {
    try {
      if (!this.User) {
        throw new Error('User model not available');
      }

      const user = await this.User.findByPk(userId, {
        attributes: { exclude: ['password'] }
      });
      
      if (user) {
        return { success: true, user: user.toJSON() };
      }

      return { success: false, message: 'User not found' };
    } catch (error) {
      console.error('Get current user error:', error.message);
      return { success: false, message: error.message };
    }
  }

  async forgotPassword(email) {
    try {
      if (!this.User) {
        throw new Error('User model not available');
      }

      const user = await this.User.findOne({ 
        where: { email: email.toLowerCase().trim() } 
      });
      
      if (!user) {
        // Don't reveal that user doesn't exist for security
        return { success: true, message: 'If an account exists, a reset email has been sent' };
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

      await user.update({
        resetToken: resetToken,
        resetTokenExpiry: resetTokenExpiry
      });

      console.log(`📧 Password reset token issued for ${email}`);

      return { 
        success: true, 
        message: 'Password reset email sent',
        resetToken: process.env.NODE_ENV === 'development' ? resetToken : undefined
      };
    } catch (error) {
      console.error('Forgot password error:', error.message);
      return { success: false, message: error.message };
    }
  }

  async resetPassword(token, newPassword) {
    try {
      if (!this.User) {
        throw new Error('User model not available');
      }

      const user = await this.User.findOne({
        where: {
          resetToken: token,
          resetTokenExpiry: { [Op.gt]: new Date() }
        }
      });

      if (!user) {
        throw new Error('Invalid or expired reset token');
      }

      // Update password - model hook will hash it
      await user.update({
        password: newPassword,
        resetToken: null,
        resetTokenExpiry: null
      });

      return { success: true, message: 'Password reset successful' };
    } catch (error) {
      console.error('Reset password error:', error.message);
      return { success: false, message: error.message };
    }
  }

validateJWTConfig() {
    // FIX (Forensic Audit P0): JWT_ACCESS_SECRET first to match tokenService.js signing order
    const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
    // Check if secret is properly configured (not using default fallback)
    if (!secret) {
        console.warn('JWT_SECRET not properly configured');
        return false;
    }
    console.log('✅ JWT_SECRET properly configured');
    return true;
}
}

// Create and export a single instance
const authServiceInstance = new AuthService();
module.exports = authServiceInstance;