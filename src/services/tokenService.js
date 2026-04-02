// services/tokenService.js
const jwt = require('jsonwebtoken');

class TokenService {
 
constructor() {
    // CRITICAL: Force reload of environment variables
    if (process.env.NODE_ENV !== 'production') {
        try {
            const path = require('path');
            const dotenvPath = path.join(__dirname, '..', '..', '.env');
            console.log('[TokenService] Attempting to load .env from:', dotenvPath);
            require('dotenv').config({ path: dotenvPath });
        } catch (e) {
            console.log('[TokenService] dotenv load error:', e.message);
        }
    }
    
    // Get secrets
    this.accessSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
    this.refreshSecret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
    
    // Debug output
    console.log('[TokenService] ========== INITIALIZATION ==========');
    console.log('[TokenService] JWT_SECRET from env:', process.env.JWT_SECRET ? 'SET (length: ' + process.env.JWT_SECRET.length + ')' : 'NOT SET');
    console.log('[TokenService] JWT_ACCESS_SECRET from env:', process.env.JWT_ACCESS_SECRET ? 'SET (length: ' + process.env.JWT_ACCESS_SECRET.length + ')' : 'NOT SET');
    console.log('[TokenService] Access secret configured:', this.accessSecret ? 'YES' : 'NO');
    console.log('[TokenService] Access secret first 10 chars:', this.accessSecret ? this.accessSecret.substring(0, 10) : 'undefined');
    
    if (!this.accessSecret) {
        console.error('❌ [TokenService] No JWT secret configured!');
        console.error('Please set JWT_SECRET or JWT_ACCESS_SECRET in .env file');
        
        if (process.env.NODE_ENV === 'development') {
            console.warn('⚠️ [TokenService] Using DEVELOPMENT DEFAULT SECRET - NOT SECURE!');
            this.accessSecret = 'development-default-secret-do-not-use-in-production';
            this.refreshSecret = 'development-default-secret-do-not-use-in-production';
        } else {
            throw new Error('JWT_SECRET or JWT_ACCESS_SECRET must be set');
        }
    }
    
    // FIX: Ensure expiry values are valid
    const accessExpiryEnv = process.env.JWT_ACCESS_EXPIRES_IN;
    const refreshExpiryEnv = process.env.JWT_REFRESH_EXPIRES_IN;
    
    // Validate and set expiry
    if (accessExpiryEnv && (typeof accessExpiryEnv === 'string' || typeof accessExpiryEnv === 'number')) {
        this.accessExpiry = accessExpiryEnv;
    } else {
        this.accessExpiry = '24h';
    }
    
    if (refreshExpiryEnv && (typeof refreshExpiryEnv === 'string' || typeof refreshExpiryEnv === 'number')) {
        this.refreshExpiry = refreshExpiryEnv;
    } else {
        this.refreshExpiry = '7d';
    }
    
    console.log('[TokenService] ✅ Initialized with expiry:', this.accessExpiry);
    console.log('[TokenService] =====================================');
}
  generateAccessToken(user) {
    // CRITICAL FIX: Ensure userId is properly extracted
    const userId = user.id || user.userId || user._id;
    
    if (!userId) {
      console.error('[TokenService] ❌ Cannot generate token: No user ID found in user object:', Object.keys(user));
      throw new Error('Cannot generate token: Missing user ID');
    }
    
    // CRITICAL FIX: Consistent payload structure with type field
    const payload = {
      userId: userId,
      id: userId,
      email: user.email || null,
      username: user.username || null,
      role: user.role || 'user',
      type: 'access'  // ← CRITICAL: Type field for token identification
    };
    
    console.log('[TokenService] 🔐 Generating access token for user:', {
      userId: payload.userId,
      email: payload.email,
      username: payload.username,
      role: payload.role,
      type: payload.type
    });
    
    const token = jwt.sign(payload, this.accessSecret, {
      expiresIn: this.accessExpiry
    });
    
    console.log('[TokenService] ✅ Access token generated successfully');
    console.log('[TokenService] Token prefix:', token.substring(0, 30) + '...');
    
    return token;
  }
  
  generateRefreshToken(user) {
    const userId = user.id || user.userId || user._id;
    
    if (!userId) {
      console.error('[TokenService] ❌ Cannot generate refresh token: Missing user ID');
      throw new Error('Cannot generate refresh token: Missing user ID');
    }
    
    const payload = {
      userId: userId,
      id: userId,
      type: 'refresh'  // ← CRITICAL: Type field
    };
    
    console.log('[TokenService] 🔐 Generating refresh token for user:', userId);
    
    const token = jwt.sign(payload, this.refreshSecret, {
      expiresIn: this.refreshExpiry
    });
    
    console.log('[TokenService] ✅ Refresh token generated successfully');
    return token;
  }

  verifyAccessToken(token) {
    try {
      console.log('[TokenService] 🔍 Verifying access token...');
      console.log('[TokenService] Token prefix:', token.substring(0, 30) + '...');
      console.log('[TokenService] Using secret:', this.accessSecret ? 'SET (first 10 chars: ' + this.accessSecret.substring(0, 10) + ')' : 'NOT SET');
      
      const decoded = jwt.verify(token, this.accessSecret);
      
      console.log('[TokenService] ✅ Verification successful');
      console.log('[TokenService] Decoded payload:', {
        userId: decoded.userId,
        id: decoded.id,
        email: decoded.email,
        username: decoded.username,
        type: decoded.type,
        exp: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null
      });
      
      // CRITICAL FIX: Validate token type
      if (decoded.type && decoded.type !== 'access') {
        console.error('[TokenService] ❌ Token type mismatch. Expected "access", got:', decoded.type);
        return { 
          valid: false, 
          error: 'INVALID_TOKEN_TYPE',
          message: 'Token type must be "access"'
        };
      }
      
      return { valid: true, decoded };
    } catch (error) {
      console.log('[TokenService] ❌ Verification failed:');
      console.log('[TokenService]   Error name:', error.name);
      console.log('[TokenService]   Error message:', error.message);
      
      return { 
        valid: false, 
        error: error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: error.message 
      };
    }
  }

  verifyRefreshToken(token) {
    try {
      console.log('[TokenService] 🔍 Verifying refresh token...');
      const decoded = jwt.verify(token, this.refreshSecret);
      
      console.log('[TokenService] ✅ Refresh token verified for user:', decoded.userId);
      console.log('[TokenService] Token type:', decoded.type);
      
      // CRITICAL FIX: Validate token type
      if (decoded.type && decoded.type !== 'refresh') {
        console.error('[TokenService] ❌ Token type mismatch. Expected "refresh", got:', decoded.type);
        return { 
          valid: false, 
          error: 'INVALID_TOKEN_TYPE',
          message: 'Token type must be "refresh"'
        };
      }
      
      return { valid: true, decoded };
    } catch (error) {
      console.log(`[TokenService] Refresh token verification failed: ${error.message}`);
      return { 
        valid: false, 
        error: error.name === 'TokenExpiredError' ? 'REFRESH_TOKEN_EXPIRED' : 'INVALID_REFRESH_TOKEN',
        message: error.message 
      };
    }
  }

  extractTokenFromRequest(req) {
    console.log('[TokenService] 🔍 Extracting token from request...');
    
    // Try Authorization header first
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader) {
      console.log('[TokenService] Authorization header found:', authHeader.substring(0, 30) + '...');
      
      if (authHeader.toLowerCase().startsWith('bearer ')) {
        const parts = authHeader.split(' ');
        if (parts.length === 2 && parts[1].trim()) {
          console.log('[TokenService] ✅ Token extracted from Authorization header');
          return parts[1].trim();
        } else {
          console.log('[TokenService] ⚠️ Invalid Authorization header format');
        }
      } else {
        console.log('[TokenService] ⚠️ Authorization header does not start with Bearer');
      }
    }
    
    // Try x-access-token header
    const xAccessToken = req.headers['x-access-token'];
    if (xAccessToken && xAccessToken.trim()) {
      console.log('[TokenService] ✅ Token extracted from x-access-token header');
      return xAccessToken.trim();
    }
    
    // Try cookies
    if (req.cookies && req.cookies.accessToken) {
      console.log('[TokenService] ✅ Token extracted from cookies');
      return req.cookies.accessToken;
    }
    
    console.log('[TokenService] ❌ No token found in request');
    return null;
  }

  extractRefreshTokenFromRequest(req) {
    // Try body first
    if (req.body && req.body.refreshToken) {
      console.log('[TokenService] Refresh token extracted from body');
      return req.body.refreshToken;
    }
    
    // Try cookies
    if (req.cookies && req.cookies.refreshToken) {
      console.log('[TokenService] Refresh token extracted from cookies');
      return req.cookies.refreshToken;
    }
    
    // Try headers
    const refreshHeader = req.headers['x-refresh-token'];
    if (refreshHeader && refreshHeader.trim()) {
      console.log('[TokenService] Refresh token extracted from headers');
      return refreshHeader.trim();
    }
    
    console.log('[TokenService] No refresh token found in request');
    return null;
  }

  // Store refresh token (in-memory for now, could be moved to database)
  static refreshTokenStore = new Map();
  
  storeRefreshToken(token, userId, expiresIn = 7 * 24 * 60 * 60 * 1000) {
    TokenService.refreshTokenStore.set(token, {
      userId,
      expiresAt: Date.now() + expiresIn,
      createdAt: new Date().toISOString()
    });
    console.log(`[TokenService] ✅ Stored refresh token for user ${userId}`);
  }
  
  validateStoredRefreshToken(token) {
    const stored = TokenService.refreshTokenStore.get(token);
    if (!stored) {
      console.log('[TokenService] Refresh token not found in store');
      return { valid: false, error: 'TOKEN_NOT_FOUND' };
    }
    
    if (stored.expiresAt < Date.now()) {
      console.log('[TokenService] Stored refresh token expired');
      TokenService.refreshTokenStore.delete(token);
      return { valid: false, error: 'TOKEN_EXPIRED' };
    }
    
    return { valid: true, userId: stored.userId };
  }
  
  invalidateRefreshToken(token) {
    TokenService.refreshTokenStore.delete(token);
    console.log('[TokenService] Invalidated refresh token');
  }
}

module.exports = new TokenService();