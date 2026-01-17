const rateLimit = require('express-rate-limit');

// Create rate limiters - NO REDIS INVOLVED
const createLimiter = (options) => rateLimit({
  ...options,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: options.message || 'Too many requests, please try again later.'
    });
  }
});

// Default rate limiter
const defaultLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests
  message: 'Too many requests, please try again later.',
});

// Auth rate limiter (stricter)
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 login attempts
  message: 'Too many login attempts, please try again later.',
});

// Message-specific rate limiter
const createMessageRateLimiter = () => createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 messages per minute
  message: 'Too many messages, please slow down.',
});

// API rate limiter (alias for defaultLimiter - used by calls.js)
const apiRateLimiter = defaultLimiter;

// Export all limiters
module.exports = {
  apiRateLimiter,
  defaultLimiter,
  authLimiter,
  createMessageRateLimiter,
};