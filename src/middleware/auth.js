const jwt = require('jsonwebtoken');

// Load JWT secret from environment with fallback (but warn in production)
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || '3e78ab2d6cb698f95b3b8d510614058c';

// Public paths that don't require authentication - EXPANDED for clarity
const PUBLIC_PATHS = [
  '/',
  '/api/status',
  '/api/health',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/validate-token',
  '/api/info',
  '/api/cors-info',
  '/health',
  '/live',
  '/ready',
  '/ws-test.html'
];

// Check if path is public
const isPublicPath = (path) => {
  return PUBLIC_PATHS.some(publicPath => {
    if (publicPath === '/' && path === '/') return true;
    return path.startsWith(publicPath);
  });
};

// ===== CRITICAL FIX: STANDARDIZED TOKEN EXTRACTION =====
const extractToken = (req) => {
  // CRITICAL: Check both lowercase and uppercase header variants
  const authHeader = req.headers.authorization || req.headers.Authorization;
  
  if (!authHeader) {
    if (process.env.NODE_ENV === 'development') {
      console.log('[Auth] No authorization header found');
    }
    return null;
  }
  
  // CRITICAL: Strict Bearer token format check (case-insensitive)
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    if (process.env.NODE_ENV === 'development') {
      console.log('[Auth] Authorization header does not start with Bearer');
    }
    return null;
  }
  
  // CRITICAL: Extract token using split method (most reliable)
  const parts = authHeader.split(' ');
  if (parts.length !== 2) {
    if (process.env.NODE_ENV === 'development') {
      console.log('[Auth] Invalid Authorization header format. Expected: Bearer <token>');
    }
    return null;
  }
  
  const token = parts[1];
  
  if (!token || token.trim() === '') {
    if (process.env.NODE_ENV === 'development') {
      console.log('[Auth] Empty token after Bearer prefix');
    }
    return null;
  }
  
  if (process.env.NODE_ENV === 'development') {
    console.log(`[Auth] Token extracted successfully, length: ${token.length} chars`);
  }
  return token;
};

// ===== CRITICAL FIX: UNIFIED AUTHENTICATION MIDDLEWARE =====
const authenticateToken = (req, res, next) => {
  try {
    const requestPath = req.path;
    
    // Step 1: Check if path is public (skip auth)
    if (isPublicPath(requestPath)) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Auth] Public path accessed: ${req.method} ${requestPath}`);
      }
      return next();
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Auth] Protected route accessed: ${req.method} ${requestPath}`);
    }
    
    // Step 2: Skip if already authenticated (prevent double verification)
    if (req.user && req.user._verified) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Auth] Request already authenticated, skipping verification');
      }
      return next();
    }
    
    // Step 3: Extract token using standardized function
    const token = extractToken(req);
    
    if (!token) {
      console.log('[Auth] Authentication required - no valid token found');
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Authorization header required with Bearer token',
        errorCode: 'MISSING_AUTH_HEADER',
        code: 'MISSING_AUTH_HEADER',
        path: requestPath,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 4: Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      if (process.env.NODE_ENV === 'development') {
        console.log('[Auth] Token verified successfully');
      }
    } catch (jwtError) {
      console.error('[Auth] Token verification failed:', jwtError.name, jwtError.message);
      
      // Token expired
      if (jwtError.name === 'TokenExpiredError') {
        // CRITICAL: Use return to prevent double response
        return res.status(401).json({
          success: false,
          message: 'Your session has expired. Please log in again.',
          errorCode: 'TOKEN_EXPIRED',
          code: 'TOKEN_EXPIRED',
          timestamp: new Date().toISOString(),
          expiredAt: jwtError.expiredAt
        });
      }
      
      // Invalid token
      if (jwtError.name === 'JsonWebTokenError') {
        // CRITICAL: Use return to prevent double response
        return res.status(401).json({
          success: false,
          message: 'Invalid authentication token.',
          errorCode: 'INVALID_TOKEN',
          code: 'INVALID_TOKEN',
          timestamp: new Date().toISOString()
        });
      }
      
      // Other JWT errors
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Authentication failed.',
        errorCode: 'AUTH_FAILED',
        code: 'AUTH_FAILED',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 5: Validate decoded payload structure
    if (!decoded || typeof decoded !== 'object') {
      console.error('[Auth] Token verification returned invalid payload');
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload.',
        errorCode: 'INVALID_PAYLOAD',
        code: 'INVALID_PAYLOAD',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 6: Extract user ID with multiple fallbacks
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] No user identifier found in token. Token payload keys:', Object.keys(decoded));
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Invalid user information in token.',
        errorCode: 'NO_USER_ID',
        code: 'NO_USER_ID',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 7: Extract session info if present
    const sessionId = decoded.sessionId || decoded.jti;
    if (sessionId) {
      req.sessionId = sessionId;
    }
    
    // Step 8: ATTACH NORMALIZED USER OBJECT TO REQUEST
    req.user = {
      // Verification flag to prevent double verification
      _verified: true,
      
      // Normalized user identification (BOTH id and userId for compatibility)
      userId: userId,
      id: userId,
      
      // User details from token
      email: decoded.email || null,
      username: decoded.username || null,
      role: decoded.role || 'user',
      
      // Session information
      sessionId: sessionId || null,
      deviceId: decoded.deviceId || null,
      
      // Token metadata
      tokenIssuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null,
      
      // Store original token hash (truncated for logging)
      _tokenHash: token.substring(0, 10) + '...' + token.substring(token.length - 5)
    };
    
    // Step 9: Final validation
    if (!req.user || !req.user.id) {
      console.error('[Auth] CRITICAL: Failed to attach user ID to request');
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Authentication failed - user context error.',
        errorCode: 'USER_CONTEXT_MISSING',
        code: 'USER_CONTEXT_MISSING',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 10: Log successful authentication
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Auth] User authenticated: ${req.user.id} (${req.user.email || 'no email'}) [Session: ${sessionId || 'none'}]`);
    }
    
    return next();
    
  } catch (error) {
    // Catch any unexpected errors
    console.error('[Auth] Unexpected authentication error:', error.message);
    if (process.env.NODE_ENV === 'development') {
      console.error('[Auth] Stack trace:', error.stack);
    }
    
    // CRITICAL: Use return to prevent double response
    return res.status(500).json({
      success: false,
      message: 'Authentication failed due to server error.',
      errorCode: 'AUTH_MIDDLEWARE_ERROR',
      code: 'SERVER_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// Role-based authorization middleware
const authorize = (...roles) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        // CRITICAL: Use return to prevent double response
        return res.status(401).json({
          success: false,
          message: 'Authentication required before authorization.',
          errorCode: 'NO_USER_CONTEXT',
          code: 'NO_USER_CONTEXT',
          timestamp: new Date().toISOString()
        });
      }
      
      if (roles.length === 0) {
        return next();
      }
      
      const userRole = req.user.role;
      if (!userRole) {
        // CRITICAL: Use return to prevent double response
        return res.status(403).json({
          success: false,
          message: 'User role not defined.',
          errorCode: 'NO_ROLE',
          code: 'NO_ROLE',
          timestamp: new Date().toISOString()
        });
      }
      
      if (!roles.includes(userRole)) {
        // CRITICAL: Use return to prevent double response
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions to access this resource.',
          errorCode: 'INSUFFICIENT_PERMISSIONS',
          code: 'INSUFFICIENT_PERMISSIONS',
          requiredRoles: roles,
          userRole: userRole,
          timestamp: new Date().toISOString()
        });
      }
      
      return next();
      
    } catch (error) {
      console.error('[Auth] Authorization error:', error.message);
      // CRITICAL: Use return to prevent double response
      return res.status(500).json({
        success: false,
        message: 'Authorization failed due to server error.',
        errorCode: 'AUTHORIZATION_ERROR',
        code: 'AUTHORIZATION_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  };
};

// Socket.io authentication middleware
const socketAuthenticate = async (socket, next) => {
  try {
    let token = null;
    
    const authHeader = socket.handshake.headers.authorization || socket.handshake.headers.Authorization;
    const xAccessToken = socket.handshake.headers['x-access-token'];
    
    if (authHeader) {
      if (authHeader.toLowerCase().startsWith('bearer ')) {
        const parts = authHeader.split(' ');
        if (parts.length === 2) {
          token = parts[1];
        }
      }
    } else if (xAccessToken) {
      token = xAccessToken;
    } else if (socket.handshake.auth && socket.handshake.auth.token) {
      token = socket.handshake.auth.token;
    }
    
    if (!token || token.trim() === '') {
      return next(new Error('Authentication error: No token provided'));
    }
    
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return next(new Error('Authentication error: Token expired'));
      }
      return next(new Error('Authentication error: Invalid token'));
    }
    
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      return next(new Error('Authentication error: Invalid user information'));
    }
    
    const sessionId = decoded.sessionId || decoded.jti;
    
    socket.userId = userId;
    socket.user = {
      id: userId,
      userId: userId,
      email: decoded.email || null,
      username: decoded.username || null,
      role: decoded.role || 'user',
      permissions: decoded.permissions || [],
      sessionId: sessionId || null,
      tokenIssuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null,
      _verified: true
    };
    socket.token = token;
    
    return next();
    
  } catch (error) {
    console.error('[Auth] Socket authentication error:', error);
    return next(new Error('Authentication error'));
  }
};

// Token refresh validation
const validateRefreshToken = (req, res, next) => {
  try {
    let refreshToken = req.body.refreshToken;
    
    if (!refreshToken) {
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Refresh token required.',
        errorCode: 'NO_REFRESH_TOKEN',
        code: 'NO_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    
    req.refreshToken = refreshToken;
    req.refreshTokenPayload = decoded;
    
    return next();
    
  } catch (error) {
    console.error('[Auth] Refresh token validation failed:', error.message);
    
    if (error.name === 'TokenExpiredError') {
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired. Please log in again.',
        errorCode: 'REFRESH_TOKEN_EXPIRED',
        code: 'REFRESH_TOKEN_EXPIRED',
        timestamp: new Date().toISOString()
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      // CRITICAL: Use return to prevent double response
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token.',
        errorCode: 'INVALID_REFRESH_TOKEN',
        code: 'INVALID_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
    // CRITICAL: Use return to prevent double response
    return res.status(401).json({
      success: false,
      message: 'Refresh token validation failed.',
      errorCode: 'REFRESH_TOKEN_ERROR',
      code: 'REFRESH_TOKEN_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// Validate JWT secret on module load
(function validateJwtSecret() {
  console.log('[Auth] JWT_SECRET from .env:', process.env.JWT_SECRET ? 'Loaded' : 'Not loaded');
  console.log('[Auth] Using JWT_SECRET prefix:', JWT_SECRET.substring(0, 10) + '...');
  
  if (!process.env.JWT_SECRET && !process.env.JWT_ACCESS_SECRET) {
    console.warn('[Auth] WARNING: JWT_SECRET environment variable is not set!');
    console.warn('[Auth] Using fallback secret. This is INSECURE for production!');
    console.warn('[Auth] Set JWT_SECRET environment variable in production.');
  } else {
    console.log('[Auth] JWT_SECRET environment variable is configured');
  }
})();

// Utility functions
module.exports = {
  authenticateToken,
  authenticate: authenticateToken,
  authMiddleware: authenticateToken,
  authorize,
  socketAuthenticate,
  validateRefreshToken,
  extractToken,
  
  decodeToken: (token) => {
    try {
      if (!token) return null;
      return jwt.decode(token);
    } catch (error) {
      return null;
    }
  },
  
  safeTokenLog: (token) => {
    if (!token || token.length < 15) return '[Invalid Token]';
    return `${token.substring(0, 6)}...${token.substring(token.length - 6)}`;
  },
  
  isPublicPath,
  PUBLIC_PATHS,
  JWT_SECRET
};