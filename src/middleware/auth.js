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

// Unified authentication middleware for all protected backend routes
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
    
    // Step 3: Extract token from Authorization header (Bearer format only)
    let token = null;
    const authHeader = req.headers['authorization'];
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7); // Remove 'Bearer ' prefix
      console.log('[Auth] Token extracted from Authorization header');
    }
    
    // Step 4: Validate token presence
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ No Bearer token found in Authorization header');
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Bearer token missing.',
        error: 'NO_TOKEN',
        path: requestPath,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`[Auth] Token extracted, length: ${token.length} characters`);
    
    // Step 5: Verify JWT token using JWT_SECRET
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      console.log('[Auth] ✅ Token verified successfully');
    } catch (jwtError) {
      // Handle specific JWT errors with appropriate HTTP status codes
      console.error('[Auth] ❌ Token verification failed:', jwtError.name);
      
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
      
      // Invalid token - return 403
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(403).json({
          success: false,
          message: 'Invalid authentication token.',
          error: 'INVALID_TOKEN',
          code: 'TOKEN_INVALID',
          timestamp: new Date().toISOString()
        });
      }
      
      // Other JWT errors
      return res.status(403).json({
        success: false,
        message: 'Authentication failed.',
        error: 'AUTH_FAILED',
        code: 'AUTH_ERROR',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 6: Validate decoded payload structure - CRITICAL FIX
    if (!decoded) {
      console.error('[Auth] ❌ Token verification returned empty payload');
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload.',
        error: 'INVALID_PAYLOAD',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 7: Extract user identifier with consistent logic
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] ❌ No user identifier found in token');
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
    
    // Step 9: Attach user info to request with verification flag - CRITICAL FIX
    req.user = {
      // Verification flag to prevent double verification
      _verified: true,
      
      // Core user identification
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
      
      // Store original token (truncated for logging safety)
      _tokenHash: token.substring(0, 10) + '...' + token.substring(token.length - 5)
    };
    
    // Step 10: Log successful authentication (without sensitive data)
    console.log(`[Auth] ✅ User authenticated: ${req.user.id} (${req.user.email || 'no email'}) [Session: ${sessionId || 'none'}]`);
    
    // Step 11: Continue to next middleware/route
    next();
    
  } catch (error) {
    // Catch any unexpected errors in the middleware
    console.error('[Auth] 🚨 Unexpected authentication error:', error.message);
    
    // Return 500 for unexpected server errors
    return res.status(500).json({
      success: false,
      message: 'Internal authentication error.',
      error: 'INTERNAL_AUTH_ERROR',
      code: 'SERVER_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// Role-based authorization middleware
const authorize = (...roles) => {
  return (req, res, next) => {
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
    next();
  };
};

// Socket.io authentication middleware
const socketAuthenticate = async (socket, next) => {
  try {
    console.log('[Auth] 🔌 Socket.io authentication middleware invoked');
    
    // Extract token from Authorization header
    let token = null;
    const authHeader = socket.handshake.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    
    console.log(`[Auth] Socket token found: ${token ? 'Yes' : 'No'}`);
    
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ No token provided for socket connection');
      return next(new Error('Authentication error: No token provided'));
    }
    
    // Verify JWT token
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
    
    // Extract user ID
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] ❌ No user identifier in socket token');
      return next(new Error('Authentication error: Invalid user information'));
    }
    
    // Check for existing socket connection for this user/session
    const sessionId = decoded.sessionId || decoded.jti;
    
    // Attach user info to socket
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
    
    console.log(`[Auth] ✅ Socket authenticated for user: ${userId} [Session: ${sessionId || 'none'}]`);
    next();
    
  } catch (error) {
    console.error('[Auth] 🚨 Unexpected socket authentication error:', error);
    next(new Error('Authentication error'));
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
        error: 'NO_REFRESH_TOKEN',
        timestamp: new Date().toISOString()
      });
    }
    
    // Verify refresh token (can use same or different secret)
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    
    // Store in request for later use
    req.refreshToken = refreshToken;
    req.refreshTokenPayload = decoded;
    
    next();
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
    
    return res.status(403).json({
      success: false,
      message: 'Invalid refresh token.',
      error: 'INVALID_REFRESH_TOKEN',
      timestamp: new Date().toISOString()
    });
  }
};

// Validate JWT secret on module load
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

module.exports = {
  authenticateToken,
  authenticate,
  authMiddleware,
  authorize,
  socketAuthenticate,
  validateRefreshToken,
  
  // Utility functions
  extractToken: (req) => {
    // Check Authorization header only
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    
    return null;
  },
  
  decodeToken: (token) => {
    try {
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
  
  // Public paths checker (exported for testing/other middleware)
  isPublicPath,
  PUBLIC_PATHS,
  
  // Configuration
  JWT_SECRET: JWT_SECRET
};