const jwt = require('jsonwebtoken');

// FIXED: Use JWT_SECRET consistently with your .env value
const JWT_SECRET = process.env.JWT_SECRET || '3e78ab2d6cb698f95b3b8d510614058c';

// Unified authentication middleware for all protected backend routes
const authenticateToken = (req, res, next) => {
  try {
    console.log(`[Auth] 🔐 Unified middleware invoked for: ${req.method} ${req.path}`);
    
    // Step 1: Extract token ONLY from Authorization header
    const authHeader = req.headers['authorization'];
    
    // Step 2: Validate Authorization header format
    if (!authHeader) {
      console.log('[Auth] ❌ Missing Authorization header');
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Authorization header is missing.',
        error: 'NO_AUTHORIZATION_HEADER',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 3: Validate Bearer token format
    if (!authHeader.startsWith('Bearer ')) {
      console.log('[Auth] ❌ Invalid Authorization header format');
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format. Use: Bearer <token>',
        error: 'INVALID_AUTHORIZATION_FORMAT',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 4: Extract token (without logging full token)
    const token = authHeader.split(' ')[1];
    
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ Empty token in Authorization header');
      return res.status(401).json({
        success: false,
        message: 'Authentication token is empty.',
        error: 'EMPTY_TOKEN',
        path: req.path,
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
      // Handle specific JWT errors with HTTP 403
      console.error('[Auth] ❌ Token verification failed:', jwtError.name);
      
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(403).json({
          success: false,
          message: 'Your session has expired. Please log in again.',
          error: 'TOKEN_EXPIRED',
          code: 'SESSION_EXPIRED',
          timestamp: new Date().toISOString()
        });
      }
      
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(403).json({
          success: false,
          message: 'Invalid authentication token.',
          error: 'INVALID_TOKEN',
          code: 'TOKEN_INVALID',
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(403).json({
        success: false,
        message: 'Authentication failed.',
        error: 'AUTH_FAILED',
        code: 'AUTH_ERROR',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 6: Validate decoded payload structure
    if (!decoded) {
      console.error('[Auth] ❌ Token verification returned empty payload');
      return res.status(403).json({
        success: false,
        message: 'Invalid token payload.',
        error: 'INVALID_PAYLOAD',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 7: Ensure we have a user identifier (same logic as /api/auth/me)
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      console.error('[Auth] ❌ No user identifier found in token');
      return res.status(403).json({
        success: false,
        message: 'Invalid user information in token.',
        error: 'NO_USER_ID',
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 8: Attach user info to request (identical to /api/auth/me structure)
    req.user = {
      // Core user identification - EXACTLY as /api/auth/me expects
      userId: userId,
      id: userId,
      
      // User details from token
      email: decoded.email || null,
      username: decoded.username || null,
      role: decoded.role || 'user',
      
      // Token metadata
      tokenIssuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null,
      
      // Store token for potential use in downstream middleware
      _token: token
    };
    
    // Step 9: Log successful authentication
    console.log(`[Auth] ✅ User authenticated: ${req.user.id} (${req.user.email || 'no email'})`);
    
    // Step 10: Continue to next middleware/route
    next();
    
  } catch (error) {
    // Catch any unexpected errors in the middleware
    console.error('[Auth] 🚨 Unexpected authentication error:', error.message);
    
    // Return 403 for consistency with token verification failures
    return res.status(403).json({
      success: false,
      message: 'Internal authentication error.',
      error: 'INTERNAL_AUTH_ERROR',
      code: 'SERVER_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// Role-based authorization middleware (unchanged)
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

// Socket.io authentication middleware (unchanged)
const socketAuthenticate = async (socket, next) => {
  try {
    console.log('[Auth] 🔌 Socket.io authentication middleware invoked');
    
    // Extract token from multiple socket sources
    let token = socket.handshake.auth.token;
    
    if (!token && socket.handshake.headers.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }
    
    if (!token && socket.handshake.query.token) {
      token = socket.handshake.query.token;
    }
    
    console.log(`[Auth] Socket token found: ${token ? 'Yes' : 'No'}`);
    
    if (!token || token.trim() === '') {
      console.log('[Auth] ❌ No token provided for socket connection');
      return next(new Error('Authentication error: No token provided'));
    }
    
    // Verify JWT token - FIXED: Using JWT_SECRET consistently
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
    
    // Attach user info to socket
    socket.userId = userId;
    socket.user = {
      id: userId,
      userId: userId,
      email: decoded.email || null,
      username: decoded.username || null,
      role: decoded.role || 'user',
      permissions: decoded.permissions || [],
      tokenIssuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null
    };
    socket.token = token;
    
    console.log(`[Auth] ✅ Socket authenticated for user: ${userId}`);
    next();
    
  } catch (error) {
    console.error('[Auth] 🚨 Unexpected socket authentication error:', error);
    next(new Error('Authentication error'));
  }
};

// Alias for compatibility
const authenticate = authenticateToken;
const authMiddleware = authenticateToken;

// Validate JWT secret on module load (unchanged)
(function validateJwtSecret() {
  console.log('[Auth] 🔐 JWT_SECRET from .env:', process.env.JWT_SECRET ? 'Loaded' : 'Not loaded');
  console.log('[Auth] 🔐 Using JWT_SECRET:', JWT_SECRET.substring(0, 10) + '...');
  
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
  
  // Utility functions (unchanged)
  extractToken: (req) => {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
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
  
  // Configuration
  JWT_SECRET: JWT_SECRET
};