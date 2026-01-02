const winston = require('winston');
const { createLogger, format, transports } = winston;
const { combine, timestamp, printf, colorize, json, errors } = format;
const path = require('path');
const fs = require('fs');
const {
  NODE_ENV = 'development',
  LOG_LEVEL = 'info',
  LOG_DIR = 'logs',
  LOG_RETENTION_DAYS = 30,
  LOG_MAX_SIZE = '10m',
  LOG_MAX_FILES = '30d',
} = process.env;

/**
 * Logger utility for structured logging across the application
 */
class Logger {
  constructor() {
    // Ensure log directory exists
    this._ensureLogDirectory();

    // Define log formats
    this._formats = {
      console: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(({ timestamp, level, message, ...metadata }) => {
          let log = `${timestamp} [${level}]: ${message}`;

          if (Object.keys(metadata).length > 0) {
            // Filter out internal winston metadata
            const filteredMeta = { ...metadata };
            delete filteredMeta.service;
            delete filteredMeta.stack;

            if (Object.keys(filteredMeta).length > 0) {
              log += ` ${JSON.stringify(filteredMeta)}`;
            }
          }

          return log;
        })
      ),
      file: combine(timestamp(), errors({ stack: true }), json()),
    };

    // Create logger instance
    this.logger = createLogger({
      level: LOG_LEVEL.toLowerCase(),
      defaultMeta: {
        service: 'chat-backend',
        environment: NODE_ENV,
      },
      transports: this._getTransports(),
      exceptionHandlers: this._getExceptionHandlers(),
      rejectionHandlers: this._getRejectionHandlers(),
      exitOnError: false, // Don't exit on handled exceptions
    });
  }

  /**
   * Ensure log directory exists
   * @private
   */
  _ensureLogDirectory() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  /**
   * Get appropriate transports based on environment
   * @private
   * @returns {Array} Winston transports
   */
  _getTransports() {
    const transportsList = [];

    // Always log to console
    transportsList.push(
      new transports.Console({
        format: this._formats.console,
        handleExceptions: true,
        handleRejections: true,
      })
    );

    // In production, also log to files
    if (NODE_ENV === 'production') {
      // Combined logs
      transportsList.push(
        new transports.File({
          filename: path.join(LOG_DIR, 'combined.log'),
          format: this._formats.file,
          maxsize: this._parseSize(LOG_MAX_SIZE),
          maxFiles: LOG_MAX_FILES,
          tailable: true,
        })
      );

      // Error logs
      transportsList.push(
        new transports.File({
          filename: path.join(LOG_DIR, 'error.log'),
          level: 'error',
          format: this._formats.file,
          maxsize: this._parseSize(LOG_MAX_SIZE),
          maxFiles: LOG_MAX_FILES,
          tailable: true,
        })
      );

      // HTTP request logs
      transportsList.push(
        new transports.File({
          filename: path.join(LOG_DIR, 'http.log'),
          format: this._formats.file,
          maxsize: this._parseSize(LOG_MAX_SIZE),
          maxFiles: LOG_MAX_FILES,
          tailable: true,
        })
      );
    }

    return transportsList;
  }

  /**
   * Get exception handlers for uncaught exceptions
   * @private
   * @returns {Array} Exception handlers
   */
  _getExceptionHandlers() {
    const handlers = [
      new transports.Console({
        format: combine(
          colorize(),
          timestamp(),
          printf(({ timestamp, level, message, stack }) => {
            return `${timestamp} [${level}]: UNCAUGHT EXCEPTION\n${message}\n${stack}`;
          })
        ),
      }),
    ];

    if (NODE_ENV === 'production') {
      handlers.push(
        new transports.File({
          filename: path.join(LOG_DIR, 'exceptions.log'),
          format: this._formats.file,
          maxsize: this._parseSize(LOG_MAX_SIZE),
          maxFiles: LOG_MAX_FILES,
        })
      );
    }

    return handlers;
  }

  /**
   * Get rejection handlers for unhandled promise rejections
   * @private
   * @returns {Array} Rejection handlers
   */
  _getRejectionHandlers() {
    const handlers = [
      new transports.Console({
        format: combine(
          colorize(),
          timestamp(),
          printf(({ timestamp, level, message, stack }) => {
            return `${timestamp} [${level}]: UNHANDLED REJECTION\n${message}\n${stack}`;
          })
        ),
      }),
    ];

    if (NODE_ENV === 'production') {
      handlers.push(
        new transports.File({
          filename: path.join(LOG_DIR, 'rejections.log'),
          format: this._formats.file,
          maxsize: this._parseSize(LOG_MAX_SIZE),
          maxFiles: LOG_MAX_FILES,
        })
      );
    }

    return handlers;
  }

  /**
   * Parse size string (e.g., '10m', '100k') to bytes
   * @private
   * @param {string} sizeString - Size string
   * @returns {number} Size in bytes
   */
  _parseSize(sizeString) {
    if (!sizeString) return 10 * 1024 * 1024; // Default 10MB

    const units = {
      b: 1,
      k: 1024,
      m: 1024 * 1024,
      g: 1024 * 1024 * 1024,
    };

    const match = sizeString.toLowerCase().match(/^(\d+)([bkmg])?$/);
    if (!match) return 10 * 1024 * 1024;

    const size = parseInt(match[1]);
    const unit = match[2] || 'b';

    return size * (units[unit] || 1);
  }

  /**
   * Log with INFO level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  /**
   * Log with ERROR level
   * @param {string} message - Log message
   * @param {Error|Object} error - Error object or additional metadata
   * @param {Object} meta - Additional metadata
   */
  error(message, error = null, meta = {}) {
    const logMeta = { ...meta };

    if (error instanceof Error) {
      logMeta.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.code && { code: error.code }),
        ...(error.statusCode && { statusCode: error.statusCode }),
      };
    } else if (error && typeof error === 'object') {
      logMeta.error = error;
    }

    this.logger.error(message, logMeta);
  }

  /**
   * Log with WARN level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  /**
   * Log with DEBUG level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  /**
   * Log with VERBOSE level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  verbose(message, meta = {}) {
    this.logger.verbose(message, meta);
  }

  /**
   * Log HTTP request
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {number} responseTime - Response time in milliseconds
   */
  http(req, res, responseTime) {
    const meta = {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      contentLength: res.get('content-length') || 0,
    };

    // Add user ID if authenticated
    if (req.user && req.user._id) {
      meta.userId = req.user._id;
    }

    // Add request ID if available
    if (req.requestId) {
      meta.requestId = req.requestId;
    }

    // Determine log level based on status code
    if (res.statusCode >= 500) {
      this.logger.error(`HTTP ${req.method} ${req.originalUrl}`, meta);
    } else if (res.statusCode >= 400) {
      this.logger.warn(`HTTP ${req.method} ${req.originalUrl}`, meta);
    } else {
      this.logger.info(`HTTP ${req.method} ${req.originalUrl}`, meta);
    }
  }

  /**
   * Log database query
   * @param {string} operation - Database operation (find, insert, update, delete)
   * @param {string} collection - Collection name
   * @param {Object} query - Query object
   * @param {number} duration - Query duration in milliseconds
   * @param {string} status - Query status (success, error)
   * @param {Error} error - Error object if any
   */
  db(operation, collection, query, duration, status = 'success', error = null) {
    const meta = {
      operation,
      collection,
      query: this._sanitizeQuery(query),
      duration: `${duration}ms`,
      status,
    };

    if (error) {
      meta.error = {
        name: error.name,
        message: error.message,
        code: error.code,
      };
    }

    if (status === 'error' || duration > 1000) {
      this.logger.warn(`DB ${operation} on ${collection}`, meta);
    } else {
      this.logger.debug(`DB ${operation} on ${collection}`, meta);
    }
  }

  /**
   * Sanitize query object for logging (remove sensitive data)
   * @private
   * @param {Object} query - Query object
   * @returns {Object} Sanitized query
   */
  _sanitizeQuery(query) {
    if (!query || typeof query !== 'object') return query;

    const sensitiveFields = ['password', 'token', 'secret', 'key', 'authorization', 'cookie'];
    const sanitized = { ...query };

    for (const field of sensitiveFields) {
      if (sanitized[field] !== undefined) {
        sanitized[field] = '[REDACTED]';
      }
    }

    // Recursively sanitize nested objects
    for (const key in sanitized) {
      if (sanitized[key] && typeof sanitized[key] === 'object') {
        sanitized[key] = this._sanitizeQuery(sanitized[key]);
      }
    }

    return sanitized;
  }

  /**
   * Log WebSocket/Socket.IO event
   * @param {string} event - Event name
   * @param {string} socketId - Socket ID
   * @param {string} userId - User ID (if authenticated)
   * @param {Object} data - Event data
   * @param {string} direction - 'in' for incoming, 'out' for outgoing
   */
  socket(event, socketId, userId = null, data = null, direction = 'in') {
    const meta = {
      socketId,
      event,
      direction,
      data: data ? this._sanitizeQuery(data) : null,
    };

    if (userId) {
      meta.userId = userId;
    }

    this.logger.debug(`Socket ${direction === 'in' ? '←' : '→'} ${event}`, meta);
  }

  /**
   * Log authentication event
   * @param {string} event - Authentication event (login, logout, token_refresh)
   * @param {string} userId - User ID
   * @param {boolean} success - Whether authentication was successful
   * @param {Object} meta - Additional metadata
   */
  auth(event, userId, success = true, meta = {}) {
    const authMeta = {
      event,
      userId,
      success,
      ...meta,
    };

    if (success) {
      this.logger.info(`Auth ${event} for user ${userId}`, authMeta);
    } else {
      this.logger.warn(`Auth ${event} failed for user ${userId}`, authMeta);
    }
  }

  /**
   * Log business logic event
   * @param {string} service - Service name
   * @param {string} action - Action name
   * @param {string} entityId - Entity ID
   * @param {Object} meta - Additional metadata
   */
  business(service, action, entityId = null, meta = {}) {
    const businessMeta = {
      service,
      action,
      entityId,
      ...meta,
    };

    this.logger.info(`${service}.${action}`, businessMeta);
  }

  /**
   * Create child logger with additional context
   * @param {Object} context - Additional context metadata
   * @returns {Object} Child logger instance
   */
  child(context = {}) {
    const childLogger = this.logger.child(context);

    return {
      info: (message, meta = {}) => childLogger.info(message, meta),
      error: (message, error = null, meta = {}) => {
        const logMeta = { ...meta };
        if (error instanceof Error) {
          logMeta.error = {
            name: error.name,
            message: error.message,
            stack: error.stack,
          };
        }
        childLogger.error(message, logMeta);
      },
      warn: (message, meta = {}) => childLogger.warn(message, meta),
      debug: (message, meta = {}) => childLogger.debug(message, meta),
      verbose: (message, meta = {}) => childLogger.verbose(message, meta),
      http: (req, res, responseTime) => this.http(req, res, responseTime),
      db: (operation, collection, query, duration, status, error) =>
        this.db(operation, collection, query, duration, status, error),
      socket: (event, socketId, userId, data, direction) =>
        this.socket(event, socketId, userId, data, direction),
      auth: (event, userId, success, meta) => this.auth(event, userId, success, meta),
      business: (service, action, entityId, meta) => this.business(service, action, entityId, meta),
    };
  }

  /**
   * Clean up old log files
   * @returns {Promise<void>}
   */
  async cleanupOldLogs() {
    try {
      const retentionDays = parseInt(LOG_RETENTION_DAYS) || 30;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const files = fs.readdirSync(LOG_DIR);

      for (const file of files) {
        const filePath = path.join(LOG_DIR, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile() && stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          this.info(`Deleted old log file: ${file}`, {
            action: 'log_cleanup',
            file,
            mtime: stats.mtime,
          });
        }
      }
    } catch (error) {
      this.error('Failed to clean up old log files', error);
    }
  }

  /**
   * Get current log level
   * @returns {string} Current log level
   */
  getLevel() {
    return this.logger.level;
  }

  /**
   * Set log level
   * @param {string} level - New log level
   */
  setLevel(level) {
    this.logger.level = level;
    this.info(`Log level changed to: ${level}`);
  }
}

// Create singleton instance
const loggerInstance = new Logger();

// Schedule log cleanup (run daily)
if (NODE_ENV === 'production') {
  setInterval(
    () => {
      loggerInstance.cleanupOldLogs();
    },
    24 * 60 * 60 * 1000
  ); // 24 hours
}

module.exports = loggerInstance;
