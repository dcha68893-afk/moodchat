const redis = require('redis');
const logger = require('./logger');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 10;
    this.initialConnectionAttempted = false;
    
    // Load configuration from environment variables
    this.config = this.loadConfigFromEnv();
    
    // Initialize connection
    this.initialize();
  }

  /**
   * Load Redis configuration from environment variables
   */
  loadConfigFromEnv() {
    return {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || '',
      db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0,
      tls: process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1',
    };
  }

  /**
   * Initialize Redis connection
   */
  async initialize() {
    // Only log initial connection attempt once
    if (!this.initialConnectionAttempted) {
      logger.info('Initializing Redis connection...');
      this.initialConnectionAttempted = true;
    }

    try {
      // Create Redis client configuration
      const clientConfig = {
        socket: {
          host: this.config.host,
          port: this.config.port,
          reconnectStrategy: (retries) => {
            this.connectionAttempts = retries;
            const delay = Math.min(retries * 100, 3000);
            
            // Log reconnection attempts less frequently to avoid spam
            if (retries % 5 === 0 || retries === 1) {
              logger.warn(`Redis reconnecting attempt ${retries}, delay: ${delay}ms`);
            }
            
            return delay;
          },
          // Add TLS configuration if enabled
          ...(this.config.tls ? { tls: true } : {})
        },
        // Only add password if it exists and is not empty
        ...(this.config.password && this.config.password.trim() !== '' 
          ? { password: this.config.password } 
          : {}),
        // Only add database if specified
        ...(this.config.db !== undefined ? { database: this.config.db } : {}),
      };

      // Log connection details (without password)
      logger.info('Creating Redis client with config:', {
        host: clientConfig.socket.host,
        port: clientConfig.socket.port,
        db: clientConfig.database || 0,
        tls: !!clientConfig.socket.tls,
        hasPassword: !!clientConfig.password,
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
      // Only log connection error on first attempt to avoid spam
      if (this.connectionAttempts === 0) {
        logger.warn('Failed to connect to Redis:', {
          error: error.message,
          host: this.config.host,
          port: this.config.port,
        });
        logger.warn('Redis is unavailable. Server will run in fallback mode.');
      }
      
      // Retry connection after delay
      if (this.connectionAttempts < this.maxRetries) {
        const delay = Math.min(this.connectionAttempts * 1000, 5000);
        
        // Log retry attempts less frequently
        if (this.connectionAttempts % 3 === 0) {
          logger.warn(`Retrying Redis connection in ${delay}ms... (Attempt ${this.connectionAttempts + 1}/${this.maxRetries})`);
        }
        
        setTimeout(() => this.initialize(), delay);
      } else if (this.connectionAttempts === this.maxRetries) {
        logger.warn('Max Redis connection retries reached. Redis will not be available.');
        this.logDatabaseTables(); // Still log database tables even if Redis fails
      }
    }
  }

  /**
   * Set up Redis event handlers
   */
  setupEventHandlers() {
    if (!this.client) return;

    // Error handling - log only once per error type
    let lastErrorMessage = '';
    this.client.on('error', (err) => {
      if (err.message !== lastErrorMessage) {
        logger.warn('Redis Client Warning:', { 
          error: err.message, 
          code: err.code,
          attempts: this.connectionAttempts 
        });
        lastErrorMessage = err.message;
      }
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
      this.logDatabaseTables();
    });

    this.client.on('reconnecting', () => {
      if (this.connectionAttempts % 3 === 0) {
        logger.warn('Redis Client Reconnecting...');
      }
      this.isConnected = false;
    });

    this.client.on('end', () => {
      logger.warn('Redis Client Disconnected');
      this.isConnected = false;
    });
  }

  /**
   * Log database tables in a readable format
   */
  async logDatabaseTables() {
    try {
      // This is a placeholder - in a real implementation, you would query your database
      // For example, with PostgreSQL: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      // For MySQL: SHOW TABLES
      
      // Simulating database tables for demonstration
      const databaseTables = [
        { 
          name: 'users', 
          columns: 8,
          foreign_keys: ['roles(id)', 'departments(id)']
        },
        { 
          name: 'products', 
          columns: 12,
          foreign_keys: ['categories(id)', 'suppliers(id)']
        },
        { 
          name: 'orders', 
          columns: 10,
          foreign_keys: ['users(id)', 'products(id)', 'shipping_methods(id)']
        },
        { 
          name: 'categories', 
          columns: 4,
          foreign_keys: []
        },
        { 
          name: 'departments', 
          columns: 5,
          foreign_keys: []
        },
      ];

      logger.info('📊 Database Tables:');
      logger.info('┌────────────────────┬──────────┬─────────────────────────────┐');
      logger.info('│ Table Name         │ Columns  │ Foreign Keys               │');
      logger.info('├────────────────────┼──────────┼─────────────────────────────┤');
      
      databaseTables.forEach(table => {
        const tableName = table.name.padEnd(18);
        const columns = table.columns.toString().padEnd(8);
        const fks = table.foreign_keys.join(', ').substring(0, 27).padEnd(27);
        logger.info(`│ ${tableName} │ ${columns} │ ${fks} │`);
      });
      
      logger.info('└────────────────────┴──────────┴─────────────────────────────┘');
      logger.info(`Total tables: ${databaseTables.length}`);
      
    } catch (error) {
      logger.warn('Unable to retrieve database table information:', error.message);
    }
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
      logger.warn('Redis connection test failed:', error.message);
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
        return null; // Fail gracefully
      }

      const value = await this.client.get(key);
      return value;
    } catch (error) {
      logger.warn('Redis GET warning:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Set value with expiration
   */
  async set(key, value, expireSeconds = null) {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      if (expireSeconds) {
        await this.client.setEx(key, expireSeconds, value);
      } else {
        await this.client.set(key, value);
      }

      return true;
    } catch (error) {
      logger.warn('Redis SET warning:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Delete key
   */
  async del(key) {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      logger.warn('Redis DEL warning:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.warn('Redis EXISTS warning:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Set key with expiration in milliseconds
   */
  async setEx(key, milliseconds, value) {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      await this.client.set(key, value, { PX: milliseconds });
      return true;
    } catch (error) {
      logger.warn('Redis SETEX warning:', { key, error: error.message });
      return false;
    }
  }

  /**
   * Get time to live for key
   */
  async ttl(key) {
    try {
      if (!this.isConnected || !this.client) {
        return -2; // Fail gracefully - key doesn't exist
      }

      const ttl = await this.client.ttl(key);
      return ttl;
    } catch (error) {
      logger.warn('Redis TTL warning:', { key, error: error.message });
      return -2;
    }
  }

  /**
   * Increment value
   */
  async incr(key) {
    try {
      if (!this.isConnected || !this.client) {
        return null; // Fail gracefully
      }

      const value = await this.client.incr(key);
      return value;
    } catch (error) {
      logger.warn('Redis INCR warning:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Decrement value
   */
  async decr(key) {
    try {
      if (!this.isConnected || !this.client) {
        return null; // Fail gracefully
      }

      const value = await this.client.decr(key);
      return value;
    } catch (error) {
      logger.warn('Redis DECR warning:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Add to hash
   */
  async hset(key, field, value) {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      await this.client.hSet(key, field, value);
      return true;
    } catch (error) {
      logger.warn('Redis HSET warning:', { key, field, error: error.message });
      return false;
    }
  }

  /**
   * Get from hash
   */
  async hget(key, field) {
    try {
      if (!this.isConnected || !this.client) {
        return null; // Fail gracefully
      }

      const value = await this.client.hGet(key, field);
      return value;
    } catch (error) {
      logger.warn('Redis HGET warning:', { key, field, error: error.message });
      return null;
    }
  }

  /**
   * Get all fields and values from hash
   */
  async hgetall(key) {
    try {
      if (!this.isConnected || !this.client) {
        return {}; // Fail gracefully
      }

      const hash = await this.client.hGetAll(key);
      return hash;
    } catch (error) {
      logger.warn('Redis HGETALL warning:', { key, error: error.message });
      return {};
    }
  }

  /**
   * Push to list
   */
  async rpush(key, value) {
    try {
      if (!this.isConnected || !this.client) {
        return 0; // Fail gracefully
      }

      const length = await this.client.rPush(key, value);
      return length;
    } catch (error) {
      logger.warn('Redis RPUSH warning:', { key, error: error.message });
      return 0;
    }
  }

  /**
   * Pop from list
   */
  async lpop(key) {
    try {
      if (!this.isConnected || !this.client) {
        return null; // Fail gracefully
      }

      const value = await this.client.lPop(key);
      return value;
    } catch (error) {
      logger.warn('Redis LPOP warning:', { key, error: error.message });
      return null;
    }
  }

  /**
   * Get keys by pattern
   */
  async keys(pattern) {
    try {
      if (!this.isConnected || !this.client) {
        return []; // Fail gracefully
      }

      const keys = await this.client.keys(pattern);
      return keys;
    } catch (error) {
      logger.warn('Redis KEYS warning:', { pattern, error: error.message });
      return [];
    }
  }

  /**
   * Publish to channel
   */
  async publish(channel, message) {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
      await this.client.publish(channel, messageStr);
      return true;
    } catch (error) {
      logger.warn('Redis PUBLISH warning:', { channel, error: error.message });
      return false;
    }
  }

  /**
   * Flush database
   */
  async flushdb() {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      await this.client.flushDb();
      logger.info('Redis database flushed');
      return true;
    } catch (error) {
      logger.warn('Redis FLUSHDB warning:', error.message);
      return false;
    }
  }

  /**
   * Get Redis info
   */
  async info() {
    try {
      if (!this.isConnected || !this.client) {
        return null; // Fail gracefully
      }

      const info = await this.client.info();
      return info;
    } catch (error) {
      logger.warn('Redis INFO warning:', error.message);
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
      logger.warn('Redis QUIT warning:', error.message);
      return false;
    }
  }

  /**
   * Ping Redis server
   */
  async ping() {
    try {
      if (!this.isConnected || !this.client) {
        return false; // Fail gracefully
      }

      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.warn('Redis PING warning:', error.message);
      return false;
    }
  }

  /**
   * Execute raw Redis command
   */
  async call(...args) {
    try {
      if (!this.isConnected || !this.client) {
        throw new Error('Redis client not connected');
      }

      const command = args[0];
      const commandArgs = args.slice(1);
      
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
          if (this.client.sendCommand) {
            return await this.client.sendCommand(args);
          }
          throw new Error(`Unsupported Redis command: ${command}`);
      }
    } catch (error) {
      logger.warn('Redis CALL warning:', { args, error: error.message });
      throw error; // Re-throw for rate-limit-redis compatibility
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      host: this.config.host,
      port: this.config.port,
      db: this.config.db,
      tls: this.config.tls,
      attempts: this.connectionAttempts,
      hasPassword: !!(this.config.password && this.config.password.trim() !== '')
    };
  }

  /**
   * Get raw client
   */
  getRawClient() {
    return this.client;
  }
}

// Create singleton instance
const redisClient = new RedisClient();

module.exports = redisClient;