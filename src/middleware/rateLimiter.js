const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const redis = require('redis');

// Create Redis client if REDIS_URL is set
let redisClient;
let redisStore;

if (process.env.REDIS_URL) {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL
    });
    
    redisClient.connect().catch(console.error);
    
    redisStore = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: 'rate-limit:'
    });
    
    console.log('✅ Redis connected for rate limiting');
  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
    redisClient = null;
  }
}

// Rate limiter for authentication routes (login, register)
const authLimiter = rateLimit({
  store: redisStore,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    success: false,
    message: 'Too many login attempts, please try again after 15 minutes',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
  keyGenerator: (req) => {
    // Use IP + endpoint for more granular rate limiting
    return `${req.ip}:${req.path}`;
  },
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json(options.message);
  }
});

// Rate limiter for general API routes
const apiLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute
  message: {
    success: false,
    message: 'Too many requests, please try again after a minute',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  keyGenerator: (req) => {
    return req.ip;
  }
});

// Rate limiter for registration (more strict)
const registerLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 registration attempts per hour
  message: {
    success: false,
    message: 'Too many registration attempts, please try again after an hour',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return `${req.ip}:register`;
  }
});

// Rate limiter for password reset
const passwordResetLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Limit each IP to 3 password reset attempts per hour
  message: {
    success: false,
    message: 'Too many password reset attempts, please try again after an hour',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return `${req.ip}:password-reset`;
  }
});

// Rate limiter for file uploads
const uploadLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 uploads per hour
  message: {
    success: false,
    message: 'Too many file uploads, please try again after an hour',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return `${req.ip}:upload`;
  }
});

// Rate limiter for chat messages
const chatLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 messages per minute
  message: {
    success: false,
    message: 'Too many messages, please slow down',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return `${req.ip}:chat`;
  }
});

// Dynamic rate limiter based on user role
const dynamicLimiter = (options = {}) => {
  return rateLimit({
    store: redisStore,
    windowMs: options.windowMs || 60 * 1000,
    max: (req) => {
      // Different limits based on user role
      if (req.user && req.user.role === 'admin') {
        return options.adminMax || 1000;
      } else if (req.user && req.user.role === 'moderator') {
        return options.moderatorMax || 500;
      } else if (req.user) {
        return options.userMax || 100;
      } else {
        return options.guestMax || 50;
      }
    },
    message: {
      success: false,
      message: options.message || 'Too many requests, please try again later',
      timestamp: new Date().toISOString()
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: false,
    keyGenerator: (req) => {
      return `${req.ip}:${options.key || 'dynamic'}`;
    }
  });
};

// Test endpoint to check rate limiting (development only)
if (process.env.NODE_ENV === 'development') {
  const testLimiter = rateLimit({
    windowMs: 10 * 1000, // 10 seconds
    max: 3, // 3 requests per 10 seconds
    message: {
      success: false,
      message: 'Test rate limit triggered',
      timestamp: new Date().toISOString()
    }
  });
}

// Clean up Redis connection on shutdown
if (redisClient) {
  process.on('SIGTERM', () => {
    redisClient.quit().catch(console.error);
  });
  
  process.on('SIGINT', () => {
    redisClient.quit().catch(console.error);
  });
}

module.exports = {
  authLimiter,
  apiLimiter,
  registerLimiter,
  passwordResetLimiter,
  uploadLimiter,
  chatLimiter,
  dynamicLimiter
};