const redis = require('redis');
const config = require('../config');
const logger = require('./logger');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 10;
    
    // Initialize connection
    this.initialize();
  }

  /**
   * Initialize Redis connection
   */
  async initialize() {
    try {
      const redisConfig = config.redis || {};

      // Create Redis client configuration
      const clientConfig = {
        socket: {
          host: redisConfig.host || 'localhost',
          port: redisConfig.port || 6379,
          reconnectStrategy: (retries) => {
            this.connectionAttempts = retries;
            const delay = Math.min(retries * 100, 3000);
            logger.warn(`Redis reconnecting attempt ${retries}, delay: ${delay}ms`);
            return delay;
          },
        },
        // Only add password if it exists and is not empty
        ...(redisConfig.password && redisConfig.password.trim() !== '' 
          ? { password: redisConfig.password } 
          : {}),
        // Only add database if specified
        ...(redisConfig.db !== undefined ? { database: redisConfig.db } : {}),
      };

      logger.info('Creating Redis client with config:', {
        host: clientConfig.socket.host,
        port: clientConfig.socket.port,
        hasPassword: !!clientConfig.password,
        database: clientConfig.database || 0
      });

      // Create Redis client
      this.client = redis.createClient(clientConfig);

      // Set up event handlers
      this.setupEventHandlers();

      // Connect to Redis
      await this.client.connect();
      
      // Test connection with ping
      await this.testConnection();

    } catch (error) {
      logger.error('Failed to initialize Redis client:', error);
      
      // Retry connection after delay
      if (this.connectionAttempts < this.maxRetries) {
        const delay = Math.min(this.connectionAttempts * 1000, 5000);
        logger.info(`Retrying Redis connection in ${delay}ms...`);
        setTimeout(() => this.initialize(), delay);
      } else {
        logger.error('Max Redis connection retries reached. Redis will not be available.');
      }
    }
  }

  /**
   * Set up Redis event handlers
   */
  setupEventHandlers() {
    if (!this.client) return;

    // Error handling
    this.client.on('error', (err) => {
      logger.error('Redis Client Error:', { 
        error: err.message, 
        code: err.code,
        attempts: this.connectionAttempts 
      });
      this.isConnected = false;
    });

    // Connection events
    this.client.on('connect', () => {
      logger.info('Redis Client Connected');
      this.connectionAttempts = 0;
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
  }

  /**
   * Test Redis connection
   */
  async testConnection() {
    try {
      if (!this.client) {
        throw new Error('Redis client not initialized');
      }

      const pingResult = await this.client.ping();
      logger.info('Redis connection test successful:', pingResult);
      this.isConnected = true;
      return true;
    } catch (error) {
      logger.error('Redis connection test failed:', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Get value by key
   */
  async get(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.get(key);
      return value;
    } catch (error) {
      logger.error('Redis GET error:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Set value with expiration
   */
  async set(key, value, expireSeconds = null) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      if (expireSeconds) {
        await this.client.setEx(key, expireSeconds, value);
      } else {
        await this.client.set(key, value);
      }

      return true;
    } catch (error) {
      logger.error('Redis SET error:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Delete key
   */
  async del(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      logger.error('Redis DEL error:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Redis EXISTS error:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Set key with expiration in milliseconds
   */
  async setEx(key, milliseconds, value) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      await this.client.set(key, value, { PX: milliseconds });
      return true;
    } catch (error) {
      logger.error('Redis SETEX error:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Get time to live for key
   */
  async ttl(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const ttl = await this.client.ttl(key);
      return ttl;
    } catch (error) {
      logger.error('Redis TTL error:', { key, error: error.message });
      return -2; // Key doesn't exist
    }
  }

  /**
   * Increment value
   */
  async incr(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.incr(key);
      return value;
    } catch (error) {
      logger.error('Redis INCR error:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Decrement value
   */
  async decr(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.decr(key);
      return value;
    } catch (error) {
      logger.error('Redis DECR error:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Add to hash
   */
  async hset(key, field, value) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      await this.client.hSet(key, field, value);
      return true;
    } catch (error) {
      logger.error('Redis HSET error:', { key, field, error: error.message });
      return false;
    }
  }

  /**
   * Get from hash
   */
  async hget(key, field) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.hGet(key, field);
      return value;
    } catch (error) {
      logger.error('Redis HGET error:', { key, field, error: error.message });
      return null;
    }
  }

  /**
   * Get all fields and values from hash
   */
  async hgetall(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const hash = await this.client.hGetAll(key);
      return hash;
    } catch (error) {
      logger.error('Redis HGETALL error:', { key, error: error.message });
      return {};
    }
  }

  /**
   * Push to list
   */
  async rpush(key, value) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const length = await this.client.rPush(key, value);
      return length;
    } catch (error) {
      logger.error('Redis RPUSH error:', { key, error: error.message });
      return 0;
    }
  }

  /**
   * Pop from list
   */
  async lpop(key) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const value = await this.client.lPop(key);
      return value;
    } catch (error) {
      logger.error('Redis LPOP error:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Get keys by pattern
   */
  async keys(pattern) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const keys = await this.client.keys(pattern);
      return keys;
    } catch (error) {
      logger.error('Redis KEYS error:', { pattern, error: error.message });
      return [];
    }
  }

  /**
   * Publish to channel
   */
  async publish(channel, message) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
      await this.client.publish(channel, messageStr);
      return true;
    } catch (error) {
      logger.error('Redis PUBLISH error:', { channel, error: error.message });
      return false;
    }
  }

  /**
   * Flush database
   */
  async flushdb() {
    try {
      if (!this.isConnected || !this.client) {
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
      if (!this.isConnected || !this.client) {
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
      if (!this.isConnected || !this.client) {
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
   * Execute raw Redis command (for rate-limit-redis compatibility)
   */
  async call(...args) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      // For compatibility with rate-limit-redis
      const command = args[0];
      const commandArgs = args.slice(1);
      
      // Map to appropriate method
      switch (command.toUpperCase()) {
        case 'EVAL':
          return await this.client.eval(commandArgs[0], {
            keys: commandArgs.slice(1, 1 + parseInt(commandArgs[1])),
            arguments: commandArgs.slice(1 + parseInt(commandArgs[1]))
          });
        case 'INCR':
          return await this.client.incr(commandArgs[0]);
        case 'EXPIRE':
          return await this.client.expire(commandArgs[0], commandArgs[1]);
        case 'GET':
          return await this.client.get(commandArgs[0]);
        case 'SET':
          return await this.client.set(commandArgs[0], commandArgs[1], {
            EX: commandArgs[2] || undefined
          });
        default:
          // Fallback to sendCommand if available
          if (this.client.sendCommand) {
            return await this.client.sendCommand(args);
          }
          throw new Error(`Unsupported Redis command: ${command}`);
      }
    } catch (error) {
      logger.error('Redis CALL error:', { args, error: error.message });
      throw error;
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      host: config.redis?.host || 'localhost',
      port: config.redis?.port || 6379,
      attempts: this.connectionAttempts,
      hasPassword: !!(config.redis?.password && config.redis.password.trim() !== '')
    };
  }

  /**
   * Get raw client (for rate-limit-redis compatibility)
   */
  getRawClient() {
    return this.client;
  }
}

// Create singleton instance
const redisClient = new RedisClient();

module.exports = redisClient;