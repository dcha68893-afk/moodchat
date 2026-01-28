const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

const authenticate = async (req, res, next) => {
  try {
    // Extract token from Authorization header ONLY
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }
    
    // Validate format: must start with "Bearer "
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token format. Use: Bearer <token>'
      });
    }
    
    // Extract token safely
    const token = authHeader.split(' ')[1];
    
    if (!token || token.trim() === '') {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    // Verify JWT token
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Attach decoded payload to request
      req.user = decoded;
      req.token = token;
      
      // Continue to next middleware/route
      next();
    } catch (jwtError) {
      // Handle different JWT errors
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired'
        });
      }
      
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid token'
        });
      }
      
      // For any other JWT error
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    
  } catch (error) {
    // Return generic authentication error
    return res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // If roles are specified, check user role
    if (roles.length > 0 && req.user.role && !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    next();
  };
};

// Socket.io authentication middleware
const socketAuthenticate = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }
    
    // Verify JWT token
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Attach user ID to socket for reference
      socket.userId = decoded.userId || decoded.id || decoded.sub;
      socket.user = decoded;
      socket.token = token;
      
      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return next(new Error('Authentication error: Token expired'));
      }
      
      if (jwtError.name === 'JsonWebTokenError') {
        return next(new Error('Authentication error: Invalid token'));
      }
      
      return next(new Error('Authentication error: Invalid token'));
    }
  } catch (error) {
    next(new Error('Authentication error'));
  }
};

// Alias for compatibility with existing code
const authMiddleware = authenticate;

module.exports = {
  authenticate,
  authMiddleware,
  authorize,
  socketAuthenticate
};