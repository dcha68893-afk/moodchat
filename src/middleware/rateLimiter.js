const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const redisClient = require('../utils/redisClient');
const config = require('../config');

// Default rate limiter
const defaultLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rate-limit:',
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});

// Auth rate limiter (stricter for authentication endpoints)
const authLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rate-limit-auth:',
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    // Skip rate limiting for certain paths
    return !req.path.includes('/auth/');
  },
});

// Message sending rate limiter
const messageLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rate-limit-message:',
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Limit to 30 messages per minute
  message: {
    success: false,
    message: 'Too many messages sent, please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    // Rate limit by user ID if authenticated, otherwise by IP
    return req.user ? `user:${req.user.id}` : req.ip;
  },
});

// API key rate limiter
const apiKeyLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rate-limit-api:',
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit to 60 requests per minute per API key
  message: {
    success: false,
    message: 'API rate limit exceeded.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    return req.headers['x-api-key'] || req.ip;
  },
});

// WebSocket connection rate limiter
const wsConnectionLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rate-limit-ws:',
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit to 10 connection attempts per minute
  message: {
    success: false,
    message: 'Too many connection attempts.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.ip,
});

module.exports = {
  defaultLimiter,
  authLimiter,
  messageLimiter,
  apiKeyLimiter,
  wsConnectionLimiter,
};
