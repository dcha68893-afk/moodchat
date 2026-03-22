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
    // Exact match for root
    if (publicPath === '/' && path === '/') return true;
    // Path starts with public path
    return path.startsWith(publicPath);
  });
};

// ===== CRITICAL FIX 1: STANDARDIZED TOKEN EXTRACTION =====
const extractToken = (req) => {
  // CRITICAL: Check both lowercase and uppercase header variants
  const authHeader = req.headers.authorization || req.headers.Authorization;
  
  if (!authHeader) {
    console.log('[Auth] ❌ No authorization header found');
    return null;
  }
  
  // CRITICAL: Strict Bearer token format check (case-insensitive)
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    console.log('[Auth] ❌ Authorization header does not start with Bearer');
    return null;
  }
  
  // CRITICAL: Extract token using split method (most reliable)
  const parts = authHeader.split(' ');
  if (parts.length !== 2) {
    console.log('[Auth] ❌ Invalid Authorization header format. Expected: Bearer <token>');
    return null;
  }
  
  const token = parts[1];
  
  if (!token || token.trim() === '') {
    console.log('[Auth] ❌ Empty token after Bearer prefix');
    return null;
  }
  
  console.log(`[Auth] ✅ Token extracted successfully, length: ${token.length} chars`);
  return token;
};

// ===== CRITICAL FIX 2: UNIFIED AUTHENTICATION MIDDLEWARE =====
const authenticateToken = (req, res, next) => {
  try {
    const requestPath = req.path;
    
    // Step 1: Check if path is public (skip auth)
    if (isPublicPath(requestPath)) {
      console.log(`[Auth] 🔓 Public path accessed: ${req.method} ${requestPath}`);
      return next();
    }
    
    console.log(`[Auth] 🔒 Protected route accessed: ${req.method} ${requestPath}`);
    
    // ===== DEBUG LOGGING (COMMENT OUT IN PRODUCTION) =====
    // console.log('[Auth DEBUG]', {
    //   path: requestPath,
    //   hasAuthHeader: !!(req.headers.authorization || req.headers.Authorization),
    //   headerValue: req.headers.authorization ? 
    //     `${req.headers.authorization.substring(0, 20)}...` : 
    //     req.headers.Authorization ? 
    //       `${req.headers.Authorization.substring(0, 20)}...` : 'none'
    // });
    
    // Step 2: Skip if already authenticated (prevent double verification)
    if (req.user && req.user._verified) {
      console.log('[Auth] ⏭️ Request already authenticated, skipping verification');
      return next();
    }
    
    // Step 3: Extract token using standardized function
    const token = extractToken(req);
    
    if (!token) {
      console.log('[Auth] ❌ Authentication required - no valid token found');
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
      console.log('[Auth] ✅ Token verified successfully');
    } catch (jwtError) {
      console.error('[Auth] ❌ Token verification failed:', jwtError.name, jwtError.message);
      
      // Token expired
      if (jwtError.name === 'TokenExpiredError') {
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
        return res.status(401).json({
          success: false,
          message: 'Invalid authentication token.',
          errorCode: 'INVALID_TOKEN',
          code: 'INVALID_TOKEN',
          timestamp: new Date().toISOString()
        });
      }
      
      // Other JWT errors
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
      console.error('[Auth] ❌ Token verification returned invalid payload');
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
      console.error('[Auth] ❌ No user identifier found in token. Token payload keys:', Object.keys(decoded));
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
      id: userId,  // CRITICAL: Always set both
      
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
      console.error('[Auth] ❌ CRITICAL: Failed to attach user ID to request');
      return res.status(401).json({
        success: false,
        message: 'Authentication failed - user context error.',
        errorCode: 'USER_CONTEXT_MISSING',
        code: 'USER_CONTEXT_MISSING',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 10: Log successful authentication
    console.log(`[Auth] ✅ User authenticated: ${req.user.id} (${req.user.email || 'no email'}) [Session: ${sessionId || 'none'}]`);
    
    return next();
    
  } catch (error) {
    // Catch any unexpected errors
    console.error('[Auth] 🚨 Unexpected authentication error:', error.message);
    console.error('[Auth] Stack trace:', error.stack);
    
    return res.status(500).json({
      success: false,
      message: 'Authentication failed due to server error.',
      errorCode: 'AUTH_MIDDLEWARE_ERROR',
      code: 'SERVER_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// Role-based authorization middleware (UNCHANGED - fully functional)
const authorize = (...roles) => {
  return (req, res, next) => {
    try {
      console.log(`[Auth] 🔑 Authorization middleware invoked for roles: [${roles.join(', ')}]`);
      
      if (!req.user) {
        console.log('[Auth] ❌ No user object found for authorization');
        return res.status(401).json({
          success: false,
          message: 'Authentication required before authorization.',
          errorCode: 'NO_USER_CONTEXT',
          code: 'NO_USER_CONTEXT',
          timestamp: new Date().toISOString()
        });
      }
      
      // If no roles specified, just allow authenticated users
      if (roles.length === 0) {
        console.log('[Auth] ✅ No specific roles required, user authorized');
        return next();
      }
      
      // Check if user has required role
      const userRole = req.user.role;
      if (!userRole) {
        console.log('[Auth] ❌ User has no role assigned');
        return res.status(403).json({
          success: false,
          message: 'User role not defined.',
          errorCode: 'NO_ROLE',
          code: 'NO_ROLE',
          timestamp: new Date().toISOString()
        });
      }
      
      if (!roles.includes(userRole)) {
        console.log(`[Auth] ❌ User role '${userRole}' not in required roles: [${roles.join(', ')}]`);
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
      
      console.log(`[Auth] ✅ User authorized with role: ${userRole}`);
      return next();
      
    } catch (error) {
      console.error('[Auth] 🚨 Authorization error:', error.message);
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

// Socket.io authentication middleware (FIXED with same token extraction pattern)
const socketAuthenticate = async (socket, next) => {
  try {
    console.log('[Auth] 🔌 Socket.io authentication middleware invoked');
    
    // Standardized token extraction for Socket.io
    let token = null;
    
    // Check multiple possible locations for token
    const authHeader = socket.handshake.headers.authorization || socket.handshake.headers.Authorization;
    const xAccessToken = socket.handshake.headers['x-access-token'];
    
    if (authHeader) {
      // Check Bearer format
      if (authHeader.toLowerCase().startsWith('bearer ')) {
        const parts = authHeader.split(' ');
        if (parts.length === 2) {
          token = parts[1];
          console.log('[Auth] Socket token extracted from Authorization Bearer header');
        }
      }
    } else if (xAccessToken) {
      token = xAccessToken;
      console.log('[Auth] Socket token extracted from x-access-token header');
    } else if (socket.handshake.auth && socket.handshake.auth.token) {
      token = socket.handshake.auth.token;
      console.log('[Auth] Socket token extracted from handshake auth');
    }
    
    console.log(`[Auth] Socket token found: ${token ? 'Yes' : 'No'}`);
    
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ No token provided for socket connection');
      return next(new Error('Authentication error: No token provided'));
    }
    
    // Safe token verification
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      console.log('[Auth] ✅ Socket token verified successfully');
    } catch (jwtError) {
      console.error('[Auth] ❌ Socket token verification failed:', jwtError.name);
      
      if (jwtError.name === 'TokenExpiredError') {
        return next(new Error('Authentication error: Token expired'));
      }
      
      if (jwtError.name === 'JsonWebTokenError') {
        return next(new Error('Authentication error: Invalid token'));
      }
      
      return next(new Error('Authentication error: Invalid token'));
    }
    
    // Normalized user ID extraction
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] ❌ No user identifier in socket token');
      return next(new Error('Authentication error: Invalid user information'));
    }
    
    // Check for existing socket connection for this user/session
    const sessionId = decoded.sessionId || decoded.jti;
    
    // Attach normalized user info to socket
    socket.userId = userId;
    socket.user = {
      id: userId,                    // Normalized field
      userId: userId,                 // Keep for compatibility
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
    
    console.log(`[Auth] ✅ Socket authenticated for user: ${userId} [Session: ${sessionId || 'none'}]`);
    return next();
    
  } catch (error) {
    console.error('[Auth] 🚨 Unexpected socket authentication error:', error);
    return next(new Error('Authentication error'));
  }
};

// Alias for compatibility
const authenticate = authenticateToken;
const authMiddleware = authenticateToken;

// Token refresh validation (for refresh endpoint)
const validateRefreshToken = (req, res, next) => {
  try {
    console.log('[Auth] 🔄 Refresh token validation');
    
    // Extract refresh token from body
    let refreshToken = req.body.refreshToken;
    
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token required.',
        errorCode: 'NO_REFRESH_TOKEN',
        code: 'NO_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
    // Verify refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    
    // Store in request for later use
    req.refreshToken = refreshToken;
    req.refreshTokenPayload = decoded;
    
    return next();
    
  } catch (error) {
    console.error('[Auth] ❌ Refresh token validation failed:', error.message);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired. Please log in again.',
        errorCode: 'REFRESH_TOKEN_EXPIRED',
        code: 'REFRESH_TOKEN_EXPIRED',
        timestamp: new Date().toISOString()
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token.',
        errorCode: 'INVALID_REFRESH_TOKEN',
        code: 'INVALID_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
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
  console.log('[Auth] 🔐 JWT_SECRET from .env:', process.env.JWT_SECRET ? 'Loaded' : 'Not loaded');
  console.log('[Auth] 🔐 Using JWT_SECRET prefix:', JWT_SECRET.substring(0, 10) + '...');
  
  if (!process.env.JWT_SECRET && !process.env.JWT_ACCESS_SECRET) {
    console.warn('[Auth] ⚠️ WARNING: JWT_SECRET environment variable is not set!');
    console.warn('[Auth] Using fallback secret. This is INSECURE for production!');
    console.warn('[Auth] Set JWT_SECRET environment variable in production.');
  } else {
    console.log('[Auth] ✅ JWT_SECRET environment variable is configured');
  }
})();

// Utility functions
module.exports = {
  authenticateToken,
  authenticate,
  authMiddleware,
  authorize,
  socketAuthenticate,
  validateRefreshToken,
  
  // FIXED: Standardized token extraction utility
  extractToken: extractToken,
  
  decodeToken: (token) => {
    try {
      if (!token) return null;
      return jwt.decode(token);
    } catch (error) {
      return null;
    }
  },
  
  // Safe token logging utility
  safeTokenLog: (token) => {
    if (!token || token.length < 15) return '[Invalid Token]';
    return `${token.substring(0, 6)}...${token.substring(token.length - 6)}`;
  },
  
  // Public paths checker
  isPublicPath,
  PUBLIC_PATHS,
  
  // Configuration
  JWT_SECRET: JWT_SECRET
};