const jwt = require('jsonwebtoken');
const { Token } = require('../models');

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header required',
        timestamp: new Date().toISOString()
      });
    }
    
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.split(' ')[1] 
      : authHeader;
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token required',
        timestamp: new Date().toISOString()
      });
    }

    // Check if token is blacklisted/revoked in database
    if (req.app.locals.dbConnected && req.app.locals.models && req.app.locals.models.Token) {
      try {
        const tokenRecord = await req.app.locals.models.Token.findOne({
          where: {
            token: token,
            isRevoked: false,
            expiresAt: { [req.app.locals.sequelize.Sequelize.Op.gt]: new Date() }
          }
        });

        if (!tokenRecord) {
          return res.status(401).json({
            success: false,
            message: 'Token has been revoked or is expired',
            timestamp: new Date().toISOString()
          });
        }
      } catch (dbError) {
        console.error('Token validation error:', dbError);
        // Continue with JWT verification if DB check fails
      }
    }
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(403).json({
            success: false,
            message: 'Token expired',
            timestamp: new Date().toISOString()
          });
        }
        
        if (err.name === 'JsonWebTokenError') {
          return res.status(403).json({
            success: false,
            message: 'Invalid token',
            timestamp: new Date().toISOString()
          });
        }
        
        return res.status(403).json({
          success: false,
          message: 'Token verification failed',
          timestamp: new Date().toISOString()
        });
      }
      
      req.user = decoded;
      req.token = token;
      next();
    });
    
  } catch (error) {
    console.error('Authentication middleware error:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Authentication error',
      timestamp: new Date().toISOString()
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        timestamp: new Date().toISOString()
      });
    }
    
    // If roles are specified, check user role
    if (roles.length > 0 && req.user.role && !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        timestamp: new Date().toISOString()
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
    
    // Check token in database if available
    if (socket.request.app.locals.dbConnected && socket.request.app.locals.models && socket.request.app.locals.models.Token) {
      try {
        const tokenRecord = await socket.request.app.locals.models.Token.findOne({
          where: {
            token: token,
            isRevoked: false,
            expiresAt: { [socket.request.app.locals.sequelize.Sequelize.Op.gt]: new Date() }
          }
        });

        if (!tokenRecord) {
          return next(new Error('Authentication error: Token invalidated'));
        }
      } catch (dbError) {
        console.error('Socket token validation error:', dbError);
      }
    }
    
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Authentication error: Token expired'));
      }
      return next(new Error('Authentication error: Invalid token'));
    }
    
    // Get user from database or in-memory
    let user = null;
    if (socket.request.app.locals.dbConnected && socket.request.app.locals.models && socket.request.app.locals.models.User) {
      try {
        user = await socket.request.app.locals.models.User.findByPk(decoded.userId, {
          attributes: { exclude: ['password'] }
        });
      } catch (dbError) {
        console.error('Socket user lookup error:', dbError);
      }
    }
    
    // If database not available, check in-memory
    if (!user && socket.request.app.locals.users) {
      user = socket.request.app.locals.users.find(u => u.id === decoded.userId);
      if (user) {
        delete user.password;
      }
    }
    
    if (!user || (user.isActive === false)) {
      return next(new Error('Authentication error: User not found or inactive'));
    }
    
    socket.user = user;
    socket.userId = user.id;
    socket.token = token;
    next();
  } catch (error) {
    console.error('Socket authentication error:', error);
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