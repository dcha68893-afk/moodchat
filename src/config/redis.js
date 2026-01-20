// config/redis.js - FIXED
const config = require('./index');

module.exports = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
  enableReadyCheck: true,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3,
  
  retryStrategy: function(times) {
    if (times > 10) {
      console.warn(`[Redis] Too many retry attempts (${times}), giving up`);
      return null; // Stop retrying
    }
    const delay = Math.min(times * 100, 3000);
    console.log(`[Redis] Retry attempt ${times}, delay: ${delay}ms`);
    return delay;
  },
  
  // Only connect if Redis is enabled
  connectOnStartup: config.redis.enabled,
  
  // Connection error handling
  onError: function(err) {
    console.error('[Redis] Connection error:', err.message);
  },
  
  onReady: function() {
    console.log('[Redis] Connection ready');
  },
  
  onEnd: function() {
    console.log('[Redis] Connection ended');
  },
  
  onReconnecting: function() {
    console.log('[Redis] Reconnecting...');
  },
};