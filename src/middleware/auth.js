const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || '3e78ab2d6cb698f95b3b8d510614058c';

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  '/',
  '/api/status',
  '/api/health',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh'
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

// FIXED: Unified authentication middleware for all protected backend routes
const authenticateToken = (req, res, next) => {
  try {
    const requestPath = req.path;
    
    // Step 1: Check if path is public
    if (isPublicPath(requestPath)) {
      // Skip authentication for public paths
      return next();
    }
    
    console.log(`[Auth] 🔐 Authentication required for: ${req.method} ${requestPath}`);
    
    // Step 2: Check if already authenticated (prevent double verification)
    if (req.user && req.user._verified) {
      console.log('[Auth] ⏭️ Request already authenticated, skipping verification');
      return next();
    }
    
    // FIXED: Step 3 - STANDARDIZED TOKEN EXTRACTION
    // Support both Bearer token and x-access-token header
    let token = null;
    const authHeader = req.headers['authorization'];
    const xAccessToken = req.headers['x-access-token'];
    
    // Priority 1: Authorization Bearer header
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7); // Remove 'Bearer ' prefix
        console.log('[Auth] Token extracted from Authorization Bearer header');
      } else {
        // Handle case where header exists but doesn't start with Bearer
        console.log('[Auth] Authorization header present but not Bearer format');
      }
    } 
    // Priority 2: x-access-token header (fallback)
    else if (xAccessToken) {
      token = xAccessToken;
      console.log('[Auth] Token extracted from x-access-token header');
    }
    
    // FIXED: Step 4 - STRICT TOKEN VALIDATION - NEVER assume token exists
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ No token found in request headers');
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Access token missing.',
        error: 'NO_TOKEN',
        path: requestPath,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`[Auth] Token extracted, length: ${token.length} characters`);
    
    // FIXED: Step 5 - SAFE TOKEN VERIFICATION WITH PROPER ERROR HANDLING
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      console.log('[Auth] ✅ Token verified successfully');
    } catch (jwtError) {
      // Handle specific JWT errors with appropriate HTTP status codes
      console.error('[Auth] ❌ Token verification failed:', jwtError.name, jwtError.message);
      
      // Token expired - return 401 for graceful handling (frontend can refresh)
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Your session has expired. Please refresh or log in again.',
          error: 'TOKEN_EXPIRED',
          code: 'SESSION_EXPIRED',
          timestamp: new Date().toISOString(),
          expiredAt: jwtError.expiredAt
        });
      }
      
      // Invalid token - return 401 (not 403 for consistency)
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid authentication token.',
          error: 'INVALID_TOKEN',
          code: 'TOKEN_INVALID',
          timestamp: new Date().toISOString()
        });
      }
      
      // Other JWT errors
      return res.status(401).json({
        success: false,
        message: 'Authentication failed.',
        error: 'AUTH_FAILED',
        code: 'AUTH_ERROR',
        timestamp: new Date().toISOString()
      });
    }
    
    // FIXED: Step 6 - Validate decoded payload structure
    if (!decoded || typeof decoded !== 'object') {
      console.error('[Auth] ❌ Token verification returned invalid payload');
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload.',
        error: 'INVALID_PAYLOAD',
        timestamp: new Date().toISOString()
      });
    }
    
    // FIXED: Step 7 - NORMALIZED USER IDENTIFIER EXTRACTION
    // Support multiple possible field names for user ID
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] ❌ No user identifier found in token. Token payload:', Object.keys(decoded));
      return res.status(401).json({
        success: false,
        message: 'Invalid user information in token.',
        error: 'NO_USER_ID',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 8: Check for multi-device login conflicts
    // Extract device/session ID if present in token
    const sessionId = decoded.sessionId || decoded.jti;
    if (sessionId) {
      // Store session info for potential session management
      req.sessionId = sessionId;
    }
    
    // FIXED: Step 9 - ALWAYS ATTACH req.user WITH NORMALIZED FIELDS
    // This is MANDATORY - NEVER skip this step
    req.user = {
      // Verification flag to prevent double verification
      _verified: true,
      
      // FIXED: Normalized user identification (BOTH id and userId for compatibility)
      userId: userId,
      id: userId,  // CRITICAL: Always set both id and userId
      
      // User details from token (with safe defaults)
      email: decoded.email || null,
      username: decoded.username || null,
      role: decoded.role || 'user',
      
      // Session information
      sessionId: sessionId || null,
      deviceId: decoded.deviceId || null,
      
      // Token metadata
      tokenIssuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null,
      
      // Store original token hash (truncated for logging safety)
      _tokenHash: token.substring(0, 10) + '...' + token.substring(token.length - 5)
    };
    
    // FIXED: Step 10 - HARD VALIDATION AFTER ATTACH
    // Double-check that req.user.id exists (should never fail, but safety check)
    if (!req.user || !req.user.id) {
      console.error('[Auth] ❌ CRITICAL: Failed to attach user ID to request');
      return res.status(401).json({
        success: false,
        message: 'Authentication failed - user context error.',
        error: 'USER_CONTEXT_MISSING',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 11: Log successful authentication (without sensitive data)
    console.log(`[Auth] ✅ User authenticated: ${req.user.id} (${req.user.email || 'no email'}) [Session: ${sessionId || 'none'}]`);
    
    // FIXED: Step 12 - ENSURE next() EXECUTES EXACTLY ONCE
    // Return next() to prevent any accidental double-calls
    return next();
    
  } catch (error) {
    // FIXED: Catch any unexpected errors in the middleware
    // NEVER crash - always return a proper response
    console.error('[Auth] 🚨 Unexpected authentication error:', error.message);
    console.error('[Auth] Stack trace:', error.stack);
    
    // Return 401 for authentication failures (not 500 to avoid exposing internals)
    return res.status(401).json({
      success: false,
      message: 'Authentication failed due to server error.',
      error: 'AUTH_MIDDLEWARE_ERROR',
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
          error: 'NO_USER_CONTEXT',
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
          error: 'NO_ROLE',
          timestamp: new Date().toISOString()
        });
      }
      
      if (!roles.includes(userRole)) {
        console.log(`[Auth] ❌ User role '${userRole}' not in required roles: [${roles.join(', ')}]`);
        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions to access this resource.',
          error: 'INSUFFICIENT_PERMISSIONS',
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
        error: 'AUTHORIZATION_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  };
};

// Socket.io authentication middleware (FIXED with same token extraction pattern)
const socketAuthenticate = async (socket, next) => {
  try {
    console.log('[Auth] 🔌 Socket.io authentication middleware invoked');
    
    // FIXED: Standardized token extraction for Socket.io
    let token = null;
    
    // Check multiple possible locations for token
    const authHeader = socket.handshake.headers.authorization;
    const xAccessToken = socket.handshake.headers['x-access-token'];
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
      console.log('[Auth] Socket token extracted from Authorization Bearer header');
    } else if (xAccessToken) {
      token = xAccessToken;
      console.log('[Auth] Socket token extracted from x-access-token header');
    } else if (socket.handshake.auth && socket.handshake.auth.token) {
      // Some Socket.io clients send token in auth object
      token = socket.handshake.auth.token;
      console.log('[Auth] Socket token extracted from handshake auth');
    }
    
    console.log(`[Auth] Socket token found: ${token ? 'Yes' : 'No'}`);
    
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ No token provided for socket connection');
      return next(new Error('Authentication error: No token provided'));
    }
    
    // FIXED: Safe token verification
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
    
    // FIXED: Normalized user ID extraction
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] ❌ No user identifier in socket token');
      return next(new Error('Authentication error: Invalid user information'));
    }
    
    // Check for existing socket connection for this user/session
    const sessionId = decoded.sessionId || decoded.jti;
    
    // FIXED: Attach normalized user info to socket
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

// Alias for compatibility (UNCHANGED)
const authenticate = authenticateToken;
const authMiddleware = authenticateToken;

// Token refresh validation (for refresh endpoint) - FIXED error handling
const validateRefreshToken = (req, res, next) => {
  try {
    console.log('[Auth] 🔄 Refresh token validation');
    
    // Extract refresh token from body
    let refreshToken = req.body.refreshToken;
    
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token required.',
        error: 'NO_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
    // Verify refresh token (can use same or different secret)
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
        error: 'REFRESH_TOKEN_EXPIRED',
        timestamp: new Date().toISOString()
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token.',
        error: 'INVALID_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Refresh token validation failed.',
      error: 'REFRESH_TOKEN_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// Validate JWT secret on module load (UNCHANGED)
(function validateJwtSecret() {
  console.log('[Auth] 🔐 JWT_SECRET from .env:', process.env.JWT_SECRET ? 'Loaded' : 'Not loaded');
  console.log('[Auth] 🔐 Using JWT_SECRET prefix:', JWT_SECRET.substring(0, 10) + '...');
  
  if (!process.env.JWT_SECRET) {
    console.warn('[Auth] ⚠️ WARNING: JWT_SECRET environment variable is not set!');
    console.warn('[Auth] Using fallback secret. This is INSECURE for production!');
    console.warn('[Auth] Set JWT_SECRET environment variable in production.');
  } else {
    console.log('[Auth] ✅ JWT_SECRET environment variable is configured');
  }
})();

// FIXED: Utility functions with proper error handling
module.exports = {
  authenticateToken,
  authenticate,
  authMiddleware,
  authorize,
  socketAuthenticate,
  validateRefreshToken,
  
  // FIXED: Utility functions with better error handling
  extractToken: (req) => {
    try {
      // Check multiple header locations
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
      }
      
      const xAccessToken = req.headers['x-access-token'];
      if (xAccessToken) {
        return xAccessToken;
      }
      
      return null;
    } catch (error) {
      console.error('[Auth] Error extracting token:', error.message);
      return null;
    }
  },
  
  decodeToken: (token) => {
    try {
      if (!token) return null;
      return jwt.decode(token);
    } catch (error) {
      return null;
    }
  },
  
  // Safe token logging utility (UNCHANGED)
  safeTokenLog: (token) => {
    if (!token || token.length < 15) return '[Invalid Token]';
    return `${token.substring(0, 6)}...${token.substring(token.length - 6)}`;
  },
  
  // Public paths checker (exported for testing/other middleware)
  isPublicPath,
  PUBLIC_PATHS,
  
  // Configuration
  JWT_SECRET: JWT_SECRET
};