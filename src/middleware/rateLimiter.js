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
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
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

// ADDED: Alias for apiRateLimiter (commonly used in routes)
const apiRateLimiter = apiLimiter;

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

// P2 FIX (Forensic Audit): GDPR data export — limit to 1 export per 24h per user
const dataExportLimiter = rateLimit({
  store: redisStore,
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 1,
  message: {
    success: false,
    message: 'You can request a data export once every 24 hours. Please try again later.',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `export:${(req.user && (req.user.userId || req.user.id)) || req.ip}`
});

// P3 FIX (Forensic Audit): "Add rate limit on search/discovery endpoints —
// prevent user enumeration via /friends/search and /users/search."
// Stricter than the general apiLimiter (100/min) since search endpoints are
// the primary vector for enumerating valid usernames/emails.
const searchLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 searches per minute per IP
  message: {
    success: false,
    message: 'Too many search requests. Please slow down and try again shortly.',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `search:${(req.user && (req.user.userId || req.user.id)) || req.ip}`
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
  max: 60, // Limit each user to 60 messages per minute
  message: {
    success: false,
    message: 'Too many messages, please slow down',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  // FIX-AUDIT: Key by authenticated user ID, not IP. The old `${req.ip}:chat`
  // key meant every user behind a shared IP (office NAT, mobile carrier-grade
  // NAT, VPN) shared one bucket — one heavy sender could rate-limit everyone
  // else on that IP. Falls back to IP only for unauthenticated requests.
  keyGenerator: (req) => {
    const uid = req.user && (req.user.id || req.user.userId);
    return uid ? `chat-user:${uid}` : `chat-ip:${req.ip}`;
  }
});

// Rate limiter for call initiation — per CALLER:CALLEE pair (anti-harassment)
// Max 5 call attempts to the same target per 60 seconds
const callInitiationLimiter = rateLimit({
  store: redisStore,
  windowMs: 60 * 1000, // 1 minute
  max: 5, // max 5 call attempts to same target per minute
  message: {
    success: false,
    message: 'Too many call attempts to this user. Please wait before trying again.',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  keyGenerator: (req) => {
    const callerId = req.user && req.user.id ? req.user.id : req.ip;
    const calleeId = req.body && (req.body.calleeId || req.body.userId ||
      (Array.isArray(req.body.participantIds) && req.body.participantIds.length === 1
        ? req.body.participantIds[0] : 'group'));
    return `call-target:${callerId}:${calleeId}`;
  },
  handler: (req, res, next, options) => {
    res.status(429).json(options.message);
  }
});

// Dynamic rate limiter based on user role
const dynamicLimiter = (options = {}) => {
  return rateLimit({
    store: redisStore,
    windowMs: options.windowMs || 60 * 1000,
    max: (req) => {
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

// Standardized named exports
module.exports = {
  authLimiter,
  apiLimiter,
  apiRateLimiter, // Added alias for backward compatibility
  registerLimiter,
  passwordResetLimiter,
  dataExportLimiter,
  searchLimiter,
  uploadLimiter,
  chatLimiter,
  callInitiationLimiter,
  dynamicLimiter
};