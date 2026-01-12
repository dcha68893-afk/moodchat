const rateLimit = require('express-rate-limit');

// Create rate limiters - NO REDIS INVOLVED
const createLimiter = (options) => rateLimit({
  ...options,
  standardHeaders: true,
  legacyHeaders: false,
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

// Export all limiters
module.exports = {
  defaultLimiter,
  authLimiter,
};