const config = require('./index');

module.exports = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,

  retryStrategy: times => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },

  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
};
