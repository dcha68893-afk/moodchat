const redis = require('redis');
const config = require('../config');
const logger = require('./logger');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connect();
  }

  /**
   * Connect to Redis
   */
  async connect() {
    try {
      const redisConfig = config.redis;

      this.client = redis.createClient({
        socket: {
          host: redisConfig.host,
          port: redisConfig.port,
          reconnectStrategy: retries => {
            const delay = Math.min(retries * 50, 2000);
            logger.warn(`Redis reconnecting attempt ${retries}, delay: ${delay}ms`);
            return delay;
          },
        },
        password: redisConfig.password,
        database: redisConfig.db,
      });

      // Error handling
      this.client.on('error', err => {
        logger.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis Client Connected');
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        logger.info('Redis Client Ready');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis Client Reconnecting');
        this.isConnected = false;
      });

      this.client.on('end', () => {
        logger.info('Redis Client Disconnected');
        this.isConnected = false;
      });

      await this.client.connect();

      // Test connection
      await this.client.ping();
      logger.info('Redis connection test successful');
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      this.isConnected = false;

      // Retry connection after delay
      setTimeout(() => this.connect(), 5000);
    }
  }

  /**
   * Get value by key
   */
  async get(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.get(key);
      return value;
    } catch (error) {
      logger.error('Redis GET error:', error);
      return null;
    }
  }

  /**
   * Set value with expiration
   */
  async set(key, value, expireSeconds = null) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      if (expireSeconds) {
        await this.client.setEx(key, expireSeconds, value);
      } else {
        await this.client.set(key, value);
      }

      return true;
    } catch (error) {
      logger.error('Redis SET error:', error);
      return false;
    }
  }

  /**
   * Delete key
   */
  async del(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error('Redis DEL error:', error);
      return false;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Redis EXISTS error:', error);
      return false;
    }
  }

  /**
   * Set key with expiration in milliseconds
   */
  async setEx(key, milliseconds, value) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      await this.client.set(key, value, { PX: milliseconds });
      return true;
    } catch (error) {
      logger.error('Redis SETEX error:', error);
      return false;
    }
  }

  /**
   * Get time to live for key
   */
  async ttl(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const ttl = await this.client.ttl(key);
      return ttl;
    } catch (error) {
      logger.error('Redis TTL error:', error);
      return -2; // Key doesn't exist
    }
  }

  /**
   * Increment value
   */
  async incr(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.incr(key);
      return value;
    } catch (error) {
      logger.error('Redis INCR error:', error);
      return null;
    }
  }

  /**
   * Decrement value
   */
  async decr(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.decr(key);
      return value;
    } catch (error) {
      logger.error('Redis DECR error:', error);
      return null;
    }
  }

  /**
   * Add member to set
   */
  async sadd(key, member) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.sAdd(key, member);
      return result;
    } catch (error) {
      logger.error('Redis SADD error:', error);
      return 0;
    }
  }

  /**
   * Remove member from set
   */
  async srem(key, member) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.sRem(key, member);
      return result;
    } catch (error) {
      logger.error('Redis SREM error:', error);
      return 0;
    }
  }

  /**
   * Check if member exists in set
   */
  async sismember(key, member) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.sIsMember(key, member);
      return result;
    } catch (error) {
      logger.error('Redis SISMEMBER error:', error);
      return false;
    }
  }

  /**
   * Get all members of set
   */
  async smembers(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const members = await this.client.sMembers(key);
      return members;
    } catch (error) {
      logger.error('Redis SMEMBERS error:', error);
      return [];
    }
  }

  /**
   * Add to hash
   */
  async hset(key, field, value) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      await this.client.hSet(key, field, value);
      return true;
    } catch (error) {
      logger.error('Redis HSET error:', error);
      return false;
    }
  }

  /**
   * Get from hash
   */
  async hget(key, field) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.hGet(key, field);
      return value;
    } catch (error) {
      logger.error('Redis HGET error:', error);
      return null;
    }
  }

  /**
   * Get all fields and values from hash
   */
  async hgetall(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const hash = await this.client.hGetAll(key);
      return hash;
    } catch (error) {
      logger.error('Redis HGETALL error:', error);
      return {};
    }
  }

  /**
   * Delete field from hash
   */
  async hdel(key, field) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      await this.client.hDel(key, field);
      return true;
    } catch (error) {
      logger.error('Redis HDEL error:', error);
      return false;
    }
  }

  /**
   * Push to list
   */
  async rpush(key, value) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const length = await this.client.rPush(key, value);
      return length;
    } catch (error) {
      logger.error('Redis RPUSH error:', error);
      return 0;
    }
  }

  /**
   * Pop from list
   */
  async lpop(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.lPop(key);
      return value;
    } catch (error) {
      logger.error('Redis LPOP error:', error);
      return null;
    }
  }

  /**
   * Get range from list
   */
  async lrange(key, start, stop) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const values = await this.client.lRange(key, start, stop);
      return values;
    } catch (error) {
      logger.error('Redis LRANGE error:', error);
      return [];
    }
  }

  /**
   * Publish to channel
   */
  async publish(channel, message) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      await this.client.publish(channel, JSON.stringify(message));
      return true;
    } catch (error) {
      logger.error('Redis PUBLISH error:', error);
      return false;
    }
  }

  /**
   * Get keys by pattern
   */
  async keys(pattern) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const keys = await this.client.keys(pattern);
      return keys;
    } catch (error) {
      logger.error('Redis KEYS error:', error);
      return [];
    }
  }

  /**
   * Flush database
   */
  async flushdb() {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      await this.client.flushDb();
      logger.info('Redis database flushed');
      return true;
    } catch (error) {
      logger.error('Redis FLUSHDB error:', error);
      return false;
    }
  }

  /**
   * Get Redis info
   */
  async info() {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const info = await this.client.info();
      return info;
    } catch (error) {
      logger.error('Redis INFO error:', error);
      return null;
    }
  }

  /**
   * Close Redis connection
   */
  async quit() {
    try {
      if (this.client && this.isConnected) {
        await this.client.quit();
        logger.info('Redis connection closed');
      }
      this.isConnected = false;
      return true;
    } catch (error) {
      logger.error('Redis QUIT error:', error);
      return false;
    }
  }

  /**
   * Ping Redis server
   */
  async ping() {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis PING error:', error);
      return false;
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      host: config.redis.host,
      port: config.redis.port,
    };
  }
}

// Create singleton instance
const redisClient = new RedisClient();

module.exports = redisClient;
